import { InvalidInputError } from '../../core/error.js';
import type { CacheStoreOperationOptions, ICacheStore } from '../cache.js';
import type { ConditionalWriteResult, DocStoreOperationOptions, IDocumentStore } from '../document.js';
import { StorageError, wrapStorageError } from '../errors.js';
import { StorageInstrument } from '../instrument.js';
import type { StorageInstrumentOptions } from '../instrument.js';
import { assertScalarFilter, toJson } from '../json.js';

/* -------------------------------------------------------------------------- */
/*  Client contract                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The only thing Redis adapters need from a driver. All multi-step mutations run as single Lua scripts (`EVAL`),
 * so no set or transaction commands are required. The caller owns connections, retries and closing.
 */
export interface RedisClient
{
    eval( script: string, keys: string[], args: string[] ): Promise<unknown>
    get( key: string ): Promise<string | null>
    exists( keys: string[] ): Promise<number>
}

/** Structural subset of `ioredis`. */
export interface IoRedisLike
{
    eval( script: string, numKeys: number, ...keysAndArgs: string[] ): Promise<unknown>
    get( key: string ): Promise<string | null>
    exists( ...keys: string[] ): Promise<number>
}

/** Structural subset of `redis` (node-redis v4+). */
export interface NodeRedisLike
{
    eval( script: string, options: { keys: string[], arguments: string[] } ): Promise<unknown>
    get( key: string ): Promise<string | null>
    exists( keys: string[] ): Promise<number>
}

export function fromIoRedis( client: IoRedisLike ): RedisClient
{
    return {
        eval   : ( script, keys, args ) => {return client.eval( script, keys.length, ...keys, ...args );},
        get    : ( key ) => {return client.get( key );},
        exists : ( keys ) => {return client.exists( ...keys );}
    };
}

export function fromNodeRedis( client: NodeRedisLike ): RedisClient
{
    return {
        eval   : ( script, keys, args ) => {return client.eval( script, { keys, arguments : args } );},
        get    : ( key ) => {return client.get( key );},
        exists : ( keys ) => {return client.exists( keys );}
    };
}

/* -------------------------------------------------------------------------- */
/*  Lua scripts                                                               */
/* -------------------------------------------------------------------------- */

const VERSION_OF = 'tonumber(string.match(cur, \'^{"version":(%d+)\'))';

/**
 * Every script is single-key for the document itself; the per-collection index and registry are best-effort extras
 * (documented limitation: not Redis Cluster safe because they touch keys that hash to other slots).
 * Documents are stored as `{"version":N,"doc":<json>}`; the version is always first so scripts parse it with a pattern
 * and never re-encode the document.
 */
export const REDIS_SCRIPTS =
    {
    /** KEYS: doc, index, registry. ARGV: json, encodedId, encodedCollection. Returns the new version. */
        docSet : `
local cur = redis.call('GET', KEYS[1])
local v = 1
if cur then v = ${VERSION_OF} + 1 end
redis.call('SET', KEYS[1], '{"version":' .. string.format('%d', v) .. ',"doc":' .. ARGV[1] .. '}')
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
return v`,

        /** KEYS: doc, index, registry. ARGV: json, encodedId, encodedCollection, expectedVersion ('' = create-only). Returns {written, version}. */
        docCas : `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = ${VERSION_OF} end
if ARGV[4] == '' then
  if cur then return {0, v} end
else
  if (not cur) or v ~= tonumber(ARGV[4]) then return {0, v} end
end
v = v + 1
redis.call('SET', KEYS[1], '{"version":' .. string.format('%d', v) .. ',"doc":' .. ARGV[1] .. '}')
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
return {1, v}`,

        /** KEYS: doc, index, registry. ARGV: encodedId, encodedCollection. Returns 1 when a document was removed. */
        docDelete : `
local n = redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
if redis.call('SCARD', KEYS[2]) == 0 then redis.call('SREM', KEYS[3], ARGV[2]) end
return n`,

        /** KEYS: index. ARGV: docKeyPrefix. Returns every stored envelope of the collection (O(n)). */
        docList : `
local ids = redis.call('SMEMBERS', KEYS[1])
local out = {}
for _, id in ipairs(ids) do
  local d = redis.call('GET', ARGV[1] .. id)
  if d then out[#out + 1] = d else redis.call('SREM', KEYS[1], id) end
end
return out`,

        /** KEYS: index. */
        docCount : 'return redis.call(\'SCARD\', KEYS[1])',

        /** KEYS: index, registry. ARGV: docKeyPrefix, encodedCollection. */
        docClear : `
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', ARGV[1] .. id) end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[2])
return #ids`,

        /** KEYS: registry. */
        docCollections : 'return redis.call(\'SMEMBERS\', KEYS[1])',

        /** KEYS: key, index. ARGV: json, encodedKey, px ('' = no expiry). */
        cacheSet : `
if ARGV[3] == '' then redis.call('SET', KEYS[1], ARGV[1]) else redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3]) end
redis.call('SADD', KEYS[2], ARGV[2])
return 1`,

        /** KEYS: key, index. ARGV: encodedKey. Returns 1 when a live entry was removed. */
        cacheDelete : `
local n = redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return n`,

        /** KEYS: index. ARGV: keyPrefix. Counts live entries and prunes expired members from the index. */
        cacheSize : `
local ids = redis.call('SMEMBERS', KEYS[1])
local n = 0
for _, id in ipairs(ids) do
  if redis.call('EXISTS', ARGV[1] .. id) == 1 then n = n + 1 else redis.call('SREM', KEYS[1], id) end
end
return n`,

        /** KEYS: index. ARGV: keyPrefix. */
        cacheClear : `
local ids = redis.call('SMEMBERS', KEYS[1])
for _, id in ipairs(ids) do redis.call('DEL', ARGV[1] .. id) end
redis.call('DEL', KEYS[1])
return #ids`
    } as const;

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

const PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,126}$/;

function assertPrefix( value: unknown ): string
{
    if( typeof value !== 'string' || !PREFIX_RE.test( value ) )
    {
        throw new InvalidInputError( `Invalid Redis key prefix ${JSON.stringify( value )}: must match ${PREFIX_RE}`, { value } );
    }

    return value;
}

const enc = encodeURIComponent;

/* -------------------------------------------------------------------------- */
/*  Document store                                                            */
/* -------------------------------------------------------------------------- */

export interface RedisDocStoreOptions extends StorageInstrumentOptions
{
    /** Key prefix. Default `ai`. */
    prefix? : string
}

interface Envelope<T>
{
    version : number
    doc     : T
}

/**
 * Durable `IDocumentStore` on Redis. Documents live under `<prefix>:doc:<collection>:<id>` (both URI-encoded) as
 * `{version, doc}` JSON. Compare-and-swap is a single `EVAL`. Each collection keeps a `SET` index so `list`, `count`
 * and `clear` work without `SCAN`; `list` is O(n) and the index is best-effort (not Redis Cluster safe).
 */
export class RedisDocStore implements IDocumentStore
{
    readonly #client     : RedisClient;
    readonly #prefix     : string;
    readonly #instrument : StorageInstrument;

    constructor( client: RedisClient, options: RedisDocStoreOptions = {} )
    {
        this.#prefix = assertPrefix( options.prefix ?? 'ai' );
        this.#client = client;
        this.#instrument = new StorageInstrument( 'doc', options );
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
                const raw = await this.#client.get( this.#docKey( collection, id ) );

                if( raw === null ){return null;}

                const env = JSON.parse( raw ) as Envelope<T>;

                return { doc : env.doc, version : Number( env.version ) };
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
                await this.#client.eval(
                    REDIS_SCRIPTS.docSet,
                    [ this.#docKey( collection, id ), this.#indexKey( collection ), this.#registryKey() ],
                    [ json, enc( id ), enc( collection ) ]
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

        if( expected !== null && ( !Number.isSafeInteger( expected ) || expected < 0 ) )
        {
            throw new InvalidInputError( `expectedVersion must be null or a non-negative safe integer, got ${expected}` );
        }

        return this.#instrument.run( 'conditionalWrite', options.context, { collection, id }, async ( ctx ) =>
        {
            const result = await this.#exec( 'conditionalWrite', async () =>
            {
                const res = await this.#client.eval(
                    REDIS_SCRIPTS.docCas,
                    [ this.#docKey( collection, id ), this.#indexKey( collection ), this.#registryKey() ],
                    [ json, enc( id ), enc( collection ), expected === null ? '' : String( expected ) ]
                );

                if( !Array.isArray( res ) || res.length !== 2 )
                {
                    throw new StorageError( 'redis', 'doc.conditionalWrite', `unexpected script reply ${JSON.stringify( res )}` );
                }

                return { written : Number( res[0] ) === 1, version : Number( res[1] ) };
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
                const res = await this.#client.eval(
                    REDIS_SCRIPTS.docDelete,
                    [ this.#docKey( collection, id ), this.#indexKey( collection ), this.#registryKey() ],
                    [ enc( id ), enc( collection ) ]
                );

                return Number( res ) > 0;
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
                const raw = await this.#client.eval( REDIS_SCRIPTS.docList, [ this.#indexKey( collection ) ], [ this.#docKeyPrefix( collection ) ] );
                const rows = ( Array.isArray( raw ) ? raw : [] ) as string[];
                const out: T[] = [];

                for( const text of rows )
                {
                    const doc = ( JSON.parse( text ) as Envelope<Record<string, unknown>> ).doc;

                    if( Object.entries( filter ?? {} ).every( ( [ k, v ] ) => {return doc[k] === v;} ) )
                    {
                        out.push( doc as T );
                    }
                }

                return out;
            } );
        } );
    }

    public async count( collection: string ): Promise<number>
    {
        return this.#exec( 'count', async () =>
        {
            return Number( await this.#client.eval( REDIS_SCRIPTS.docCount, [ this.#indexKey( collection ) ], [] ) );
        } );
    }

    public async clear( collection?: string ): Promise<void>
    {
        await this.#exec( 'clear', async () =>
        {
            const names = collection === undefined
                ? ( await this.#client.eval( REDIS_SCRIPTS.docCollections, [ this.#registryKey() ], [] ) as string[] ).map( ( n ) => {return decodeURIComponent( n );} )
                : [ collection ];

            for( const name of names )
            {
                await this.#client.eval(
                    REDIS_SCRIPTS.docClear,
                    [ this.#indexKey( name ), this.#registryKey() ],
                    [ this.#docKeyPrefix( name ), enc( name ) ]
                );
            }
        } );
    }

    #docKeyPrefix( collection: string ): string
    {
        return `${this.#prefix}:doc:${enc( collection )}:`;
    }

    #docKey( collection: string, id: string ): string
    {
        return `${this.#docKeyPrefix( collection )}${enc( id )}`;
    }

    #indexKey( collection: string ): string
    {
        return `${this.#prefix}:idx:${enc( collection )}`;
    }

    #registryKey(): string
    {
        return `${this.#prefix}:collections`;
    }

    async #exec<R>( operation: string, fn: () => Promise<R> ): Promise<R>
    {
        try
        {
            return await fn();
        }
        catch( err )
        {
            throw wrapStorageError( 'redis', `doc.${operation}`, err );
        }
    }
}

/* -------------------------------------------------------------------------- */
/*  Cache store                                                               */
/* -------------------------------------------------------------------------- */

export interface RedisCacheStoreOptions extends StorageInstrumentOptions
{
    /** Key prefix. Default `ai`. */
    prefix?            : string
    defaultTTLSeconds? : number
    /** Not supported by Redis caches (use a Redis `maxmemory-policy`); passing it throws. */
    maxEntries?        : never
}

/**
 * Durable `ICacheStore` on Redis. TTL uses native `PX`, so Redis expires entries itself. A member index
 * (`<prefix>:cache-index`) backs `size` and `clear`; it is pruned lazily by `size`. There is no LRU capacity.
 */
export class RedisCacheStore implements ICacheStore
{
    readonly #client     : RedisClient;
    readonly #prefix     : string;
    readonly #ttl?       : number;
    readonly #instrument : StorageInstrument;

    constructor( client: RedisClient, options: RedisCacheStoreOptions = {} )
    {
        if( ( options as { maxEntries?: unknown } ).maxEntries !== undefined )
        {
            throw new InvalidInputError( 'maxEntries is not supported by Redis cache stores; configure a Redis maxmemory-policy instead' );
        }

        this.#prefix = assertPrefix( options.prefix ?? 'ai' );
        this.#client = client;
        this.#ttl = options.defaultTTLSeconds;
        this.#instrument = new StorageInstrument( 'cache', options );
    }

    public async get<T>( key: string, options?: CacheStoreOperationOptions ): Promise<T | null>
    {
        return this.#instrument.run( 'get', options?.context, undefined, async ( ctx ) =>
        {
            this.#instrument.spend( 'cache_read', 1, 'operations', ctx );

            return this.#exec( 'get', async () =>
            {
                const raw = await this.#client.get( this.#key( key ) );

                return raw === null ? null : JSON.parse( raw ) as T;
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
                if( ttl !== undefined && ttl <= 0 )
                {
                    // Redis rejects a non-positive PX; the write is already expired, so it only removes the old value.
                    await this.#client.eval( REDIS_SCRIPTS.cacheDelete, [ this.#key( key ), this.#indexKey() ], [ enc( key ) ] );

                    return;
                }

                await this.#client.eval(
                    REDIS_SCRIPTS.cacheSet,
                    [ this.#key( key ), this.#indexKey() ],
                    [ json, enc( key ), ttl === undefined ? '' : String( Math.ceil( ttl * 1000 ) ) ]
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
                return Number( await this.#client.eval( REDIS_SCRIPTS.cacheDelete, [ this.#key( key ), this.#indexKey() ], [ enc( key ) ] ) ) > 0;
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
        return this.#exec( 'has', async () => {return Number( await this.#client.exists( [ this.#key( key ) ] ) ) > 0;} );
    }

    public async clear(): Promise<void>
    {
        await this.#exec( 'clear', async () =>
        {
            await this.#client.eval( REDIS_SCRIPTS.cacheClear, [ this.#indexKey() ], [ this.#keyPrefix() ] );
        } );
    }

    public async size(): Promise<number>
    {
        return this.#exec( 'size', async () =>
        {
            return Number( await this.#client.eval( REDIS_SCRIPTS.cacheSize, [ this.#indexKey() ], [ this.#keyPrefix() ] ) );
        } );
    }

    #keyPrefix(): string
    {
        return `${this.#prefix}:cache:`;
    }

    #key( key: string ): string
    {
        return `${this.#keyPrefix()}${enc( key )}`;
    }

    #indexKey(): string
    {
        return `${this.#prefix}:cache-index`;
    }

    async #exec<R>( operation: string, fn: () => Promise<R> ): Promise<R>
    {
        try
        {
            return await fn();
        }
        catch( err )
        {
            throw wrapStorageError( 'redis', `cache.${operation}`, err );
        }
    }
}
