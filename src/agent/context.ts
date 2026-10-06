import type { CategorySpendInput } from '../spend/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { Span, SpanOptions } from '../trace/types.js';
import { SpanImpl } from '../trace/span.js';
import { generateTraceId } from '../trace/id.js';
import type { ContentCaptureConfig } from '../trace/genai.js';

export interface ExecutionContext
{
    readonly threadId?   : string
    readonly agentId?    : string
    readonly traceId?    : string
    readonly activeSpan? : Span
    /** Opt-in prompt/completion capture policy, inherited from the `TraceCollector`. Absent means nothing is captured. */
    readonly capture?    : ContentCaptureConfig
    reportSpend( entry: CategorySpendInput ): void
    startSpan( name: string, options?: SpanOptions ): Span
    withSpan<T>( 
        name: string, 
        fn: ( span: Span, ctx: ExecutionContext ) => Promise<T>, 
        options?: SpanOptions 
    ): Promise<T>
    child( options?: Partial<SimpleExecutionContextOptions> ): ExecutionContext
}

export interface SimpleExecutionContextOptions
{
    threadId?   : string
    agentId?    : string
    traceId?    : string
    activeSpan? : Span
    capture?    : ContentCaptureConfig
    tracker?    : SpendTracker
    onSpend?    : ( entry: CategorySpendInput ) => void
    onSpanStart?: ( span: Span ) => void
    onSpanEnd?  : ( span: Span ) => void
}

export class SimpleExecutionContext implements ExecutionContext
{
    public readonly threadId?   : string;
    public readonly agentId?    : string;
    public readonly traceId?    : string;
    public readonly activeSpan? : Span;
    public readonly capture?    : ContentCaptureConfig;
    readonly #tracker?          : SpendTracker;
    readonly #onSpend?          : ( entry: CategorySpendInput ) => void;
    readonly #onSpanStart?      : ( span: Span ) => void;
    readonly #onSpanEnd?        : ( span: Span ) => void;

    constructor( options: SimpleExecutionContextOptions = {} )
    {
        this.threadId = options.threadId;
        this.agentId = options.agentId;
        this.traceId = options.traceId ?? options.activeSpan?.traceId;
        this.activeSpan = options.activeSpan;
        this.capture = options.capture;
        this.#tracker = options.tracker;
        this.#onSpend = options.onSpend;
        this.#onSpanStart = options.onSpanStart;
        this.#onSpanEnd = options.onSpanEnd;
    }

    public reportSpend( entry: CategorySpendInput ): void
    {
        const resolved: CategorySpendInput = { ...entry };

        if( resolved.costUSD === undefined && this.#tracker )
        {
            resolved.costUSD = this.#tracker.resolveCategoryCost( resolved );
        }

        if( this.activeSpan )
        {
            this.activeSpan.recordSpend( resolved );
        }

        if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( resolved, 
                {
                    threadId : this.threadId,
                    agentId  : this.agentId
                } );
        }

        if( this.#onSpend )
        {
            this.#onSpend( resolved );
        }
    }

    public startSpan( name: string, options: SpanOptions = {} ): Span
    {
        const parentSpanId = options.parentSpanId ?? this.activeSpan?.id;
        const traceId = this.traceId ?? this.activeSpan?.traceId ?? generateTraceId();

        const span = new SpanImpl( name, 
            {
                ...options,
                parentSpanId,
                traceId
            } );

        if( this.activeSpan )
        {
            this.activeSpan.addChild( span );
        }

        if( this.#onSpanStart )
        {
            this.#onSpanStart( span );
        }

        return span;
    }

    public async withSpan<T>( 
        name: string, 
        fn: ( span: Span, ctx: ExecutionContext ) => Promise<T>, 
        options: SpanOptions = {} 
    ): Promise<T>
    {
        const span = this.startSpan( name, options );
        const childCtx = this.child( 
            {
                activeSpan : span,
                traceId    : span.traceId
            } );

        try
        {
            const result = await fn( span, childCtx );
            return result;
        }
        catch( err: unknown )
        {
            span.status = 'error';
            span.errorDetails = 
                {
                    message : err instanceof Error ? err.message : String( err ),
                    name    : err instanceof Error ? err.name : undefined,
                    stack   : err instanceof Error ? err.stack : undefined
                };

            throw err;
        }
        finally
        {
            span.end();

            if( this.#onSpanEnd )
            {
                this.#onSpanEnd( span );
            }
        }
    }

    public child( options: Partial<SimpleExecutionContextOptions> = {} ): SimpleExecutionContext
    {
        return new SimpleExecutionContext( 
            {
                threadId    : options.threadId ?? this.threadId,
                agentId     : options.agentId ?? this.agentId,
                traceId     : options.traceId ?? this.traceId,
                activeSpan  : options.activeSpan ?? this.activeSpan,
                capture     : options.capture ?? this.capture,
                tracker     : options.tracker ?? this.#tracker,
                onSpend     : options.onSpend ?? this.#onSpend,
                onSpanStart : options.onSpanStart ?? this.#onSpanStart,
                onSpanEnd   : options.onSpanEnd ?? this.#onSpanEnd
            } );
    }
}
