import type { ChatMessage } from '../core/types.js';
import type { IDocumentStore } from '../storage/document.js';

export type AgentRunStatus = 
    | 'running' 
    | 'completed' 
    | 'interrupted' 
    | 'abandoned'
    | 'step_limit'
    | 'blocked';

export interface PendingToolCall
{
    id        : string
    name      : string
    arguments : Record<string, unknown>
}

export interface ICheckpoint
{
    id               : string
    threadId         : string
    runId            : string
    sequence         : number
    stepIndex        : number
    runStepCount     : number
    timestamp        : number
    messages         : ChatMessage[]
    state            : Record<string, unknown>
    spendUSD         : number
    status           : AgentRunStatus
    originalInput?   : string | ChatMessage[]
    pendingToolCalls?: PendingToolCall[]
    completedToolIds?: string[]
}

export interface SaveCheckpointInput
{
    threadId          : string
    runId             : string
    sequence          : number
    stepIndex         : number
    runStepCount      : number
    messages          : ChatMessage[]
    state?            : Record<string, unknown>
    spendUSD?         : number
    status            : AgentRunStatus
    originalInput?    : string | ChatMessage[]
    pendingToolCalls? : PendingToolCall[]
    completedToolIds? : string[]
}

export class CheckpointManager
{
    readonly #store: IDocumentStore;
    readonly #collection: string;

    constructor( store: IDocumentStore, collection: string = 'checkpoints' )
    {
        this.#store = store;
        this.#collection = collection;
    }

    public async saveCheckpoint( input: SaveCheckpointInput ): Promise<ICheckpoint>
    public async saveCheckpoint( 
        threadId: string, 
        stepIndex: number, 
        messages: ChatMessage[], 
        state?: Record<string, unknown>, 
        spendUSD?: number 
    ): Promise<ICheckpoint>
    public async saveCheckpoint( 
        threadIdOrInput: string | SaveCheckpointInput, 
        stepIndex?: number, 
        messages?: ChatMessage[], 
        state: Record<string, unknown> = {}, 
        spendUSD: number = 0 
    ): Promise<ICheckpoint>
    {
        const input: SaveCheckpointInput = typeof threadIdOrInput === 'string'
            ? {
                threadId     : threadIdOrInput,
                runId        : `legacy_${threadIdOrInput}`,
                sequence     : stepIndex ?? 0,
                stepIndex    : stepIndex ?? 0,
                runStepCount : stepIndex ?? 0,
                messages     : messages ?? [],
                state,
                spendUSD,
                status       : 'completed'
            }
            : threadIdOrInput;

        const timestamp = Date.now();
        const id = `${input.threadId}_${input.runId}_seq_${input.sequence}_${timestamp}`;

        const checkpoint: ICheckpoint = {
            id,
            threadId         : input.threadId,
            runId            : input.runId,
            sequence         : input.sequence,
            stepIndex        : input.stepIndex,
            runStepCount     : input.runStepCount,
            timestamp,
            messages         : structuredClone( input.messages ),
            state            : structuredClone( input.state ?? {} ),
            spendUSD         : input.spendUSD ?? 0,
            status           : input.status,
            originalInput    : input.originalInput,
            pendingToolCalls : input.pendingToolCalls 
                ? structuredClone( input.pendingToolCalls ) 
                : undefined,
            completedToolIds : input.completedToolIds 
                ? [ ...input.completedToolIds ] 
                : undefined
        };

        await this.#store.set( this.#collection, id, checkpoint as unknown as Record<string, unknown> );
        await this.#store.set( 
            `${this.#collection}_latest`, 
            input.threadId, 
            checkpoint as unknown as Record<string, unknown> 
        );

        return checkpoint;
    }

    public async getLatestCheckpoint( threadId: string ): Promise<ICheckpoint | null>
    {
        return this.#store.get<ICheckpoint>( `${this.#collection}_latest`, threadId );
    }

    public async getCheckpoint( checkpointId: string ): Promise<ICheckpoint | null>
    {
        return this.#store.get<ICheckpoint>( this.#collection, checkpointId );
    }

    public async listCheckpoints( threadId: string ): Promise<ICheckpoint[]>
    {
        const all = await this.#store.list<ICheckpoint>( this.#collection, { threadId } );

        all.sort( ( a, b ) => {return a.sequence - b.sequence;} );

        return all;
    }

    public async deleteThreadCheckpoints( threadId: string ): Promise<void>
    {
        const all = await this.listCheckpoints( threadId );

        for( const cp of all )
        {
            await this.#store.delete( this.#collection, cp.id );
        }

        await this.#store.delete( `${this.#collection}_latest`, threadId );
    }
}
