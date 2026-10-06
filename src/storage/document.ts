import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import { StorageInstrument } from './instrument.js';
import { assertJsonSafe, assertScalarFilter } from './json.js';

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
    readonly #collections = new Map<string, Map<string, VersionedDoc>>();
    readonly #instrument  : StorageInstrument;

    constructor( options: MemoryDocStoreOptions = {} )
    {
        this.#instrument = new StorageInstrument( 'doc', options );
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
        return this.#instrument.run( 'get', options?.context, { collection, id }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_read', 1, 'operations', ctx );

            const entry = this.#collections.get( collection )?.get( id );

            return entry ? { doc : structuredClone( entry.doc ) as T, version : entry.version } : null;
        } );
    }

    public async set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    {
        assertJsonSafe( doc, 'doc' );

        return this.#instrument.run( 'set', options?.context, { collection, id }, async ( ctx ) =>
        {
            const col = this.#collection( collection );
            const prev = col.get( id );

            col.set( id, { doc : structuredClone( doc ), version : prev ? prev.version + 1 : 1 } );
            this.#instrument.spend( 'doc_write', 1, 'operations', ctx );
        } );
    }

    public async conditionalWrite<T = Record<string, unknown>>(
        collection: string,
        id: string,
        doc: T,
        options: DocStoreOperationOptions & { expectedVersion: number | null }
    ): Promise<ConditionalWriteResult>
    {
        assertJsonSafe( doc, 'doc' );

        return this.#instrument.run( 'conditionalWrite', options.context, { collection, id }, async ( ctx ) =>
        {
            const col = this.#collection( collection );
            const current = col.get( id );
            const expected = options.expectedVersion;

            if( expected === null ? current : ( !current || current.version !== expected ) )
            {
                return { written : false, version : current?.version ?? 0 };
            }

            const version = ( current?.version ?? 0 ) + 1;

            col.set( id, { doc : structuredClone( doc ), version } );
            this.#instrument.spend( 'doc_write', 1, 'operations', ctx );

            return { written : true, version };
        } );
    }

    public async delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    {
        return this.#instrument.run( 'delete', options?.context, { collection, id }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_write', 1, 'operations', ctx );

            return this.#collections.get( collection )?.delete( id ) ?? false;
        } );
    }

    public async list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    {
        assertScalarFilter( filter );

        return this.#instrument.run( 'list', options?.context, { collection }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_read', 1, 'operations', ctx );

            const results: T[] = [];

            for( const entry of this.#collections.get( collection )?.values() ?? [] )
            {
                const cloned = structuredClone( entry.doc ) as Record<string, unknown>;

                if( this.#matchesFilter( cloned, filter ) )
                {
                    results.push( cloned as T );
                }
            }

            return results;
        } );
    }

    public async count( collection: string ): Promise<number>
    {
        return this.#collections.get( collection )?.size ?? 0;
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

    #collection( name: string ): Map<string, VersionedDoc>
    {
        let col = this.#collections.get( name );

        if( !col )
        {
            col = new Map<string, VersionedDoc>();
            this.#collections.set( name, col );
        }

        return col;
    }

    #matchesFilter( doc: Record<string, unknown>, filter?: Record<string, unknown> ): boolean
    {
        if( !filter ){return true;}

        for( const [ k, v ] of Object.entries( filter ) )
        {
            if( doc[k] !== v ){return false;}
        }

        return true;
    }
}
