import type { ChatMessage } from '../core/types.js';
import type { IDocumentStore } from '../storage/document.js';

export interface ICheckpoint
{
    id        : string
    threadId  : string
    stepIndex : number
    timestamp : number
    messages  : ChatMessage[]
    state     : Record<string, unknown>
    spendUSD  : number
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

    public async saveCheckpoint( 
        threadId: string, 
        stepIndex: number, 
        messages: ChatMessage[], 
        state: Record<string, unknown> = {}, 
        spendUSD: number = 0 
    ): Promise<ICheckpoint>
    {
        const timestamp = Date.now();
        const id = `${threadId}_step_${stepIndex}_${timestamp}`;

        const checkpoint: ICheckpoint = 
            {
                id,
                threadId,
                stepIndex,
                timestamp,
                messages : structuredClone( messages ),
                state    : structuredClone( state ),
                spendUSD
            };

        // Save historical step checkpoint
        await this.#store.set( this.#collection, id, checkpoint as unknown as Record<string, unknown> );

        // Update thread pointer to latest in dedicated collection
        await this.#store.set( 
            `${this.#collection}_latest`, 
            threadId, 
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

        all.sort( ( a, b ) => {return a.stepIndex - b.stepIndex;} );

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
