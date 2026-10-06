import { DimensionMismatchError, InvalidInputError } from '../../core/error.js';
import { describeError, StorageError, wrapStorageError } from '../errors.js';
import { StorageInstrument } from '../instrument.js';
import type { StorageInstrumentOptions } from '../instrument.js';
import { assertScalarFilter, toJson } from '../json.js';
import type { IVectorStore, VectorQueryOptions, VectorQueryResult, VectorRecord, VectorStoreOperationOptions } from '../vector.js';
import { assertIdentifier, SqlParams, POSTGRES_DIALECT } from './sql.js';
import type { SqlClient } from './sql.js';

const UPSERT_CHUNK = 200;
const MAX_DIMENSIONS = 16_000;
const REMEDIATION = 'Install the pgvector extension (e.g. run the pgvector/pgvector Docker image or `apt install postgresql-16-pgvector`) and make sure the role may run `CREATE EXTENSION vector`, then call ensureSchema() again.';

export interface PgVectorIndexOptions
{
    type             : 'hnsw'
    /** Max connections per layer (pgvector default 16). */
    m?               : number
    /** Candidate list size while building (pgvector default 64). */
    efConstruction?  : number
}

export interface PgVectorStoreOptions extends StorageInstrumentOptions
{
    /** Table holding the vectors. Default `ai_vectors`. */
    table?     : string
    /** Required: becomes the column type `vector(N)` and is enforced before any SQL is sent. */
    dimensions : number
    /** Optional approximate-nearest-neighbor index, created by `ensureSchema()`. */
    index?     : PgVectorIndexOptions
}

/**
 * `IVectorStore` on Postgres with the pgvector extension.
 *
 * - `query` returns cosine **similarity** (`1 - (embedding <=> q)`), ordered like `MemoryVectorStore`. pgvector stores
 *   `float4`, so scores agree with the in-memory reference to roughly 1e-7.
 * - The metadata filter is jsonb containment (`metadata @> filter`); only scalar equality filters are accepted.
 * - Records without metadata never match a filter, exactly like the in-memory store.
 * - A zero vector has no direction: its similarity is reported as 0.
 * - Vectors must contain finite numbers.
 */
export class PgVectorStore implements IVectorStore
{
    readonly #client     : SqlClient;
    readonly #table      : string;
    readonly #dimensions : number;
    readonly #index?     : PgVectorIndexOptions;
    readonly #instrument : StorageInstrument;

    constructor( client: SqlClient, options: PgVectorStoreOptions )
    {
        this.#table = assertIdentifier( options.table ?? 'ai_vectors', 'table name' );

        if( !Number.isInteger( options.dimensions ) || options.dimensions < 1 || options.dimensions > MAX_DIMENSIONS )
        {
            throw new InvalidInputError( `PgVectorStore requires an integer 'dimensions' between 1 and ${MAX_DIMENSIONS}, got ${options.dimensions}` );
        }

        if( options.index )
        {
            if( options.index.type !== 'hnsw' )
            {
                throw new InvalidInputError( `Unsupported pgvector index type '${options.index.type}' (only 'hnsw')` );
            }

            for( const [ label, value ] of [ [ 'm', options.index.m ], [ 'efConstruction', options.index.efConstruction ] ] as const )
            {
                if( value !== undefined && ( !Number.isInteger( value ) || value < 1 ) )
                {
                    throw new InvalidInputError( `pgvector index option '${label}' must be a positive integer, got ${value}` );
                }
            }

            assertIdentifier( `${this.#table}_embedding_hnsw`, 'index name' );
        }

        this.#client = client;
        this.#dimensions = options.dimensions;
        this.#index = options.index;
        this.#instrument = new StorageInstrument( 'vector', options );
    }

    public get dimensions(): number
    {
        return this.#dimensions;
    }

    /** Creates the extension, the table and the optional HNSW index. Idempotent. */
    public async ensureSchema(): Promise<void>
    {
        try
        {
            await this.#client.query( 'CREATE EXTENSION IF NOT EXISTS vector', [] );
        }
        catch( err )
        {
            throw new StorageError( 'pgvector', 'ensureSchema', `could not enable the vector extension: ${describeError( err )}. ${REMEDIATION}`, err );
        }

        await this.#exec( 'ensureSchema', async () =>
        {
            await this.#client.query(
                `CREATE TABLE IF NOT EXISTS ${this.#table} ( id TEXT PRIMARY KEY, embedding vector(${this.#dimensions}) NOT NULL, metadata JSONB, content TEXT )`,
                []
            );

            if( this.#index )
            {
                const opts = [
                    this.#index.m === undefined ? '' : `m = ${this.#index.m}`,
                    this.#index.efConstruction === undefined ? '' : `ef_construction = ${this.#index.efConstruction}`
                ].filter( Boolean );

                await this.#client.query(
                    `CREATE INDEX IF NOT EXISTS ${this.#table}_embedding_hnsw ON ${this.#table} USING hnsw ( embedding vector_cosine_ops )${opts.length > 0 ? ` WITH ( ${opts.join( ', ' )} )` : ''}`,
                    []
                );
            }
        } );
    }

    public async upsert( records: VectorRecord[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        // Validate everything first: nothing is sent unless the whole batch is acceptable.
        const unique = new Map<string, { vector: string, metadata: string | null, content: string | null }>();

        for( const rec of records )
        {
            this.#assertVector( rec.values );
            unique.set( rec.id, {
                vector   : this.#literal( rec.values ),
                metadata : rec.metadata === undefined ? null : toJson( rec.metadata, `records[${rec.id}].metadata` ),
                content  : rec.content ?? null
            } );
        }

        return this.#instrument.run( 'upsert', options?.context, { count : records.length }, async ( ctx ) =>
        {
            const entries = [ ...unique.entries() ];

            await this.#exec( 'upsert', async () =>
            {
                for( let i = 0; i < entries.length; i += UPSERT_CHUNK )
                {
                    const p = new SqlParams( POSTGRES_DIALECT );
                    const rows = entries.slice( i, i + UPSERT_CHUNK ).map( ( [ id, row ] ) =>
                    {
                        return `( ${p.add( id )}, ${p.add( row.vector )}::vector, ${p.add( row.metadata )}::jsonb, ${p.add( row.content )} )`;
                    } );

                    await this.#client.query(
                        `INSERT INTO ${this.#table} ( id, embedding, metadata, content ) VALUES ${rows.join( ', ' )} ON CONFLICT ( id ) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, content = EXCLUDED.content`,
                        p.values
                    );
                }
            } );
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

        this.#assertVector( vector );
        assertScalarFilter( filt );

        const limit = Number.isFinite( topK ) ? Math.max( 0, Math.floor( topK ) ) : 5;

        return this.#instrument.run( 'query', context, { topK : limit }, async ( ctx ) =>
        {
            this.#instrument.spend( 'vector_query', 1, 'queries', ctx );

            if( limit === 0 ){return [];}

            return this.#exec( 'query', async () =>
            {
                const p = new SqlParams( POSTGRES_DIALECT );
                const q = `${p.add( this.#literal( vector ) )}::vector`;
                const where = filt ? ` WHERE metadata @> ${p.add( JSON.stringify( filt ) )}::jsonb` : '';
                const res = await this.#client.query<{ id: string, metadata: string | null, content: string | null, score: number | string }>(
                    `SELECT id, metadata::text AS metadata, content, CASE WHEN ( embedding <=> ${q} ) = 'NaN'::float8 THEN 0 ELSE 1 - ( embedding <=> ${q} ) END AS score FROM ${this.#table}${where} ORDER BY embedding <=> ${q} LIMIT ${p.add( limit )}`,
                    p.values
                );

                return res.rows.map( ( row ) =>
                {
                    return {
                        id       : row.id,
                        score    : Number( row.score ),
                        metadata : row.metadata == null ? undefined : JSON.parse( row.metadata ) as Record<string, unknown>,
                        content  : row.content ?? undefined
                    };
                } );
            } );
        } );
    }

    public async delete( ids: string[], options?: VectorStoreOperationOptions ): Promise<void>
    {
        return this.#instrument.run( 'delete', options?.context, { count : ids.length }, async ( ctx ) =>
        {
            if( ids.length > 0 )
            {
                await this.#exec( 'delete', async () =>
                {
                    await this.#client.query( `DELETE FROM ${this.#table} WHERE id = ANY( $1::text[] )`, [ ids ] );
                } );
            }

            this.#instrument.spend( 'vector_delete', ids.length, 'records', ctx );
        } );
    }

    public async count(): Promise<number>
    {
        return this.#exec( 'count', async () =>
        {
            const res = await this.#client.query<{ n: number | string }>( `SELECT COUNT(*) AS n FROM ${this.#table}`, [] );

            return Number( res.rows[0]?.n ?? 0 );
        } );
    }

    public async clear(): Promise<void>
    {
        await this.#exec( 'clear', async () =>
        {
            await this.#client.query( `DELETE FROM ${this.#table}`, [] );
        } );
    }

    #assertVector( values: number[] ): void
    {
        if( values.length !== this.#dimensions )
        {
            throw new DimensionMismatchError( this.#dimensions, values.length );
        }

        for( let i = 0; i < values.length; i++ )
        {
            if( typeof values[i] !== 'number' || !Number.isFinite( values[i] ) )
            {
                throw new InvalidInputError( `Vector component ${i} must be a finite number, got ${String( values[i] )}` );
            }
        }
    }

    #literal( values: number[] ): string
    {
        return `[${values.join( ',' )}]`;
    }

    async #exec<R>( operation: string, fn: () => Promise<R> ): Promise<R>
    {
        try
        {
            return await fn();
        }
        catch( err )
        {
            const wrapped = wrapStorageError( 'pgvector', `vector.${operation}`, err );

            if( wrapped instanceof StorageError && /(type|extension) "vector"|operator does not exist:.*vector/i.test( wrapped.message ) )
            {
                throw new StorageError( 'pgvector', `vector.${operation}`, `${describeError( err )}. ${REMEDIATION}`, err );
            }

            throw wrapped;
        }
    }
}
