import { InvalidInputError } from '../../core/error.js';
import type { CacheStoreOperationOptions, ICacheStore } from '../cache.js';
import type { ConditionalWriteResult, DocStoreOperationOptions, IDocumentStore } from '../document.js';
import { isUniqueViolation, wrapStorageError } from '../errors.js';
import { StorageInstrument } from '../instrument.js';
import type { StorageInstrumentOptions } from '../instrument.js';
import { assertScalarFilter, toJson } from '../json.js';

/* -------------------------------------------------------------------------- */
/*  Client contract                                                           */
/* -------------------------------------------------------------------------- */

export interface SqlResult<T = Record<string, unknown>>
{
    rows     : T[]
    rowCount : number
}

/**
 * The only thing SQL adapters need from a driver. Placeholders follow the dialect of the adapter
 * (`$1..$n` for Postgres, positional `?` for SQLite/LibSQL). The caller owns pooling, retries and closing.
 */
export interface SqlClient
{
    query<T = Record<string, unknown>>( sql: string, params: unknown[] ): Promise<SqlResult<T>>
}

/** Structural subset of `pg.Pool` / `pg.Client`. */
export interface PgLike
{
    query( text: string, values?: unknown[] ): Promise<{ rows: unknown[], rowCount: number | null }>
}

/** Structural subset of `@libsql/client`'s `Client`. */
export interface LibsqlLike
{
    execute( stmt: { sql: string, args: unknown[] } ): Promise<{ columns: string[], rows: ArrayLike<unknown>[], rowsAffected: number }>
}

/** Structural subset of `node:sqlite`'s `DatabaseSync` (and `better-sqlite3`'s `Database`). */
export interface NodeSqliteLike
{
    prepare( sql: string ): { all( ...params: unknown[] ): unknown[], run( ...params: unknown[] ): { changes: number | bigint } }
}

export function fromPg( client: PgLike ): SqlClient
{
    return {
        async query<T>( sql: string, params: unknown[] )
        {
            const res = await client.query( sql, params );

            return { rows : res.rows as T[], rowCount : res.rowCount ?? res.rows.length };
        }
    };
}

export function fromLibsql( client: LibsqlLike ): SqlClient
{
    return {
        async query<T>( sql: string, params: unknown[] )
        {
            const res = await client.execute( { sql, args : params } );
            const rows = res.rows.map( ( row ) =>
            {
                const obj: Record<string, unknown> = {};

                res.columns.forEach( ( col, i ) => {obj[col] = row[i];} );

                return obj as T;
            } );

            return { rows, rowCount : rows.length > 0 ? rows.length : res.rowsAffected };
        }
    };
}

const READS_ROWS = /^\s*(SELECT|WITH|PRAGMA)\b|\bRETURNING\b/i;

export function fromNodeSqlite( db: NodeSqliteLike ): SqlClient
{
    return {
        async query<T>( sql: string, params: unknown[] )
        {
            const stmt = db.prepare( sql );

            if( READS_ROWS.test( sql ) )
            {
                const rows = stmt.all( ...params ) as T[];

                return { rows, rowCount : rows.length };
            }

            return { rows : [] as T[], rowCount : Number( stmt.run( ...params ).changes ) };
        }
    };
}

/* -------------------------------------------------------------------------- */
/*  Identifiers and dialects                                                  */
/* -------------------------------------------------------------------------- */

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Table names are interpolated into SQL, so they are validated rather than quoted. Values always use bind parameters. */
export function assertIdentifier( value: unknown, label: string ): string
{
    if( typeof value !== 'string' || !IDENTIFIER_RE.test( value ) )
    {
        throw new InvalidInputError( `Invalid ${label} ${JSON.stringify( value )}: must match ${IDENTIFIER_RE}`, { label, value } );
    }

    return value;
}

type Scalar = string | number | boolean | null;

/** Collects bind parameters in textual order so positional (`?`) and numbered (`$n`) dialects share one builder. */
export class SqlParams
{
    readonly #dialect : SqlDialect;
    readonly #values  : unknown[] = [];

    constructor( dialect: SqlDialect )
    {
        this.#dialect = dialect;
    }

    public add( value: unknown ): string
    {
        this.#values.push( value );

        return this.#dialect.placeholder( this.#values.length );
    }

    public get values(): unknown[]
    {
        return this.#values;
    }
}

export interface SqlDialect
{
    readonly name         : 'postgres' | 'sqlite'
    readonly jsonType     : string
    readonly bigintType   : string
    placeholder( index: number ): string
    /** Bind expression for a JSON text parameter. */
    jsonParam( placeholder: string ): string
    /** Select expression returning a JSON column as text. */
    jsonSelect( column: string ): string
    /** Predicate: top-level `key` of `column` equals scalar `value` (type-strict, missing keys never match). */
    jsonEquals( params: SqlParams, column: string, key: string, value: Scalar ): string
}

export const POSTGRES_DIALECT: SqlDialect =
    {
        name        : 'postgres',
        jsonType    : 'JSONB',
        bigintType  : 'BIGINT',
        placeholder : ( i ) => {return `$${i}`;},
        jsonParam   : ( p ) => {return `${p}::jsonb`;},
        jsonSelect  : ( c ) => {return `${c}::text`;},
        jsonEquals  : ( params, column, key, value ) =>
        {
            return `( ${column} -> ${params.add( key )}::text ) = ${params.add( JSON.stringify( value ) )}::jsonb`;
        }
    };

export const SQLITE_DIALECT: SqlDialect =
    {
        name        : 'sqlite',
        jsonType    : 'TEXT',
        bigintType  : 'INTEGER',
        placeholder : () => {return '?';},
        jsonParam   : ( p ) => {return p;},
        jsonSelect  : ( c ) => {return c;},
        jsonEquals  : ( params, column, key, value ) =>
        {
            const head = `EXISTS ( SELECT 1 FROM json_each( ${column} ) WHERE key = ${params.add( key )} AND`;

            if( value === null ){return `${head} type = 'null' )`;}
            if( typeof value === 'boolean' ){return `${head} type = '${value ? 'true' : 'false'}' )`;}
            if( typeof value === 'number' ){return `${head} type IN ( 'integer', 'real' ) AND value = ${params.add( value )} )`;}

            return `${head} type = 'text' AND value = ${params.add( value )} )`;
        }
    };

/* -------------------------------------------------------------------------- */
/*  Document store                                                            */
/* -------------------------------------------------------------------------- */

export interface SqlDocStoreOptions extends StorageInstrumentOptions
{
    /** Table holding every collection. Default `ai_documents`. */
    table? : string
}

/**
 * Durable `IDocumentStore` on any `SqlClient`. `(collection, id)` is the primary key; every write bumps `version`.
 * Compare-and-swap is one atomic statement (`INSERT .. ON CONFLICT DO NOTHING` / `UPDATE .. WHERE version = n`).
 * The caller owns the client; call `ensureSchema()` once before use.
 */
export class SqlDocStore implements IDocumentStore
{
    readonly #client     : SqlClient;
    readonly #dialect    : SqlDialect;
    readonly #table      : string;
    readonly #instrument : StorageInstrument;

    constructor( client: SqlClient, dialect: SqlDialect, options: SqlDocStoreOptions = {} )
    {
        this.#table = assertIdentifier( options.table ?? 'ai_documents', 'table name' );
        this.#client = client;
        this.#dialect = dialect;
        this.#instrument = new StorageInstrument( 'doc', options );
    }

    /** Idempotent `CREATE TABLE IF NOT EXISTS`. */
    public async ensureSchema(): Promise<void>
    {
        await this.#exec( 'ensureSchema', async () =>
        {
            await this.#client.query(
                `CREATE TABLE IF NOT EXISTS ${this.#table} ( collection TEXT NOT NULL, id TEXT NOT NULL, doc ${this.#dialect.jsonType} NOT NULL, version ${this.#dialect.bigintType} NOT NULL, PRIMARY KEY ( collection, id ) )`,
                []
            );
        } );
    }

    public async get<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<T | null>
    {
        const meta = await this.getWithMeta<T>( collection, id, options );

        return meta ? meta.doc : null;
    }

    public async getWithMeta<T = Record<string, unknown>>( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<{ doc: T, version: number } | null>
    {
        return this.#instrument.run( 'get', options?.context, { collection, id }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_read', 1, 'operations', ctx );

            return this.#exec( 'get', async () =>
            {
                const p = new SqlParams( this.#dialect );
                const res = await this.#client.query<{ doc: string, version: number | string }>(
                    `SELECT ${this.#dialect.jsonSelect( 'doc' )} AS doc, version FROM ${this.#table} WHERE collection = ${p.add( collection )} AND id = ${p.add( id )}`,
                    p.values
                );

                if( res.rows.length === 0 ){return null;}

                return { doc : JSON.parse( res.rows[0].doc ) as T, version : Number( res.rows[0].version ) };
            } );
        } );
    }

    public async set<T = Record<string, unknown>>( collection: string, id: string, doc: T, options?: DocStoreOperationOptions ): Promise<void>
    {
        const json = toJson( doc, 'doc' );

        return this.#instrument.run( 'set', options?.context, { collection, id }, async ( ctx ) =>
        {
            await this.#exec( 'set', async () =>
            {
                const p = new SqlParams( this.#dialect );

                await this.#client.query(
                    `INSERT INTO ${this.#table} ( collection, id, doc, version ) VALUES ( ${p.add( collection )}, ${p.add( id )}, ${this.#dialect.jsonParam( p.add( json ) )}, 1 ) ON CONFLICT ( collection, id ) DO UPDATE SET doc = excluded.doc, version = ${this.#table}.version + 1`,
                    p.values
                );
            } );
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
        const json = toJson( doc, 'doc' );
        const expected = options.expectedVersion;

        if( expected !== null && !Number.isSafeInteger( expected ) )
        {
            throw new InvalidInputError( `expectedVersion must be null or a safe integer, got ${expected}` );
        }

        return this.#instrument.run( 'conditionalWrite', options.context, { collection, id }, async ( ctx ) =>
        {
            const result = await this.#exec( 'conditionalWrite', async () =>
            {
                const p = new SqlParams( this.#dialect );
                let written: boolean;

                if( expected === null )
                {
                    try
                    {
                        const res = await this.#client.query(
                            `INSERT INTO ${this.#table} ( collection, id, doc, version ) VALUES ( ${p.add( collection )}, ${p.add( id )}, ${this.#dialect.jsonParam( p.add( json ) )}, 1 ) ON CONFLICT ( collection, id ) DO NOTHING RETURNING version`,
                            p.values
                        );

                        written = res.rows.length > 0;
                    }
                    catch( err )
                    {
                        if( !isUniqueViolation( err ) ){throw err;}

                        written = false;
                    }

                    if( written ){return { written : true, version : 1 };}
                }
                else
                {
                    const res = await this.#client.query(
                        `UPDATE ${this.#table} SET doc = ${this.#dialect.jsonParam( p.add( json ) )}, version = version + 1 WHERE collection = ${p.add( collection )} AND id = ${p.add( id )} AND version = ${p.add( expected )} RETURNING version`,
                        p.values
                    );

                    if( res.rows.length > 0 ){return { written : true, version : Number( res.rows[0].version ) };}
                }

                // Lost the race (or the document is missing): report the version that beat us.
                const q = new SqlParams( this.#dialect );
                const cur = await this.#client.query<{ version: number | string }>(
                    `SELECT version FROM ${this.#table} WHERE collection = ${q.add( collection )} AND id = ${q.add( id )}`,
                    q.values
                );

                return { written : false, version : cur.rows.length > 0 ? Number( cur.rows[0].version ) : 0 };
            } );

            if( result.written )
            {
                this.#instrument.spend( 'doc_write', 1, 'operations', ctx );
            }

            return result;
        } );
    }

    public async delete( collection: string, id: string, options?: DocStoreOperationOptions ): Promise<boolean>
    {
        return this.#instrument.run( 'delete', options?.context, { collection, id }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_write', 1, 'operations', ctx );

            return this.#exec( 'delete', async () =>
            {
                const p = new SqlParams( this.#dialect );
                const res = await this.#client.query( `DELETE FROM ${this.#table} WHERE collection = ${p.add( collection )} AND id = ${p.add( id )}`, p.values );

                return res.rowCount > 0;
            } );
        } );
    }

    public async list<T = Record<string, unknown>>( collection: string, filter?: Record<string, unknown>, options?: DocStoreOperationOptions ): Promise<T[]>
    {
        assertScalarFilter( filter );

        return this.#instrument.run( 'list', options?.context, { collection }, async ( ctx ) =>
        {
            this.#instrument.spend( 'doc_read', 1, 'operations', ctx );

            return this.#exec( 'list', async () =>
            {
                const p = new SqlParams( this.#dialect );
                let sql = `SELECT ${this.#dialect.jsonSelect( 'doc' )} AS doc FROM ${this.#table} WHERE collection = ${p.add( collection )}`;

                for( const [ key, value ] of Object.entries( filter ?? {} ) )
                {
                    sql += ` AND ${this.#dialect.jsonEquals( p, 'doc', key, value as Scalar )}`;
                }

                const res = await this.#client.query<{ doc: string }>( sql, p.values );

                return res.rows.map( ( row ) => {return JSON.parse( row.doc ) as T;} );
            } );
        } );
    }

    public async count( collection: string ): Promise<number>
    {
        return this.#exec( 'count', async () =>
        {
            const p = new SqlParams( this.#dialect );
            const res = await this.#client.query<{ n: number | string }>( `SELECT COUNT(*) AS n FROM ${this.#table} WHERE collection = ${p.add( collection )}`, p.values );

            return Number( res.rows[0]?.n ?? 0 );
        } );
    }

    public async clear( collection?: string ): Promise<void>
    {
        await this.#exec( 'clear', async () =>
        {
            if( collection === undefined )
            {
                await this.#client.query( `DELETE FROM ${this.#table}`, [] );

                return;
            }

            const p = new SqlParams( this.#dialect );

            await this.#client.query( `DELETE FROM ${this.#table} WHERE collection = ${p.add( collection )}`, p.values );
        } );
    }

    async #exec<R>( operation: string, fn: () => Promise<R> ): Promise<R>
    {
        try
        {
            return await fn();
        }
        catch( err )
        {
            throw wrapStorageError( this.#dialect.name, `doc.${operation}`, err );
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Cache store                                                               */
/* -------------------------------------------------------------------------- */

export interface SqlCacheStoreOptions extends StorageInstrumentOptions
{
    /** Cache table. Default `ai_cache`. */
    table?             : string
    defaultTTLSeconds? : number
    /** Clock in epoch milliseconds (injectable for tests). Expiry is evaluated by the application, never by the database clock. */
    now?               : () => number
    /** Not supported by SQL caches; passing it throws so LRU capacity is never silently assumed. */
    maxEntries?        : never
}

/**
 * Durable `ICacheStore` on any `SqlClient`. Entries carry an `expires_at` epoch-ms column; reads and `has`/`size`
 * ignore expired rows, and `purgeExpired()` physically removes them. There is no LRU capacity (`maxEntries` is rejected).
 */
export class SqlCacheStore implements ICacheStore
{
    readonly #client     : SqlClient;
    readonly #dialect    : SqlDialect;
    readonly #table      : string;
    readonly #ttl?       : number;
    readonly #now        : () => number;
    readonly #instrument : StorageInstrument;

    constructor( client: SqlClient, dialect: SqlDialect, options: SqlCacheStoreOptions = {} )
    {
        if( ( options as { maxEntries?: unknown } ).maxEntries !== undefined )
        {
            throw new InvalidInputError( 'maxEntries is not supported by SQL cache stores (no LRU eviction); use purgeExpired() or a TTL instead' );
        }

        this.#table = assertIdentifier( options.table ?? 'ai_cache', 'table name' );
        this.#client = client;
        this.#dialect = dialect;
        this.#ttl = options.defaultTTLSeconds;
        this.#now = options.now ?? ( () => {return Date.now();} );
        this.#instrument = new StorageInstrument( 'cache', options );
    }

    /** Idempotent `CREATE TABLE IF NOT EXISTS` plus an index on `expires_at`. */
    public async ensureSchema(): Promise<void>
    {
        await this.#exec( 'ensureSchema', async () =>
        {
            await this.#client.query(
                `CREATE TABLE IF NOT EXISTS ${this.#table} ( key TEXT PRIMARY KEY, value ${this.#dialect.jsonType} NOT NULL, expires_at ${this.#dialect.bigintType} )`,
                []
            );
            await this.#client.query( `CREATE INDEX IF NOT EXISTS ${this.#table}_expires_idx ON ${this.#table} ( expires_at )`, [] );
        } );
    }

    public async get<T>( key: string, options?: CacheStoreOperationOptions ): Promise<T | null>
    {
        return this.#instrument.run( 'get', options?.context, undefined, async ( ctx ) =>
        {
            this.#instrument.spend( 'cache_read', 1, 'operations', ctx );

            return this.#exec( 'get', async () =>
            {
                const p = new SqlParams( this.#dialect );
                const res = await this.#client.query<{ value: string }>(
                    `SELECT ${this.#dialect.jsonSelect( 'value' )} AS value FROM ${this.#table} WHERE key = ${p.add( key )} AND ${this.#alive( p )}`,
                    p.values
                );

                return res.rows.length > 0 ? JSON.parse( res.rows[0].value ) as T : null;
            } );
        } );
    }

    public async set<T>( key: string, value: T, ttlSeconds?: number, options?: CacheStoreOperationOptions ): Promise<void>
    {
        const json = toJson( value, 'value' );
        const ttl = ttlSeconds ?? this.#ttl;

        return this.#instrument.run( 'set', options?.context, undefined, async ( ctx ) =>
        {
            await this.#exec( 'set', async () =>
            {
                const p = new SqlParams( this.#dialect );

                if( ttl !== undefined && ttl <= 0 )
                {
                    // Already expired: the write must still replace (i.e. remove) any previous value.
                    await this.#client.query( `DELETE FROM ${this.#table} WHERE key = ${p.add( key )}`, p.values );

                    return;
                }

                const expiresAt = ttl === undefined ? null : this.#now() + Math.ceil( ttl * 1000 );

                await this.#client.query(
                    `INSERT INTO ${this.#table} ( key, value, expires_at ) VALUES ( ${p.add( key )}, ${this.#dialect.jsonParam( p.add( json ) )}, ${p.add( expiresAt )} ) ON CONFLICT ( key ) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
                    p.values
                );
            } );
            this.#instrument.spend( 'cache_write', 1, 'operations', ctx );
        } );
    }

    public async delete( key: string, options?: CacheStoreOperationOptions ): Promise<boolean>
    {
        return this.#instrument.run( 'delete', options?.context, undefined, async ( ctx ) =>
        {
            const deleted = await this.#exec( 'delete', async () =>
            {
                const p = new SqlParams( this.#dialect );
                const res = await this.#client.query<{ expires_at: number | string | null }>(
                    `DELETE FROM ${this.#table} WHERE key = ${p.add( key )} RETURNING expires_at`,
                    p.values
                );
                const now = this.#now();

                return res.rows.some( ( row ) => {return row.expires_at === null || Number( row.expires_at ) >= now;} );
            } );

            if( deleted )
            {
                this.#instrument.spend( 'cache_write', 1, 'operations', ctx );
            }

            return deleted;
        } );
    }

    public async has( key: string ): Promise<boolean>
    {
        return this.#exec( 'has', async () =>
        {
            const p = new SqlParams( this.#dialect );
            const res = await this.#client.query( `SELECT 1 AS present FROM ${this.#table} WHERE key = ${p.add( key )} AND ${this.#alive( p )}`, p.values );

            return res.rows.length > 0;
        } );
    }

    public async clear(): Promise<void>
    {
        await this.#exec( 'clear', async () =>
        {
            await this.#client.query( `DELETE FROM ${this.#table}`, [] );
        } );
    }

    public async size(): Promise<number>
    {
        return this.#exec( 'size', async () =>
        {
            const p = new SqlParams( this.#dialect );
            const res = await this.#client.query<{ n: number | string }>( `SELECT COUNT(*) AS n FROM ${this.#table} WHERE ${this.#alive( p )}`, p.values );

            return Number( res.rows[0]?.n ?? 0 );
        } );
    }

    /** Physically removes expired rows and returns how many were deleted. */
    public async purgeExpired(): Promise<number>
    {
        return this.#exec( 'purgeExpired', async () =>
        {
            const p = new SqlParams( this.#dialect );
            const res = await this.#client.query( `DELETE FROM ${this.#table} WHERE expires_at IS NOT NULL AND expires_at < ${p.add( this.#now() )}`, p.values );

            return res.rowCount;
        } );
    }

    #alive( p: SqlParams ): string
    {
        return `( expires_at IS NULL OR expires_at >= ${p.add( this.#now() )} )`;
    }

    async #exec<R>( operation: string, fn: () => Promise<R> ): Promise<R>
    {
        try
        {
            return await fn();
        }
        catch( err )
        {
            throw wrapStorageError( this.#dialect.name, `cache.${operation}`, err );
        }
    }
}
