import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import type { CategorySpendInput } from '../spend/types.js';

export interface DocStoreOperationOptions
{
    context? : ExecutionContext
}

export interface MemoryDocStoreOptions
{
    tracker?        : SpendTracker
    storagePricing? : UnitCostRegistry
}

export interface IDocumentStore
{
    get<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<T | null>
    set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    count( collection: string ): Promise<number>
    clear( collection?: string ): Promise<void>
}

export class MemoryDocStore implements IDocumentStore
{
    readonly #collections    = new Map<string, Map<string, unknown>>();
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( options: MemoryDocStoreOptions = {} )
    {
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async get<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<T | null>
    {
        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'doc_read',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );

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

    public async set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    {
        let col = this.#collections.get( collection );

        if( !col )
        {
            col = new Map<string, unknown>();
            this.#collections.set( collection, col );
        }

        col.set( id, structuredClone( doc ) );

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'doc_write',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );
    }

    public async delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    {
        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'doc_write',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );

        const col = this.#collections.get( collection );

        if( !col )
        {
            return false;
        }

        return col.delete( id );
    }

    public async list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    {
        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'doc_read',
            units       : 1,
            unitType    : 'operations'
        }, options?.context );

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
