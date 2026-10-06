import type { ChatMessage } from '../core/types.js';
import { AIError } from '../core/error.js';
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

const LATEST_POINTER_ATTEMPTS = 5;

/** Thrown when a checkpoint cannot advance the thread's `latest` pointer without regressing newer state. */
export class CheckpointConflictError extends AIError
{
    public readonly threadId : string;
    public readonly runId    : string;
    public readonly sequence : number;

    constructor( message: string, checkpoint: Pick<ICheckpoint, 'threadId' | 'runId' | 'sequence'>, details?: unknown )
    {
        super( message, 'CHECKPOINT_CONFLICT', details );
        this.name = 'CheckpointConflictError';
        this.threadId = checkpoint.threadId;
        this.runId = checkpoint.runId;
        this.sequence = checkpoint.sequence;
    }
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
        // The legacy positional overload has no stable run identity, so it keeps last-write-wins ordering (still CAS-safe).
        await this.#advanceLatest( checkpoint, typeof threadIdOrInput !== 'string' );

        return checkpoint;
    }

    /**
     * Moves `<collection>_latest/<threadId>` to `checkpoint` with compare-and-swap so concurrent writers cannot regress it.
     * With `enforceOrder`, a checkpoint of the same run that is not newer than the stored latest is rejected; a different run always supersedes.
     */
    async #advanceLatest( checkpoint: ICheckpoint, enforceOrder: boolean ): Promise<void>
    {
        const latestCollection = `${this.#collection}_latest`;

        for( let attempt = 0; attempt < LATEST_POINTER_ATTEMPTS; attempt++ )
        {
            const current = await this.#store.getWithMeta<ICheckpoint>( latestCollection, checkpoint.threadId );

            if( enforceOrder && current && current.doc.runId === checkpoint.runId && current.doc.sequence >= checkpoint.sequence )
            {
                throw new CheckpointConflictError(
                    `Checkpoint sequence ${checkpoint.sequence} of run '${checkpoint.runId}' is not newer than the stored latest (${current.doc.sequence}) for thread '${checkpoint.threadId}'`,
                    checkpoint,
                    { latestSequence : current.doc.sequence, latestId : current.doc.id }
                );
            }

            const result = await this.#store.conditionalWrite(
                latestCollection,
                checkpoint.threadId,
                checkpoint as unknown as Record<string, unknown>,
                { expectedVersion : current ? current.version : null }
            );

            if( result.written )
            {
                return;
            }
        }

        throw new CheckpointConflictError(
            `Could not advance latest checkpoint for thread '${checkpoint.threadId}' after ${LATEST_POINTER_ATTEMPTS} attempts (concurrent writers)`,
            checkpoint,
            { attempts : LATEST_POINTER_ATTEMPTS }
        );
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
