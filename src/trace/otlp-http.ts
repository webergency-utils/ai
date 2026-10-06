import { AIError } from '../core/error.js';
import type { Trace, TraceWarningEvent } from './types.js';
import type { TraceCollector } from './collector.js';
import { exportTracesToOTLP, type OTLPExportOptions } from './exporter.js';
import { assertCaptureConfig, type ContentCaptureOptions } from './genai.js';
import { assertSamplingOptions, createSampler, type TraceSamplingOptions } from './sampling.js';

export const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';

/** HTTP statuses that OTLP/HTTP clients retry (OTLP spec: 429/502/503/504; plus 408 request timeout). */
const RETRYABLE_STATUS = new Set( [ 408, 429, 502, 503, 504 ] );

export type OTLPFetch = ( url: string, init: { method: string, headers: Record<string, string>, body: string, signal: AbortSignal } ) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'text'>>;

export interface OTLPHttpExporterOptions extends ContentCaptureOptions, TraceSamplingOptions
{
    /** Full traces URL. Default `http://localhost:4318/v1/traces`. */
    endpoint?            : string
    /** Extra request headers (auth, tenant). Never attached to spans or logged. */
    headers?             : Record<string, string>
    /** Per-request timeout and shutdown flush bound. Default 10 000 ms. */
    timeoutMs?           : number
    serviceName?         : string
    serviceVersion?      : string
    resourceAttributes?  : OTLPExportOptions['resourceAttributes']
    /** `genai` renames spans to `chat {model}` / `execute_tool {tool}` / `invoke_agent {agent}` in the export only. Default `native`. */
    spanNameStyle?       : OTLPExportOptions['spanNameStyle']
    /** `latest` (default), `legacy` (`gen_ai.system`, `prompt_tokens`) or `both`. */
    genaiCompat?         : OTLPExportOptions['genaiCompat']
    /** Injectable `fetch`; defaults to the global one. */
    fetch?               : OTLPFetch
    /** Traces per POST. Default 32. */
    maxBatchTraces?      : number
    /** Max wait before a partial batch is sent. Default 5 000 ms. */
    scheduleDelayMs?     : number
    /** Queue bound; overflow drops the oldest trace. Default 2 048. */
    maxQueueTraces?      : number
    /** Retries after the first attempt. Default 3. */
    maxRetries?          : number
    /** First retry delay before jitter. Default 500 ms. */
    retryBaseDelayMs?    : number
    /** Upper bound for any retry delay, including `Retry-After`. Default 30 000 ms. */
    maxRetryDelayMs?     : number
    /** Jitter source in [0, 1); injectable for tests. */
    random?              : () => number
    /** Delay implementation; injectable for tests. Must reject with the abort reason when `signal` aborts. */
    sleep?               : ( ms: number, signal: AbortSignal ) => Promise<void>
    /** Clock for unfinished-span closing; injectable for tests. */
    now?                 : () => number
    /** Failure channel for standalone use (`export()` without an attached collector). Always called in addition to collector `warning` events. */
    onError?             : ( event: TraceWarningEvent ) => void
}

export interface OTLPHttpExporterStats
{
    queued          : number
    exportedTraces  : number
    exportedBatches : number
    failedTraces    : number
    failedBatches   : number
    droppedTraces   : number
    /** Traces skipped by `sampler` / `sampleRate`. */
    sampledOut      : number
    retries         : number
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) to milliseconds. */
export function parseRetryAfter( value: string | null | undefined, nowMs: number = Date.now() ): number | undefined
{
    if( value === null || value === undefined || value.trim() === '' )
    {
        return undefined;
    }

    const seconds = Number( value );

    if( Number.isFinite( seconds ) && seconds >= 0 )
    {
        return seconds * 1000;
    }

    const date = Date.parse( value );

    if( !Number.isNaN( date ) )
    {
        return Math.max( 0, date - nowMs );
    }

    return undefined;
}

function positive( name: string, value: number | undefined, fallback: number, allowZero = false ): number
{
    if( value === undefined )
    {
        return fallback;
    }

    if( !Number.isFinite( value ) || ( allowZero ? value < 0 : value <= 0 ) )
    {
        throw new AIError( `OTLPHttpExporter option '${name}' must be a ${allowZero ? 'non-negative' : 'positive'} finite number`, 'TRACE_EXPORTER_CONFIG' );
    }

    return value;
}

function defaultSleep( ms: number, signal: AbortSignal ): Promise<void>
{
    return new Promise( ( resolve, reject ) => 
    {
        if( signal.aborted )
        {
            reject( signal.reason );

            return;
        }

        const onAbort = (): void => 
        {
            clearTimeout( timer );
            reject( signal.reason );
        };

        const timer = setTimeout( () => 
        {
            signal.removeEventListener( 'abort', onAbort );
            resolve();
        }, ms );

        timer.unref?.();
        signal.addEventListener( 'abort', onAbort, { once : true } );
    } );
}

class SendAbortedError extends Error {}

/**
 * Ships completed traces to any OTLP/HTTP backend (Langfuse, Phoenix, Jaeger, Tempo, Datadog, Honeycomb).
 *
 * It subscribes to `TraceCollector` `trace:complete`; the span model is untouched. Export never throws into
 * application code: failures become collector `warning` events (`TRACE_EXPORT_FAILED`, `TRACE_EXPORT_DROPPED`)
 * and are counted in {@link OTLPHttpExporter.stats}. Timers are `unref()`ed so the exporter never keeps the process alive.
 */
export class OTLPHttpExporter
{
    readonly #endpoint            : string;
    readonly #headers             : Record<string, string>;
    readonly #timeoutMs           : number;
    readonly #fetch               : OTLPFetch;
    readonly #maxBatchTraces      : number;
    readonly #scheduleDelayMs     : number;
    readonly #maxQueueTraces      : number;
    readonly #maxRetries          : number;
    readonly #retryBaseDelayMs    : number;
    readonly #maxRetryDelayMs     : number;
    readonly #random              : () => number;
    readonly #sleep               : ( ms: number, signal: AbortSignal ) => Promise<void>;
    readonly #now                 : () => number;
    readonly #onError?            : ( event: TraceWarningEvent ) => void;
    readonly #encodeOptions       : OTLPExportOptions;
    readonly #sample              : ( trace: Trace ) => boolean;
    readonly #collectors          = new Map<TraceCollector, () => void>();
    readonly #abort               = new AbortController();
    readonly #stats               = { exportedTraces : 0, exportedBatches : 0, failedTraces : 0, failedBatches : 0, droppedTraces : 0, sampledOut : 0, retries : 0 };

    #queue: Array<{ trace: Trace, collector?: TraceCollector }> = [];
    #timer?: ReturnType<typeof setTimeout>;
    #draining?: Promise<void>;
    #pendingDropped = 0;
    #dropWarningScheduled = false;
    #shutdown?: Promise<void>;

    constructor( options: OTLPHttpExporterOptions = {} )
    {
        assertCaptureConfig( options, 'OTLPHttpExporter' );
        assertSamplingOptions( options, 'OTLPHttpExporter' );

        this.#endpoint = options.endpoint ?? DEFAULT_OTLP_ENDPOINT;
        this.#headers = { ...( options.headers ?? {} ) };
        this.#timeoutMs = positive( 'timeoutMs', options.timeoutMs, 10_000 );
        this.#maxBatchTraces = Math.floor( positive( 'maxBatchTraces', options.maxBatchTraces, 32 ) );
        this.#scheduleDelayMs = positive( 'scheduleDelayMs', options.scheduleDelayMs, 5_000, true );
        this.#maxQueueTraces = Math.floor( positive( 'maxQueueTraces', options.maxQueueTraces, 2048 ) );
        this.#maxRetries = Math.floor( positive( 'maxRetries', options.maxRetries, 3, true ) );
        this.#retryBaseDelayMs = positive( 'retryBaseDelayMs', options.retryBaseDelayMs, 500, true );
        this.#maxRetryDelayMs = positive( 'maxRetryDelayMs', options.maxRetryDelayMs, 30_000, true );
        this.#random = options.random ?? Math.random;
        this.#sleep = options.sleep ?? defaultSleep;
        this.#now = options.now ?? Date.now;
        this.#onError = options.onError;
        this.#sample = createSampler( options, ( error ) => 
        {
            this.#emit( 
                {
                    code    : 'TRACE_SAMPLER_FAILED',
                    message : `Custom sampler threw; keeping the trace: ${error instanceof Error ? error.message : String( error )}`
                } );
        } );

        const fetchImpl = options.fetch ?? ( globalThis.fetch ? globalThis.fetch.bind( globalThis ) as unknown as OTLPFetch : undefined );

        if( !fetchImpl )
        {
            throw new AIError( 'OTLPHttpExporter needs a global fetch (Node 18+) or an injected `fetch` option', 'TRACE_EXPORTER_CONFIG' );
        }

        this.#fetch = fetchImpl;
        this.#encodeOptions = 
            {
                serviceName        : options.serviceName,
                serviceVersion     : options.serviceVersion,
                resourceAttributes : options.resourceAttributes,
                spanNameStyle      : options.spanNameStyle,
                genaiCompat        : options.genaiCompat,
                captureContent     : options.captureContent,
                redact             : options.redact,
                maxContentBytes    : options.maxContentBytes,
                now                : this.#now
            };
    }

    public get stats(): OTLPHttpExporterStats
    {
        return { ...this.#stats, queued : this.#queue.length };
    }

    /** Subscribes to `trace:complete`. Returns an idempotent detach function; attaching twice is a no-op. */
    public attach( collector: TraceCollector ): () => void
    {
        if( this.#shutdown )
        {
            throw new AIError( 'OTLPHttpExporter is shut down', 'TRACE_EXPORTER_SHUTDOWN' );
        }

        const existing = this.#collectors.get( collector );

        if( existing )
        {
            return existing;
        }

        const listener = ( trace: Trace ): void => 
        {
            this.#accept( trace, collector );
        };

        collector.on( 'trace:complete', listener );

        const detach = (): void => 
        {
            collector.off( 'trace:complete', listener );
            this.#collectors.delete( collector );
        };

        this.#collectors.set( collector, detach );

        return detach;
    }

    /** Queues one trace and resolves once everything queued so far is sent or has failed. Rejects only after shutdown. */
    public async export( trace: Trace ): Promise<void>
    {
        if( this.#shutdown )
        {
            throw new AIError( 'OTLPHttpExporter is shut down', 'TRACE_EXPORTER_SHUTDOWN' );
        }

        this.#accept( trace );
        await this.forceFlush();
    }

    /** Sends everything queued; resolves when all batches were sent or failed. Never rejects. */
    public async forceFlush(): Promise<void>
    {
        this.#clearTimer();
        this.#kick();

        while( this.#draining )
        {
            await this.#draining;
        }
    }

    /** Detaches from collectors, flushes (bounded by `timeoutMs`), and rejects later `export` calls. Idempotent. */
    public shutdown(): Promise<void>
    {
        this.#shutdown ??= this.#doShutdown();

        return this.#shutdown;
    }

    async #doShutdown(): Promise<void>
    {
        for( const detach of [ ...this.#collectors.values() ] )
        {
            detach();
        }

        this.#clearTimer();

        let bound: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<true>( ( resolve ) => 
        {
            bound = setTimeout( () => {resolve( true );}, this.#timeoutMs );
            bound.unref?.();
        } );

        const timedOutFlush = await Promise.race( [ this.forceFlush().then( () => {return false;} ), timedOut ] );

        clearTimeout( bound );

        if( timedOutFlush )
        {
            const abandoned = this.#queue.length;

            this.#queue = [];
            this.#abort.abort( new SendAbortedError( 'exporter shutdown' ) );
            this.#stats.droppedTraces += abandoned;
            this.#emit( 
                {
                    code    : 'TRACE_EXPORT_DROPPED',
                    message : `Shutdown flush exceeded ${this.#timeoutMs}ms; abandoned ${abandoned} queued trace(s) and aborted in-flight export`,
                    details : { dropped : abandoned, reason : 'shutdown_timeout' }
                } );

            if( this.#draining )
            {
                await this.#draining;
            }
        }
    }

    #accept( trace: Trace, collector?: TraceCollector ): void
    {
        if( this.#shutdown )
        {
            return;
        }

        if( !this.#sample( trace ) )
        {
            this.#stats.sampledOut++;

            return;
        }

        while( this.#queue.length >= this.#maxQueueTraces )
        {
            this.#queue.shift();
            this.#stats.droppedTraces++;
            this.#pendingDropped++;
        }

        if( this.#pendingDropped > 0 )
        {
            this.#scheduleDropWarning();
        }

        this.#queue.push( { trace, collector } );

        if( this.#queue.length >= this.#maxBatchTraces )
        {
            this.#clearTimer();
            this.#kick();
        }
        else if( !this.#timer )
        {
            this.#timer = setTimeout( () => 
            {
                this.#timer = undefined;
                this.#kick();
            }, this.#scheduleDelayMs );
            this.#timer.unref?.();
        }
    }

    /** Overflow warnings are coalesced per tick so a burst reports one `dropped` count. */
    #scheduleDropWarning(): void
    {
        if( this.#dropWarningScheduled )
        {
            return;
        }

        this.#dropWarningScheduled = true;
        queueMicrotask( () => 
        {
            this.#dropWarningScheduled = false;

            const dropped = this.#pendingDropped;

            this.#pendingDropped = 0;

            if( dropped > 0 )
            {
                this.#emit( 
                    {
                        code    : 'TRACE_EXPORT_DROPPED',
                        message : `Export queue full (maxQueueTraces=${this.#maxQueueTraces}); dropped ${dropped} oldest trace(s)`,
                        details : { dropped, totalDropped : this.#stats.droppedTraces, reason : 'queue_overflow' }
                    } );
            }
        } );
    }

    #clearTimer(): void
    {
        if( this.#timer )
        {
            clearTimeout( this.#timer );
            this.#timer = undefined;
        }
    }

    #kick(): void
    {
        if( this.#draining || this.#queue.length === 0 )
        {
            return;
        }

        this.#draining = this.#drain().finally( () => 
        {
            this.#draining = undefined;

            // Traces accepted while the final batch was in flight must not wait for the next trace.
            if( this.#queue.length >= this.#maxBatchTraces )
            {
                this.#kick();
            }
        } );
    }

    /** Single sender: batches go out one at a time, in order. */
    async #drain(): Promise<void>
    {
        while( this.#queue.length > 0 )
        {
            const batch = this.#queue.splice( 0, this.#maxBatchTraces );

            await this.#sendBatch( batch );
        }
    }

    async #sendBatch( batch: Array<{ trace: Trace, collector?: TraceCollector }> ): Promise<void>
    {
        const collector = batch.find( ( item ) => {return item.collector;} )?.collector;
        let body: string;

        try
        {
            body = JSON.stringify( exportTracesToOTLP( 
                batch.map( ( item ) => {return item.trace;} ), 
                { ...this.#encodeOptions, onWarning : ( event ) => {this.#emit( event, collector );} } 
            ) );
        }
        catch( error )
        {
            this.#fail( batch, collector, { error : error instanceof Error ? error.message : String( error ), attempts : 0 } );

            return;
        }

        let lastStatus: number | undefined;
        let lastError: string | undefined;
        let attempts = 0;

        for( let attempt = 0; attempt <= this.#maxRetries; attempt++ )
        {
            attempts++;

            let retryAfterMs: number | undefined;

            try
            {
                const response = await this.#post( body );

                if( response.ok )
                {
                    this.#stats.exportedTraces += batch.length;
                    this.#stats.exportedBatches++;
                    await this.#inspectSuccess( response, collector );

                    return;
                }

                lastStatus = response.status;
                lastError = await this.#readError( response );
                retryAfterMs = parseRetryAfter( response.headers?.get( 'retry-after' ), this.#now() );

                if( !RETRYABLE_STATUS.has( response.status ) )
                {
                    break;
                }
            }
            catch( error )
            {
                if( this.#abort.signal.aborted )
                {
                    lastError = 'aborted by shutdown';
                    break;
                }

                lastStatus = undefined;
                lastError = error instanceof Error ? error.message : String( error );
            }

            if( attempt === this.#maxRetries )
            {
                break;
            }

            const backoff = Math.min( this.#maxRetryDelayMs, this.#retryBaseDelayMs * ( 2 ** attempt ) ) * ( 0.5 + 0.5 * this.#random() );
            const delay = Math.min( this.#maxRetryDelayMs, retryAfterMs ?? backoff );

            this.#stats.retries++;

            try
            {
                await this.#sleep( delay, this.#abort.signal );
            }
            catch
            {
                lastError = 'aborted by shutdown';
                break;
            }
        }

        this.#fail( batch, collector, { status : lastStatus, error : lastError, attempts } );
    }

    async #post( body: string ): ReturnType<OTLPFetch>
    {
        const controller = new AbortController();
        const onShutdown = (): void => 
        {
            controller.abort( this.#abort.signal.reason );
        };

        if( this.#abort.signal.aborted )
        {
            onShutdown();
        }
        else
        {
            this.#abort.signal.addEventListener( 'abort', onShutdown, { once : true } );
        }

        const timer = setTimeout( () => 
        {
            controller.abort( new Error( `OTLP export timed out after ${this.#timeoutMs}ms` ) );
        }, this.#timeoutMs );

        timer.unref?.();

        try
        {
            const request = this.#fetch( this.#endpoint, 
                {
                    method  : 'POST',
                    headers : { ...this.#headers, 'content-type' : 'application/json' },
                    body,
                    signal  : controller.signal
                } );

            // A fetch that ignores the signal must still not block the sender past the timeout.
            const aborted = new Promise<never>( ( _, reject ) => 
            {
                controller.signal.addEventListener( 'abort', () => {reject( controller.signal.reason );}, { once : true } );
            } );

            return await Promise.race( [ request, aborted ] );
        }
        finally
        {
            clearTimeout( timer );
            this.#abort.signal.removeEventListener( 'abort', onShutdown );
        }
    }

    async #readError( response: Pick<Response, 'text'> ): Promise<string | undefined>
    {
        try
        {
            const text = await response.text();

            return text ? text.slice( 0, 200 ) : undefined;
        }
        catch
        {
            return undefined;
        }
    }

    /** A 200 can still reject spans (OTLP `partialSuccess`); surface that instead of hiding it. */
    async #inspectSuccess( response: Pick<Response, 'text'>, collector?: TraceCollector ): Promise<void>
    {
        let text: string | undefined;

        try
        {
            text = typeof response.text === 'function' ? await response.text() : undefined;
        }
        catch
        {
            return;
        }

        if( !text )
        {
            return;
        }

        try
        {
            const parsed = JSON.parse( text ) as { partialSuccess? : { rejectedSpans? : number | string, errorMessage? : string } };
            const rejected = Number( parsed.partialSuccess?.rejectedSpans ?? 0 );

            if( rejected > 0 )
            {
                this.#emit( 
                    {
                        code    : 'TRACE_EXPORT_PARTIAL',
                        message : `Backend rejected ${rejected} span(s): ${parsed.partialSuccess?.errorMessage ?? 'no reason given'}`,
                        details : { rejectedSpans : rejected }
                    }, collector );
            }
        }
        catch
        {
            // Non-JSON success bodies are fine.
        }
    }

    #fail( batch: Array<{ trace: Trace }>, collector: TraceCollector | undefined, info: { status?: number, error?: string, attempts: number } ): void
    {
        this.#stats.failedBatches++;
        this.#stats.failedTraces += batch.length;
        this.#emit( 
            {
                code    : 'TRACE_EXPORT_FAILED',
                message : `OTLP export of ${batch.length} trace(s) to ${this.#safeEndpoint()} failed${info.status !== undefined ? ` with HTTP ${info.status}` : ''}${info.error ? `: ${info.error}` : ''}`,
                details : { status : info.status, error : info.error, attempts : info.attempts, traces : batch.length, traceIds : batch.map( ( item ) => {return item.trace.traceId;} ) }
            }, collector );
    }

    /** Endpoint without userinfo or query string, so credentials embedded in URLs never reach warnings. */
    #safeEndpoint(): string
    {
        try
        {
            const url = new URL( this.#endpoint );

            return `${url.origin}${url.pathname}`;
        }
        catch
        {
            return 'invalid endpoint';
        }
    }

    #emit( event: TraceWarningEvent, collector?: TraceCollector ): void
    {
        const targets = collector ? [ collector ] : [ ...this.#collectors.keys() ];

        for( const target of targets )
        {
            try
            {
                target.emit( 'warning', event );
            }
            catch
            {
                // A throwing warning listener must not break the exporter.
            }
        }

        try
        {
            this.#onError?.( event );
        }
        catch
        {
            // Same: the failure channel never throws into the sender.
        }
    }
}
