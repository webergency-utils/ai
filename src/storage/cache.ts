export interface ICacheStore
{
    get<T>( key: string ): Promise<T | null>
    set<T>( key: string, value: T, ttlSeconds?: number ): Promise<void>
    delete( key: string ): Promise<boolean>
    has( key: string ): Promise<boolean>
    clear(): Promise<void>
    size(): Promise<number>
}

export interface MemoryCacheStoreOptions
{
    maxEntries?        : number
    defaultTTLSeconds? : number
}

interface CacheEntry
{
    value      : unknown
    expiresAt? : number
}

export class MemoryCacheStore implements ICacheStore
{
    readonly #entries = new Map<string, CacheEntry>();
    readonly #maxEntries: number;
    readonly #defaultTTLSeconds?: number;

    constructor( options: MemoryCacheStoreOptions = {} )
    {
        this.#maxEntries = options.maxEntries ?? 10_000;
        this.#defaultTTLSeconds = options.defaultTTLSeconds;
    }

    public async get<T>( key: string ): Promise<T | null>
    {
        const entry = this.#entries.get( key );

        if( !entry )
        {
            return null;
        }

        if( entry.expiresAt !== undefined && Date.now() > entry.expiresAt )
        {
            this.#entries.delete( key );

            return null;
        }

        // LRU touch: re-insert to move to end
        this.#entries.delete( key );
        this.#entries.set( key, entry );

        return structuredClone( entry.value ) as T;
    }

    public async set<T>( key: string, value: T, ttlSeconds?: number ): Promise<void>
    {
        const ttl = ttlSeconds ?? this.#defaultTTLSeconds;
        const expiresAt = ttl !== undefined ? Date.now() + ttl * 1000 : undefined;

        if( this.#entries.has( key ) )
        {
            this.#entries.delete( key );
        }
        else if( this.#entries.size >= this.#maxEntries )
        {
            // Prune oldest LRU entry
            const oldestKey = this.#entries.keys().next().value;

            if( oldestKey !== undefined )
            {
                this.#entries.delete( oldestKey );
            }
        }

        this.#entries.set( key, 
            {
                value : structuredClone( value ),
                expiresAt
            } );
    }

    public async delete( key: string ): Promise<boolean>
    {
        return this.#entries.delete( key );
    }

    public async has( key: string ): Promise<boolean>
    {
        const entry = this.#entries.get( key );

        if( !entry )
        {
            return false;
        }

        if( entry.expiresAt !== undefined && Date.now() > entry.expiresAt )
        {
            this.#entries.delete( key );

            return false;
        }

        return true;
    }

    public async clear(): Promise<void>
    {
        this.#entries.clear();
    }

    public async size(): Promise<number>
    {
        return this.#entries.size;
    }
}
