import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import { StorageInstrument } from './instrument.js';
import { assertJsonSafe, assertScalarFilter } from './json.js';
import { DimensionMismatchError } from '../core/error.js';

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
    /** When set, all vectors must match this dimension. Otherwise locked on first write. */
    dimensions?     : number
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
    readonly #records    = new Map<string, VectorRecord>();
    readonly #instrument : StorageInstrument;
    #dimensions?         : number;

    constructor( options: MemoryVectorStoreOptions = {} )
    {
        this.#instrument = new StorageInstrument( 'vector', options );
        this.#dimensions = options.dimensions;
    }

    public get dimensions(): number | undefined
    {
        return this.#dimensions;
    }

    public async upsert( records: VectorRecord[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        for( const rec of records )
        {
            if( rec.metadata )
            {
                assertJsonSafe( rec.metadata, `records[${rec.id}].metadata` );
            }
        }

        return this.#instrument.run( 'upsert', options?.context, { count : records.length }, async ( ctx ) =>
        {
            // Validate the whole batch first so a bad record never leaves a partial write behind.
            const locked = this.#dimensions;

            try
            {
                for( const rec of records )
                {
                    this.#assertDimensions( rec.values.length );
                }
            }
            catch( err )
            {
                this.#dimensions = locked;

                throw err;
            }

            for( const rec of records )
            {
                this.#records.set( rec.id, structuredClone( rec ) );
            }

            this.#instrument.spend( 'vector_write', records.length, 'records', ctx );
        } );
    }

    public async query(
        vector: number[],
        topKOrOptions: number | VectorQueryOptions = 5,
        filter?: Record<string, unknown>,
        options?: VectorStoreOperationOptions
    ): Promise<VectorQueryResult[]>
    {
        this.#assertDimensions( vector.length );

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

        assertScalarFilter( filt );

        return this.#instrument.run( 'query', context, { topK }, async ( ctx ) =>
        {
            const scored: VectorQueryResult[] = [];

            for( const rec of this.#records.values() )
            {
                if( !this.matchesFilter( rec.metadata, filt ) ){continue;}

                scored.push( {
                    id       : rec.id,
                    score    : this.cosineSimilarity( vector, rec.values ),
                    metadata : rec.metadata ? structuredClone( rec.metadata ) : undefined,
                    content  : rec.content
                } );
            }

            scored.sort( ( a, b ) => {return b.score - a.score;} );
            this.#instrument.spend( 'vector_query', 1, 'queries', ctx );

            return scored.slice( 0, Math.max( 0, topK ) );
        } );
    }

    public async delete( ids: string[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        return this.#instrument.run( 'delete', options?.context, { count : ids.length }, async ( ctx ) =>
        {
            for( const id of ids )
            {
                this.#records.delete( id );
            }

            this.#instrument.spend( 'vector_delete', ids.length, 'records', ctx );
        } );
    }

    public async count(): Promise<number>
    {
        return this.#records.size;
    }

    public async clear(): Promise<void>
    {
        this.#records.clear();
        this.#dimensions = undefined;
    }

    #assertDimensions( length: number ): void
    {
        if( this.#dimensions === undefined )
        {
            this.#dimensions = length;

            return;
        }

        if( length !== this.#dimensions )
        {
            throw new DimensionMismatchError( this.#dimensions, length );
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
