import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import type { CategorySpendInput } from '../spend/types.js';

export interface CacheStoreOperationOptions
{
    context? : ExecutionContext
}

export interface MemoryCacheStoreOptions
{
    maxEntries?        : number
    defaultTTLSeconds? : number
    tracker?           : SpendTracker
    storagePricing?    : UnitCostRegistry
}

export interface ICacheStore
{
    get<T>( key: string, options?: CacheStoreOperationOptions ): Promise<T | null>
    set<T>( key: string, value: T, ttlSeconds?: number, options?: CacheStoreOperationOptions ): Promise<void>
    delete( key: string, options?: CacheStoreOperationOptions ): Promise<boolean>
    has( key: string ): Promise<boolean>
    clear(): Promise<void>
    size(): Promise<number>
}

interface CacheEntry
{
    value      : unknown
    expiresAt? : number
}

export class MemoryCacheStore implements ICacheStore
{
    readonly #entries         = new Map<string, CacheEntry>();
    readonly #maxEntries      : number;
    readonly #defaultTTLSeconds? : number;
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( options: MemoryCacheStoreOptions = {} )
    {
        this.#maxEntries = options.maxEntries ?? 10_000;
        this.#defaultTTLSeconds = options.defaultTTLSeconds;
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async get<T>( key: string, options?: CacheStoreOperationOptions ): Promise<T | null>
    {
        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'cache_read',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );

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

    public async set<T>( key: string, value: T, ttlSeconds?: number, options?: CacheStoreOperationOptions ): Promise<void>
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

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'cache_write',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );
    }

    public async delete( key: string, options?: CacheStoreOperationOptions ): Promise<boolean>
    {
        const deleted = this.#entries.delete( key );

        if( deleted )
        {
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'cache_write',
                units       : 1,
                unitType    : 'operations'
            }, options?.context );
        }

        return deleted;
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
}
