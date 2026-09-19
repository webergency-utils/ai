import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import type { CategorySpendInput } from '../spend/types.js';

export interface VectorRecord
{
    id        : string
    values    : number[]
    metadata? : Record<string, unknown>
    content?  : string
}

export interface VectorQueryResult
{
    id        : string
    score     : number
    metadata? : Record<string, unknown>
    content?  : string
}

export interface VectorStoreOperationOptions
{
    context? : ExecutionContext
}

export interface VectorQueryOptions
{
    topK?    : number
    filter?  : Record<string, unknown>
    context? : ExecutionContext
}

export interface MemoryVectorStoreOptions
{
    tracker?        : SpendTracker
    storagePricing? : UnitCostRegistry
}

export interface IVectorStore
{
    upsert( records: VectorRecord[], options?: VectorStoreOperationOptions ): Promise<void>
    query( 
        vector: number[], 
        topKOrOptions?: number | VectorQueryOptions, 
        filter?: Record<string, unknown>, 
        options?: VectorStoreOperationOptions 
    ): Promise<VectorQueryResult[]>
    delete( ids: string[], options?: VectorStoreOperationOptions ): Promise<void>
    count(): Promise<number>
    clear(): Promise<void>
}

export class MemoryVectorStore implements IVectorStore
{
    readonly #records         = new Map<string, VectorRecord>();
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( options: MemoryVectorStoreOptions = {} )
    {
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async upsert( records: VectorRecord[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        for( const rec of records )
        {
            this.#records.set( rec.id, structuredClone( rec ) );
        }

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'vector_write',
            units       : records.length,
            unitType    : 'records'
        }, options?.context );
    }

    public async query( 
        vector: number[], 
        topKOrOptions: number | VectorQueryOptions = 5, 
        filter?: Record<string, unknown>, 
        options?: VectorStoreOperationOptions 
    ): Promise<VectorQueryResult[]>
    {
        let topK = 5;
        let filt = filter;
        let context = options?.context;

        if( typeof topKOrOptions === 'object' && topKOrOptions !== null )
        {
            topK = topKOrOptions.topK ?? 5;
            filt = topKOrOptions.filter ?? filter;
            context = topKOrOptions.context ?? context;
        }
        else if( typeof topKOrOptions === 'number' )
        {
            topK = topKOrOptions;
        }

        const scored: VectorQueryResult[] = [];

        for( const rec of this.#records.values() )
        {
            if( !this.matchesFilter( rec.metadata, filt ) )
            {
                continue;
            }

            const score = this.cosineSimilarity( vector, rec.values );

            scored.push( 
                {
                    id       : rec.id,
                    score,
                    metadata : rec.metadata ? structuredClone( rec.metadata ) : undefined,
                    content  : rec.content
                } );
        }

        scored.sort( ( a, b ) => {return b.score - a.score;} );

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'vector_query',
            units       : 1,
            unitType    : 'queries'
        }, context );

        return scored.slice( 0, topK );
    }

    public async delete( ids: string[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        for( const id of ids )
        {
            this.#records.delete( id );
        }

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'vector_delete',
            units       : ids.length,
            unitType    : 'records'
        }, options?.context );
    }

    public async count(): Promise<number>
    {
        return this.#records.size;
    }

    public async clear(): Promise<void>
    {
        this.#records.clear();
    }

    #reportSpend( entry: CategorySpendInput, context?: ExecutionContext ): void
    {
        if( this.#storagePricing && entry.costUSD === undefined )
        {
            const resolved = this.#storagePricing.resolveCost( entry );

            if( resolved > 0 )
            {
                entry.costUSD = resolved;
            }
        }

        if( context )
        {
            context.reportSpend( entry );
        }
        else if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( entry );
        }
    }

    private matchesFilter( metadata?: Record<string, unknown>, filter?: Record<string, unknown> ): boolean
    {
        if( !filter )
        {
            return true;
        }

        if( !metadata )
        {
            return false;
        }

        for( const [ k, v ] of Object.entries( filter ) )
        {
            if( metadata[k] !== v )
            {
                return false;
            }
        }

        return true;
    }

    private cosineSimilarity( a: number[], b: number[] ): number
    {
        if( a.length === 0 || b.length === 0 || a.length !== b.length )
        {
            return 0;
        }

        let dot = 0;
        let normA = 0;
        let normB = 0;

        for( let i = 0; i < a.length; i++ )
        {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denom = Math.sqrt( normA ) * Math.sqrt( normB );

        if( denom === 0 )
        {
            return 0;
        }

        return dot / denom;
    }
}
