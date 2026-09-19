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

export interface IVectorStore
{
    upsert( records: VectorRecord[] ): Promise<void>
    query( vector: number[], topK?: number, filter?: Record<string, unknown> ): Promise<VectorQueryResult[]>
    delete( ids: string[] ): Promise<void>
    count(): Promise<number>
    clear(): Promise<void>
}

export class MemoryVectorStore implements IVectorStore
{
    readonly #records = new Map<string, VectorRecord>();

    public async upsert( records: VectorRecord[] ): Promise<void>
    {
        for( const rec of records )
        {
            this.#records.set( rec.id, structuredClone( rec ) );
        }
    }

    public async query( 
        vector: number[], 
        topK: number = 5, 
        filter?: Record<string, unknown> 
    ): Promise<VectorQueryResult[]>
    {
        const scored: VectorQueryResult[] = [];

        for( const rec of this.#records.values() )
        {
            if( !this.matchesFilter( rec.metadata, filter ) )
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

        return scored.slice( 0, topK );
    }

    public async delete( ids: string[] ): Promise<void>
    {
        for( const id of ids )
        {
            this.#records.delete( id );
        }
    }

    public async count(): Promise<number>
    {
        return this.#records.size;
    }

    public async clear(): Promise<void>
    {
        this.#records.clear();
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
