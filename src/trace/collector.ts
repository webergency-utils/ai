import { EventEmitter } from 'node:events';
import type { SpendTracker } from '../spend/tracker.js';
import { SimpleExecutionContext, type ExecutionContext } from '../agent/context.js';
import { SpanImpl } from './span.js';
import { computeTraceRollup } from './rollup.js';
import type { 
    Span, 
    SpanAttributeValue, 
    SpanKind, 
    Trace, 
    TraceEvents, 
    TraceFilterOptions 
} from './types.js';

export interface TraceCollectorOptions
{
    maxTraces? : number
}

export interface StartTraceOptions
{
    name?       : string
    traceId?    : string
    threadId?   : string
    agentId?    : string
    kind?       : SpanKind
    attributes? : Record<string, SpanAttributeValue>
    tracker?    : SpendTracker
}

export class TraceCollector extends EventEmitter
{
    readonly #maxTraces: number;
    readonly #completedTraces = new Map<string, Trace>();
    readonly #activeTraces = new Map<string, Trace>();

    constructor( options: TraceCollectorOptions = {} )
    {
        super();
        this.#maxTraces = options.maxTraces ?? 1000;
    }

    public override on<E extends keyof TraceEvents>( event: E, listener: TraceEvents[E] ): this
    {
        return super.on( event, listener as ( ...args: unknown[] ) => void );
    }

    public override once<E extends keyof TraceEvents>( event: E, listener: TraceEvents[E] ): this
    {
        return super.once( event, listener as ( ...args: unknown[] ) => void );
    }

    public override off<E extends keyof TraceEvents>( event: E, listener: TraceEvents[E] ): this
    {
        return super.off( event, listener as ( ...args: unknown[] ) => void );
    }

    public override emit<E extends keyof TraceEvents>( event: E, ...args: Parameters<TraceEvents[E]> ): boolean
    {
        return super.emit( event, ...args );
    }

    public startTrace( options: StartTraceOptions = {} ): {
        trace    : Trace
        rootSpan : Span
        context  : ExecutionContext
    }
    {
        const rootSpan = new SpanImpl( options.name ?? 'root', 
            {
                traceId    : options.traceId,
                kind       : options.kind ?? 'agent',
                attributes : options.attributes
            } );

        const trace: Trace = 
        {
            traceId       : rootSpan.traceId,
            threadId      : options.threadId,
            agentId       : options.agentId,
            startTime     : rootSpan.startTime,
            rootSpan,
            totalSpendUSD : 0,
            categorySpend : { ...rootSpan.categorySpend }
        };

        this.#activeTraces.set( trace.traceId, trace );

        const context = new SimpleExecutionContext( 
            {
                threadId    : options.threadId,
                agentId     : options.agentId,
                traceId     : trace.traceId,
                activeSpan  : rootSpan,
                tracker     : options.tracker,
                onSpanStart : ( span ) => 
                {
                    this.recordSpanStart( span );
                },
                onSpanEnd : ( span ) => 
                {
                    this.recordSpanEnd( span );
                }
            } );

        this.recordSpanStart( rootSpan );

        return { trace, rootSpan, context };
    }

    public recordSpanStart( span: Span ): void
    {
        this.emit( 'span:start', span );
    }

    public recordSpanEnd( span: Span ): void
    {
        this.emit( 'span:end', span );
    }

    public endTrace( traceId: string ): Trace | undefined
    {
        const trace = this.#activeTraces.get( traceId );

        if( !trace )
        {
            return undefined;
        }

        if( !trace.rootSpan.endTime )
        {
            trace.rootSpan.end();
        }

        trace.endTime = trace.rootSpan.endTime;
        trace.durationMs = trace.rootSpan.durationMs;

        computeTraceRollup( trace );

        this.#activeTraces.delete( traceId );
        this.recordCompletedTrace( trace );

        return trace;
    }

    public recordCompletedTrace( trace: Trace ): void
    {
        computeTraceRollup( trace );

        // If exists, delete first to move to latest position in Map
        if( this.#completedTraces.has( trace.traceId ) )
        {
            this.#completedTraces.delete( trace.traceId );
        }

        // LRU eviction
        while( this.#completedTraces.size >= this.#maxTraces )
        {
            const oldestKey = this.#completedTraces.keys().next().value;

            if( oldestKey !== undefined )
            {
                this.#completedTraces.delete( oldestKey );
            }
            else
            {
                break;
            }
        }

        this.#completedTraces.set( trace.traceId, trace );
        this.emit( 'trace:complete', trace );
    }

    public getTrace( traceId: string ): Trace | undefined
    {
        const completed = this.#completedTraces.get( traceId );

        if( completed )
        {
            // Move to MRU position
            this.#completedTraces.delete( traceId );
            this.#completedTraces.set( traceId, completed );
            return completed;
        }

        return this.#activeTraces.get( traceId );
    }

    public listTraces( filter: TraceFilterOptions = {} ): Trace[]
    {
        const results: Trace[] = [];

        for( const trace of this.#completedTraces.values() )
        {
            if( filter.threadId && trace.threadId !== filter.threadId )
            {
                continue;
            }

            if( filter.agentId && trace.agentId !== filter.agentId )
            {
                continue;
            }

            if( filter.status && trace.rootSpan.status !== filter.status )
            {
                continue;
            }

            if( filter.minDuration !== undefined && ( trace.durationMs ?? 0 ) < filter.minDuration )
            {
                continue;
            }

            if( filter.since !== undefined && trace.startTime < filter.since )
            {
                continue;
            }

            if( filter.until !== undefined && trace.startTime > filter.until )
            {
                continue;
            }

            results.push( trace );
        }

        // Sort descending by startTime
        results.sort( ( a, b ) => {return b.startTime - a.startTime;} );

        if( filter.limit !== undefined && filter.limit > 0 )
        {
            return results.slice( 0, filter.limit );
        }

        return results;
    }

    public clear(): void
    {
        this.#completedTraces.clear();
        this.#activeTraces.clear();
    }
}
