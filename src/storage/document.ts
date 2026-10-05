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

export interface ConditionalWriteResult
{
    written : boolean
    version : number
}

export interface IDocumentStore
{
    get<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<T | null>
    getWithMeta<T = Record<string, unknown>>( 
        collection: string, 
        id: string, 
        options?: DocStoreOperationOptions 
    ): Promise<{ doc: T, version: number } | null>
    set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    /**
     * Atomic conditional write (KTD7 / R23).
     * `expectedVersion: null` — write only if the document does not exist.
     * `expectedVersion: N` — write only if the current version equals N.
     */
    conditionalWrite<T = Record<string, unknown>>( 
        collection: string, 
        id: string, 
        doc: T, 
        options: DocStoreOperationOptions & { expectedVersion: number | null } 
    ): Promise<ConditionalWriteResult>
    delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    count( collection: string ): Promise<number>
    clear( collection?: string ): Promise<void>
}

interface VersionedDoc
{
    doc     : unknown
    version : number
}

export class MemoryDocStore implements IDocumentStore
{
    readonly #collections     = new Map<string, Map<string, VersionedDoc>>();
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( options: MemoryDocStoreOptions = {} )
    {
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async get<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<T | null>
    {
        const meta = await this.getWithMeta<T>( collection, id, options );

        return meta ? meta.doc : null;
    }

    public async getWithMeta<T = Record<string, unknown>>( 
        collection: string, 
        id: string, 
        options?: DocStoreOperationOptions 
    ): Promise<{ doc: T, version: number } | null>
    {
        const execute = async ( ctx?: ExecutionContext ): Promise<{ doc: T, version: number } | null> => 
        {
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'doc_read',
                units       : 1,
                unitType    : 'operations'
            }, ctx ?? options?.context );

            const col = this.#collections.get( collection );

            if( !col )
            {
                return null;
            }

            const entry = col.get( id );

            if( !entry )
            {
                return null;
            }

            return {
                doc     : structuredClone( entry.doc ) as T,
                version : entry.version
            };
        };

        if( options?.context?.withSpan )
        {
            return options.context.withSpan( 
                'storage:doc:get', 
                async ( span, childCtx ) => 
                {
                    span.setAttribute( 'storage.collection', collection );
                    span.setAttribute( 'storage.id', id );
                    return execute( childCtx );
                }, 
                { kind : 'storage' } 
            );
        }

        return execute();
    }

    public async set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    {
        const execute = async ( ctx?: ExecutionContext ): Promise<void> => 
        {
            let col = this.#collections.get( collection );

            if( !col )
            {
                col = new Map<string, VersionedDoc>();
                this.#collections.set( collection, col );
            }

            const prev = col.get( id );
            const version = prev ? prev.version + 1 : 1;
            col.set( id, { doc : structuredClone( doc ), version } );

            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'doc_write',
                units       : 1,
                unitType    : 'operations'
            }, ctx ?? options?.context );
        };

        if( options?.context?.withSpan )
        {
            return options.context.withSpan( 
                'storage:doc:set', 
                async ( span, childCtx ) => 
                {
                    span.setAttribute( 'storage.collection', collection );
                    span.setAttribute( 'storage.id', id );
                    return execute( childCtx );
                }, 
                { kind : 'storage' } 
            );
        }

        return execute();
    }

    public async conditionalWrite<T = Record<string, unknown>>( 
        collection: string, 
        id: string, 
        doc: T, 
        options: DocStoreOperationOptions & { expectedVersion: number | null } 
    ): Promise<ConditionalWriteResult>
    {
        const execute = async ( ctx?: ExecutionContext ): Promise<ConditionalWriteResult> => 
        {
            let col = this.#collections.get( collection );

            if( !col )
            {
                col = new Map<string, VersionedDoc>();
                this.#collections.set( collection, col );
            }

            const current = col.get( id );
            const expected = options.expectedVersion;

            if( expected === null )
            {
                if( current )
                {
                    return { written : false, version : current.version };
                }

                col.set( id, { doc : structuredClone( doc ), version : 1 } );
                this.#reportSpend( {
                    category    : 'storage',
                    subcategory : 'doc_write',
                    units       : 1,
                    unitType    : 'operations'
                }, ctx ?? options.context );

                return { written : true, version : 1 };
            }

            if( !current || current.version !== expected )
            {
                return { written : false, version : current?.version ?? 0 };
            }

            const nextVersion = current.version + 1;
            col.set( id, { doc : structuredClone( doc ), version : nextVersion } );
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'doc_write',
                units       : 1,
                unitType    : 'operations'
            }, ctx ?? options.context );

            return { written : true, version : nextVersion };
        };

        if( options.context?.withSpan )
        {
            return options.context.withSpan( 
                'storage:doc:conditionalWrite', 
                async ( span, childCtx ) => 
                {
                    span.setAttribute( 'storage.collection', collection );
                    span.setAttribute( 'storage.id', id );
                    return execute( childCtx );
                }, 
                { kind : 'storage' } 
            );
        }

        return execute();
    }

    public async delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    {
        const execute = async ( ctx?: ExecutionContext ): Promise<boolean> => 
        {
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'doc_write',
                units       : 1,
                unitType    : 'operations'
            }, ctx ?? options?.context );

            const col = this.#collections.get( collection );

            if( !col )
            {
                return false;
            }

            return col.delete( id );
        };

        if( options?.context?.withSpan )
        {
            return options.context.withSpan( 
                'storage:doc:delete', 
                async ( span, childCtx ) => 
                {
                    span.setAttribute( 'storage.collection', collection );
                    span.setAttribute( 'storage.id', id );
                    return execute( childCtx );
                }, 
                { kind : 'storage' } 
            );
        }

        return execute();
    }

    public async list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    {
        const execute = async ( ctx?: ExecutionContext ): Promise<T[]> => 
        {
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'doc_read',
                units       : 1,
                unitType    : 'operations'
            }, ctx ?? options?.context );

            const col = this.#collections.get( collection );

            if( !col )
            {
                return [];
            }

            const results: T[] = [];

            for( const entry of col.values() )
            {
                const cloned = structuredClone( entry.doc ) as Record<string, unknown>;

                if( this.matchesFilter( cloned, filter ) )
                {
                    results.push( cloned as T );
                }
            }

            return results;
        };

        if( options?.context?.withSpan )
        {
            return options.context.withSpan( 
                'storage:doc:list', 
                async ( span, childCtx ) => 
                {
                    span.setAttribute( 'storage.collection', collection );
                    return execute( childCtx );
                }, 
                { kind : 'storage' } 
            );
        }

        return execute();
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
