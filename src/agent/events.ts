import type { ToolCall, UsageMetrics, ModelResponse } from '../core/types.js';
import type { AgentResult } from './agent.js';

/**
 * Events emitted by `Agent.runStream()`. Per model step the order is deterministic:
 * `step:start`, any `text:delta` / `reasoning:delta`, one `tool:call` per assembled call,
 * one `tool:result` per call in model-call order, `step:finish`. The run ends with `finish`.
 */
export type AgentEvent =
    | { type : 'step:start',       step : number }
    | { type : 'text:delta',       step : number, delta : string }
    | { type : 'reasoning:delta',  step : number, delta : string }
    | { type : 'tool:call',        step : number, toolCall : ToolCall }
    | { type : 'tool:result',      step : number, toolCallId : string, name : string, content : string, isError : boolean }
    | { type : 'step:finish',      step : number, usage? : UsageMetrics, finishReason? : ModelResponse['finishReason'], toolCalls : number }
    | { type : 'finish',           result : AgentResult };

export type AgentEmit = ( event: AgentEvent ) => void;

/**
 * Unbounded single-consumer async queue. Items pushed before a failure are still
 * delivered; the failure is thrown after the queue drains, so no event is lost.
 */
export class EventChannel<T>
{
    readonly #queue : T[] = [];
    #wake?          : () => void;
    #closed         = false;
    #failure?       : { error : unknown };

    public push( item: T ): void
    {
        if( this.#closed ){throw new Error( 'EventChannel is closed' );}

        this.#queue.push( item );
        this.#notify();
    }

    public close(): void
    {
        this.#closed = true;
        this.#notify();
    }

    public fail( error: unknown ): void
    {
        this.#failure = { error };
        this.#closed = true;
        this.#notify();
    }

    public async next(): Promise<IteratorResult<T, undefined>>
    {
        for( ;; )
        {
            if( this.#queue.length > 0 )
            {
                return { done : false, value : this.#queue.shift() as T };
            }

            if( this.#failure ){throw this.#failure.error;}

            if( this.#closed ){return { done : true, value : undefined };}

            await new Promise<void>( ( resolve ) => {this.#wake = resolve;} );
        }
    }

    #notify(): void
    {
        const wake = this.#wake;

        this.#wake = undefined;
        wake?.();
    }
}
