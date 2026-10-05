import type { ModelProtocol } from '../core/protocol.js';
import type { ModelConfig, ModelRequest, ModelResponse, ModelStreamChunk } from '../core/types.js';
import { 
    CancelledError, 
    ProviderError, 
    QuotaExceededError, 
    RateLimitError, 
    TimeoutError 
} from '../core/error.js';

export type RequestAttemptInfo =
    {
        attempt     : number
        maxAttempts : number
        error?      : unknown
        delayMs?    : number
    }

export type TransportRequestOptions =
    {
        url     : string
        init    : RequestInit
        /** When true, do not retry after a successful HTTP response (stream body started). */
        stream? : boolean
        signal? : AbortSignal
        timeoutMs?     : number
        idleTimeoutMs? : number
        maxRetries?    : number
        onAttempt?     : ( info: RequestAttemptInfo ) => void
    }

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 60_000;

const QUOTA_CODES = new Set( [
    'insufficient_quota',
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded'
] );

export function parseRetryAfterMs( 
    headers: Headers, 
    nowMs: number = Date.now() 
): number | undefined
{
    const msHeader = headers.get( 'retry-after-ms' );

    if( msHeader !== null )
    {
        const ms = Number( msHeader );

        if( Number.isFinite( ms ) && ms >= 0 )
        {
            return ms;
        }
    }

    const header = headers.get( 'retry-after' );

    if( header === null || header === '' )
    {
        return undefined;
    }

    const asSeconds = Number( header );

    if( Number.isFinite( asSeconds ) && asSeconds >= 0 )
    {
        return asSeconds * 1000;
    }

    const asDate = Date.parse( header );

    if( !Number.isNaN( asDate ) )
    {
        const dateHeader = headers.get( 'date' );
        const base = dateHeader ? Date.parse( dateHeader ) : nowMs;
        const baseMs = Number.isNaN( base ) ? nowMs : base;

        return Math.max( 0, asDate - baseMs );
    }

    return undefined;
}

export function computeBackoffMs( attemptIndex: number ): number
{
    // attemptIndex is 0-based for the first retry after the initial attempt.
    const base = Math.min( 0.5 * ( 2 ** attemptIndex ), 8 ) * 1000;
    const jitter = 1 - Math.random() * 0.25;

    return Math.round( base * jitter );
}

function isAbortError( error: unknown ): boolean
{
    if( error instanceof CancelledError )
    {
        return true;
    }

    if( error instanceof Error && error.name === 'AbortError' )
    {
        return true;
    }

    if( typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError' )
    {
        return true;
    }

    return false;
}

function isTimeoutAbort( signal: AbortSignal | undefined, error: unknown ): boolean
{
    if( !isAbortError( error ) )
    {
        return false;
    }

    const reason = signal?.reason;

    return reason instanceof TimeoutError 
        || ( typeof DOMException !== 'undefined' 
            && reason instanceof DOMException 
            && reason.name === 'TimeoutError' );
}

export abstract class BaseProviderAdapter implements ModelProtocol
{
    public readonly provider : string;
    public readonly model    : string;
    readonly #config         : ModelConfig;

    constructor( config: ModelConfig )
    {
        this.provider = config.provider;
        this.model = config.model;
        this.#config = config;
    }

    public get config(): ModelConfig
    {
        return this.#config;
    }

    public abstract generate( request: ModelRequest ): Promise<ModelResponse>;
    public abstract stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>;

    protected getApiKey( envVar?: string ): string
    {
        if( this.#config.apiKey )
        {
            return this.#config.apiKey;
        }

        const resolved = envVar 
            ?? ( this.#config.apiKeyEnvVar as string | undefined );

        if( resolved && typeof process !== 'undefined' && process.env && process.env[resolved] )
        {
            return process.env[resolved]!;
        }

        return '';
    }

    /**
     * Shared transport: signal composition, per-attempt timeout, retries, retry-after.
     * Streaming responses are never retried after headers arrive.
     */
    protected async request( options: TransportRequestOptions ): Promise<Response>
    {
        const maxRetries = options.maxRetries 
            ?? this.#config.maxRetries 
            ?? DEFAULT_MAX_RETRIES;
        const maxAttempts = Math.max( 1, maxRetries + 1 );
        const timeoutMs = options.timeoutMs ?? this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const callerSignal = options.signal;
        let lastError: unknown;

        for( let attempt = 1; attempt <= maxAttempts; attempt++ )
        {
            if( callerSignal?.aborted )
            {
                throw new CancelledError( 'Operation cancelled', callerSignal.reason );
            }

            if( attempt > 1 )
            {
                options.onAttempt?.( {
                    attempt,
                    maxAttempts,
                    error   : lastError,
                    delayMs : undefined
                } );
            }

            const attemptController = new AbortController();
            const timeoutError = new TimeoutError( 
                `Request timed out after ${timeoutMs}ms`, 
                'total', 
                timeoutMs, 
                attempt 
            );
            const timeoutId = setTimeout( () => 
            {
                attemptController.abort( timeoutError );
            }, timeoutMs );

            const onCallerAbort = (): void => 
            {
                attemptController.abort( callerSignal?.reason );
            };

            callerSignal?.addEventListener( 'abort', onCallerAbort, { once : true } );

            try
            {
                const response = await fetch( options.url, {
                    ...options.init,
                    signal : attemptController.signal
                } );

                clearTimeout( timeoutId );
                callerSignal?.removeEventListener( 'abort', onCallerAbort );

                if( response.ok )
                {
                    if( options.stream && response.body )
                    {
                        const idleMs = options.idleTimeoutMs 
                            ?? this.#config.idleTimeoutMs 
                            ?? DEFAULT_IDLE_TIMEOUT_MS;

                        if( idleMs > 0 )
                        {
                            return new Response( 
                                this.#withIdleTimeout( response.body, idleMs, callerSignal ), 
                                response 
                            );
                        }
                    }

                    return response;
                }

                // Do not retry after a streamed body has begun.
                if( options.stream && response.body )
                {
                    await this.handleErrorResponse( response );
                }

                const classified = await this.#classifyErrorResponse( response );

                if( !this.#shouldRetry( classified, attempt, maxAttempts ) )
                {
                    throw classified;
                }

                lastError = classified;
                const delayMs = this.#retryDelayMs( classified, attempt - 1 );

                if( delayMs === null )
                {
                    throw classified;
                }

                options.onAttempt?.( {
                    attempt : attempt + 1,
                    maxAttempts,
                    error   : classified,
                    delayMs
                } );

                await this.#sleep( delayMs, callerSignal );
            }
            catch( error )
            {
                clearTimeout( timeoutId );
                callerSignal?.removeEventListener( 'abort', onCallerAbort );

                if( error instanceof RateLimitError 
                    || error instanceof QuotaExceededError 
                    || error instanceof ProviderError 
                    || error instanceof TimeoutError 
                    || error instanceof CancelledError )
                {
                    if( error instanceof CancelledError || ( isAbortError( error ) && !isTimeoutAbort( attemptController.signal, error ) && callerSignal?.aborted ) )
                    {
                        throw error instanceof CancelledError 
                            ? error 
                            : new CancelledError( 'Operation cancelled', callerSignal?.reason ?? error );
                    }

                    if( !this.#shouldRetry( error, attempt, maxAttempts ) )
                    {
                        throw error;
                    }

                    lastError = error;
                    const delayMs = this.#retryDelayMs( error, attempt - 1 );

                    if( delayMs === null )
                    {
                        throw error;
                    }

                    options.onAttempt?.( {
                        attempt : attempt + 1,
                        maxAttempts,
                        error,
                        delayMs
                    } );

                    await this.#sleep( delayMs, callerSignal );
                    continue;
                }

                if( isAbortError( error ) )
                {
                    if( callerSignal?.aborted && !isTimeoutAbort( attemptController.signal, error ) )
                    {
                        throw new CancelledError( 'Operation cancelled', callerSignal.reason );
                    }

                    if( isTimeoutAbort( attemptController.signal, error ) || attemptController.signal.reason instanceof TimeoutError )
                    {
                        const timeout = attemptController.signal.reason instanceof TimeoutError 
                            ? attemptController.signal.reason 
                            : timeoutError;

                        if( !this.#shouldRetry( timeout, attempt, maxAttempts ) )
                        {
                            throw timeout;
                        }

                        lastError = timeout;
                        const delayMs = computeBackoffMs( attempt - 1 );
                        options.onAttempt?.( {
                            attempt : attempt + 1,
                            maxAttempts,
                            error   : timeout,
                            delayMs
                        } );
                        await this.#sleep( delayMs, callerSignal );
                        continue;
                    }

                    throw new CancelledError( 'Operation cancelled', error );
                }

                // Network errors before headers — retry.
                if( attempt < maxAttempts )
                {
                    lastError = error;
                    const delayMs = computeBackoffMs( attempt - 1 );
                    options.onAttempt?.( {
                        attempt : attempt + 1,
                        maxAttempts,
                        error,
                        delayMs
                    } );
                    await this.#sleep( delayMs, callerSignal );
                    continue;
                }

                throw error;
            }
        }

        throw lastError instanceof Error 
            ? lastError 
            : new ProviderError( this.provider, 'Request failed after retries', 500, lastError );
    }

    protected resolveTransportOptions( request: ModelRequest ): Pick<
        TransportRequestOptions, 
        'signal' | 'timeoutMs' | 'idleTimeoutMs' | 'maxRetries' | 'onAttempt'
    >
    {
        const retry = request.retry;

        return {
            signal        : request.signal,
            timeoutMs     : request.timeoutMs ?? this.#config.timeoutMs,
            idleTimeoutMs : request.idleTimeoutMs ?? this.#config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
            maxRetries    : retry === false 
                ? 0 
                : ( retry?.maxRetries ?? this.#config.maxRetries ),
            onAttempt : request.onAttempt
        };
    }

    protected async handleErrorResponse( response: Response ): Promise<never>
    {
        throw await this.#classifyErrorResponse( response );
    }

    async #classifyErrorResponse( response: Response ): Promise<Error>
    {
        let details: unknown;
        let errorMessage = `HTTP ${response.status} ${response.statusText}`;
        let errorCode: string | undefined;

        try
        {
            const text = await response.text();
            details = JSON.parse( text );

            if( details && typeof details === 'object' )
            {
                const record = details as Record<string, unknown>;
                const errorObj = ( record.error as Record<string, unknown> | undefined ) ?? record;
                errorMessage = ( errorObj.message as string | undefined ) ?? errorMessage;
                errorCode = ( errorObj.code as string | undefined ) 
                    ?? ( errorObj.type as string | undefined );
            }
        }
        catch
        {
            // Non-JSON response
        }

        if( response.status === 429 )
        {
            if( errorCode && QUOTA_CODES.has( errorCode ) )
            {
                return new QuotaExceededError( this.provider, errorMessage, details );
            }

            const retryAfterMs = parseRetryAfterMs( response.headers );
            const retryAfterSeconds = retryAfterMs !== undefined 
                ? Math.ceil( retryAfterMs / 1000 ) 
                : undefined;

            // Anthropic spend-cap 429 with no retry-after — treat as quota.
            if( retryAfterMs === undefined && this.provider === 'anthropic' )
            {
                return new QuotaExceededError( this.provider, errorMessage, details );
            }

            return new RateLimitError( this.provider, errorMessage, retryAfterSeconds, {
                details,
                retryAfterMs
            } );
        }

        return new ProviderError( this.provider, errorMessage, response.status, details );
    }

    #shouldRetry( error: unknown, attempt: number, maxAttempts: number ): boolean
    {
        if( attempt >= maxAttempts )
        {
            return false;
        }

        if( error instanceof QuotaExceededError || error instanceof CancelledError )
        {
            return false;
        }

        if( error instanceof RateLimitError )
        {
            const retryAfterMs = ( error.details as { retryAfterMs?: number } | undefined )?.retryAfterMs;

            if( retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_CAP_MS )
            {
                return false;
            }

            return true;
        }

        if( error instanceof TimeoutError )
        {
            return true;
        }

        if( error instanceof ProviderError )
        {
            const status = error.statusCode;

            return status === 408 || status === 409 || status === 498 || status >= 500;
        }

        return true;
    }

    #retryDelayMs( error: unknown, retryIndex: number ): number | null
    {
        if( error instanceof RateLimitError )
        {
            const retryAfterMs = ( error.details as { retryAfterMs?: number } | undefined )?.retryAfterMs 
                ?? ( error.retryAfterSeconds !== undefined && Number.isFinite( error.retryAfterSeconds )
                    ? error.retryAfterSeconds * 1000 
                    : undefined );

            if( retryAfterMs !== undefined )
            {
                if( retryAfterMs > RETRY_AFTER_CAP_MS )
                {
                    return null;
                }

                return retryAfterMs;
            }
        }

        return computeBackoffMs( retryIndex );
    }

    async #sleep( ms: number, signal?: AbortSignal ): Promise<void>
    {
        if( ms <= 0 )
        {
            return;
        }

        if( signal?.aborted )
        {
            throw new CancelledError( 'Operation cancelled', signal.reason );
        }

        await new Promise<void>( ( resolve, reject ) => 
        {
            const timer = setTimeout( () => 
            {
                signal?.removeEventListener( 'abort', onAbort );
                resolve();
            }, ms );

            const onAbort = (): void => 
            {
                clearTimeout( timer );
                reject( new CancelledError( 'Operation cancelled', signal?.reason ) );
            };

            signal?.addEventListener( 'abort', onAbort, { once : true } );
        } );
    }

    #withIdleTimeout( 
        body: ReadableStream<Uint8Array>, 
        idleTimeoutMs: number, 
        callerSignal?: AbortSignal 
    ): ReadableStream<Uint8Array>
    {
        const reader = body.getReader();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const idleError = new TimeoutError( 
            `Stream idle timeout after ${idleTimeoutMs}ms`, 
            'idle', 
            idleTimeoutMs 
        );

        const clearIdle = (): void => 
        {
            if( idleTimer !== undefined )
            {
                clearTimeout( idleTimer );
                idleTimer = undefined;
            }
        };

        return new ReadableStream( {
            start : ( controller ) => 
            {
                const abortIdle = (): void => 
                {
                    if( closed ){return;}

                    closed = true;
                    clearIdle();
                    callerSignal?.removeEventListener( 'abort', onCallerAbort );

                    try
                    {
                        reader.cancel( idleError ).catch( () => {/* ignore */} );
                    }
                    catch
                    {
                        // Already cancelled.
                    }

                    controller.error( idleError );
                };

                const onCallerAbort = (): void => 
                {
                    if( closed ){return;}

                    closed = true;
                    clearIdle();

                    const reason = callerSignal?.reason;
                    const error = reason instanceof CancelledError 
                        ? reason 
                        : new CancelledError( 'Operation cancelled', reason );

                    try
                    {
                        reader.cancel( error ).catch( () => {/* ignore */} );
                    }
                    catch
                    {
                        // Already cancelled.
                    }

                    controller.error( error );
                };

                const armIdle = (): void => 
                {
                    clearIdle();
                    idleTimer = setTimeout( abortIdle, idleTimeoutMs );
                };

                const pump = async (): Promise<void> => 
                {
                    try
                    {
                        armIdle();

                        while( !closed )
                        {
                            const { done, value } = await reader.read();

                            if( closed ){return;}

                            clearIdle();

                            if( done )
                            {
                                closed = true;
                                callerSignal?.removeEventListener( 'abort', onCallerAbort );
                                controller.close();

                                return;
                            }

                            controller.enqueue( value );
                            armIdle();
                        }
                    }
                    catch( error )
                    {
                        if( closed ){return;}

                        closed = true;
                        clearIdle();
                        callerSignal?.removeEventListener( 'abort', onCallerAbort );
                        controller.error( error );
                    }
                };

                callerSignal?.addEventListener( 'abort', onCallerAbort, { once : true } );

                if( callerSignal?.aborted )
                {
                    onCallerAbort();

                    return;
                }

                void pump();
            },
            cancel : async ( reason ) => 
            {
                closed = true;
                clearIdle();
                await reader.cancel( reason );
            }
        } );
    }
}
