import type { CategorySpendInput } from '../spend/types.js';
import type { SpendTracker } from '../spend/tracker.js';

export interface ExecutionContext
{
    readonly threadId? : string
    readonly agentId?  : string
    reportSpend( entry: CategorySpendInput ): void
}

export interface SimpleExecutionContextOptions
{
    threadId? : string
    agentId?  : string
    tracker?  : SpendTracker
    onSpend?  : ( entry: CategorySpendInput ) => void
}

export class SimpleExecutionContext implements ExecutionContext
{
    public readonly threadId? : string;
    public readonly agentId?  : string;
    readonly #tracker?        : SpendTracker;
    readonly #onSpend?        : ( entry: CategorySpendInput ) => void;

    constructor( options: SimpleExecutionContextOptions = {} )
    {
        this.threadId = options.threadId;
        this.agentId = options.agentId;
        this.#tracker = options.tracker;
        this.#onSpend = options.onSpend;
    }

    public reportSpend( entry: CategorySpendInput ): void
    {
        if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( entry, {
                threadId : this.threadId,
                agentId  : this.agentId
            } );
        }

        if( this.#onSpend )
        {
            this.#onSpend( entry );
        }
    }
}
