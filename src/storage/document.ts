export interface IDocumentStore
{
    get<T = Record<string, unknown>>( collection: string, id: string ): Promise<T | null>
    set<T = Record<string, unknown>>( collection: string, id: string, doc: T ): Promise<void>
    delete( collection: string, id: string ): Promise<boolean>
    list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown> ): Promise<T[]>
    count( collection: string ): Promise<number>
    clear( collection?: string ): Promise<void>
}

export class MemoryDocStore implements IDocumentStore
{
    readonly #collections = new Map<string, Map<string, unknown>>();

    public async get<T = Record<string, unknown>>( collection: string, id: string ): Promise<T | null>
    {
        const col = this.#collections.get( collection );

        if( !col )
        {
            return null;
        }

        const doc = col.get( id );

        if( doc === undefined )
        {
            return null;
        }

        return structuredClone( doc ) as T;
    }

    public async set<T = Record<string, unknown>>( collection: string, id: string, doc: T ): Promise<void>
    {
        let col = this.#collections.get( collection );

        if( !col )
        {
            col = new Map<string, unknown>();
            this.#collections.set( collection, col );
        }

        col.set( id, structuredClone( doc ) );
    }

    public async delete( collection: string, id: string ): Promise<boolean>
    {
        const col = this.#collections.get( collection );

        if( !col )
        {
            return false;
        }

        return col.delete( id );
    }

    public async list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown> ): Promise<T[]>
    {
        const col = this.#collections.get( collection );

        if( !col )
        {
            return [];
        }

        const results: T[] = [];

        for( const val of col.values() )
        {
            const cloned = structuredClone( val ) as Record<string, unknown>;

            if( this.matchesFilter( cloned, filter ) )
            {
                results.push( cloned as T );
            }
        }

        return results;
    }

    public async count( collection: string ): Promise<number>
    {
        const col = this.#collections.get( collection );

        return col ? col.size : 0;
    }

    public async clear( collection?: string ): Promise<void>
    {
        if( collection )
        {
            this.#collections.delete( collection );
        }
        else
        {
            this.#collections.clear();
        }
    }

    private matchesFilter( doc: Record<string, unknown>, filter?: Record<string, unknown> ): boolean
    {
        if( !filter )
        {
            return true;
        }

        for( const [ k, v ] of Object.entries( filter ) )
        {
            if( doc[k] !== v )
            {
                return false;
            }
        }

        return true;
    }
}
