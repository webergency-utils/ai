import type { CategorySpendInput } from '../spend/types.js';

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
    onSpend?  : ( entry: CategorySpendInput ) => void
}

export class SimpleExecutionContext implements ExecutionContext
{
    public readonly threadId? : string;
    public readonly agentId?  : string;
    readonly #onSpend?        : ( entry: CategorySpendInput ) => void;

    constructor( options: SimpleExecutionContextOptions = {} )
    {
        this.threadId = options.threadId;
        this.agentId = options.agentId;
        this.#onSpend = options.onSpend;
    }

    public reportSpend( entry: CategorySpendInput ): void
    {
        if( this.#onSpend )
        {
            this.#onSpend( entry );
        }
    }
}
