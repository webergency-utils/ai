/* eslint-disable @typescript-eslint/no-explicit-any -- optional drivers are loaded dynamically and untyped */
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import
{
    MemoryDocStore,
    MemoryVectorStore,
    MemoryCacheStore,
    MemoryFileStore,
    LocalDiskFileStore,
    SqliteDocStore,
    SqliteCacheStore,
    PostgresDocStore,
    PostgresCacheStore,
    fromNodeSqlite,
    fromPg,
    fromIoRedis,
    RedisDocStore,
    RedisCacheStore,
    PgVectorStore,
    S3FileStore
} from '../../src/storage/index.js';
import type { IDocumentStore, IVectorStore, ICacheStore, IFileStore, SqlClient } from '../../src/storage/index.js';
import type { CacheContractOptions } from './contract/cache.contract.js';
import type { FileContractOptions } from './contract/file.contract.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './contract/shared.js';
import { uniqueName } from './contract/shared.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { FakeS3 } from '../helpers/fake-s3.js';
import { VECTOR_CONTRACT_DIMENSIONS } from './contract/vector.contract.js';

export interface BackendEntry<T, O extends ContractOptions = ContractOptions>
{
    name     : string
    factory  : ContractFactory<T>
    options? : O
}

/* -------------------------------------------------------------------------- */
/*  Environment gating                                                        */
/* -------------------------------------------------------------------------- */

export const POSTGRES_URL = process.env.TEST_POSTGRES_URL;
export const REDIS_URL = process.env.TEST_REDIS_URL;
export const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
export const S3_ACCESS_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID;
export const S3_SECRET_ACCESS_KEY = process.env.TEST_S3_SECRET_ACCESS_KEY;
export const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'ai-storage-test';
export const S3_REGION = process.env.TEST_S3_REGION ?? 'us-east-1';
export const S3_CONFIGURED = Boolean( S3_ENDPOINT && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY );

/** Loads an optional driver by name; integration suites install drivers ad hoc, the package never depends on them. */
export async function loadDriver( name: string ): Promise<any>
{
    try
    {
        return await import( /* @vite-ignore */ name );
    }
    catch( err )
    {
        throw new Error( `Integration tests need the '${name}' package (npm install --no-save ${name}): ${( err as Error ).message}`, { cause : err } );
    }
}

const closers: Array<() => Promise<void>> = [];

/** Closes every shared client opened by env-gated factories. Call from `afterAll`. */
export async function closeBackends(): Promise<void>
{
    await Promise.all( closers.splice( 0 ).map( ( close ) => {return close();} ) );
}

/** Virtual clock: freezes `Date` through vitest so TTL tests do not sleep. */
function fakeClock(): Pick<ContractHandle<unknown>, 'advanceTime' | 'dispose'>
{
    vi.useFakeTimers( { toFake : [ 'Date' ] } );

    return {
        advanceTime : async ( ms ) => {vi.setSystemTime( Date.now() + ms );},
        dispose     : async () => {vi.useRealTimers();}
    };
}

/* -------------------------------------------------------------------------- */
/*  SQLite (node:sqlite, Node >= 22.5)                                        */
/* -------------------------------------------------------------------------- */

let DatabaseSync: ( new ( location: string ) => Parameters<typeof fromNodeSqlite>[0] ) | undefined;

try
{
    DatabaseSync = ( await import( /* @vite-ignore */ 'node:sqlite' ) ).DatabaseSync as typeof DatabaseSync;
}
catch
{
    DatabaseSync = undefined;
}

export const SQLITE_AVAILABLE = DatabaseSync !== undefined;

export function sqliteClient(): SqlClient
{
    return fromNodeSqlite( new DatabaseSync!( ':memory:' ) );
}

/* -------------------------------------------------------------------------- */
/*  Postgres                                                                  */
/* -------------------------------------------------------------------------- */

let pgPool: Promise<any> | undefined;

export function postgresClient(): Promise<{ client: SqlClient, pool: any }>
{
    pgPool ??= loadDriver( 'pg' ).then( ( pg ) =>
    {
        const Pool = pg.default?.Pool ?? pg.Pool;
        const pool = new Pool( { connectionString : POSTGRES_URL, max : 10 } );

        closers.push( () => {return pool.end();} );

        return pool;
    } );

    return pgPool.then( ( pool ) => {return { client : fromPg( pool ), pool };} );
}

/* -------------------------------------------------------------------------- */
/*  Redis                                                                     */
/* -------------------------------------------------------------------------- */

let redisConn: Promise<any> | undefined;

/** Shared ioredis connection plus a per-test key prefix and a cleanup that removes everything under it. */
export async function redisHandle(): Promise<{ client: ReturnType<typeof fromIoRedis>, prefix: string, cleanup: () => Promise<void> }>
{
    redisConn ??= loadDriver( 'ioredis' ).then( ( mod ) =>
    {
        const Redis = mod.default ?? mod.Redis;
        const conn = new Redis( REDIS_URL );

        closers.push( async () => {await conn.quit();} );

        return conn;
    } );

    const conn = await redisConn;
    const prefix = uniqueName( 'ai' );

    return {
        client  : fromIoRedis( conn ),
        prefix,
        cleanup : async () =>
        {
            const keys: string[] = await conn.keys( `${prefix}:*` );

            if( keys.length > 0 ){await conn.del( ...keys );}
        }
    };
}

/* -------------------------------------------------------------------------- */
/*  S3                                                                        */
/* -------------------------------------------------------------------------- */

/** Wraps a file store so everything a test writes is removed on dispose (object stores cannot be dropped like tables). */
function trackedFileStore( inner: IFileStore ): { store: IFileStore, cleanup: () => Promise<void> }
{
    const written = new Set<string>();
    const store: IFileStore =
        {
            write       : async ( p, c, o ) => {written.add( p ); return inner.write( p, c, o );},
            read        : ( p, o ) => {return inner.read( p, o );},
            readStream  : ( p, o ) => {return inner.readStream( p, o );},
            delete      : ( p, o ) => {return inner.delete( p, o );},
            exists      : ( p ) => {return inner.exists( p );},
            getMetadata : ( p ) => {return inner.getMetadata( p );}
        };

    return { store, cleanup : async () => {await Promise.all( [ ...written ].map( ( p ) => {return inner.delete( p ).catch( () => {return false;} );} ) );} };
}

/* -------------------------------------------------------------------------- */
/*  Backend registries                                                        */
/* -------------------------------------------------------------------------- */

export const documentBackends: Array<BackendEntry<IDocumentStore>> =
    [
        { name : 'MemoryDocStore', factory : () => {return { store : new MemoryDocStore() };} },
        {
            name    : 'SqliteDocStore (node:sqlite)',
            options : { skip : !SQLITE_AVAILABLE },
            factory : async () =>
            {
                const store = new SqliteDocStore( sqliteClient() );

                await store.ensureSchema();

                return { store };
            }
        },
        {
            name    : 'RedisDocStore (fake client)',
            factory : () => {return { store : new RedisDocStore( new FakeRedis() ) };}
        },
        {
            name    : 'RedisDocStore',
            options : { skip : !REDIS_URL },
            factory : async () =>
            {
                const { client, prefix, cleanup } = await redisHandle();

                return { store : new RedisDocStore( client, { prefix } ), dispose : cleanup };
            }
        },
        {
            name    : 'PostgresDocStore',
            options : { skip : !POSTGRES_URL },
            factory : async () =>
            {
                const { client, pool } = await postgresClient();
                const table = uniqueName( 'docs' );
                const store = new PostgresDocStore( client, { table } );

                await store.ensureSchema();

                return { store, dispose : async () => {await pool.query( `DROP TABLE IF EXISTS ${table}` );} };
            }
        }
    ];

export const vectorBackends: Array<BackendEntry<IVectorStore>> =
    [
        {
            name    : 'MemoryVectorStore',
            factory : () => {return { store : new MemoryVectorStore( { dimensions : VECTOR_CONTRACT_DIMENSIONS } ) };}
        },
        {
            name    : 'PgVectorStore',
            options : { skip : !POSTGRES_URL },
            factory : async () =>
            {
                const { client, pool } = await postgresClient();
                const table = uniqueName( 'vec' );
                const store = new PgVectorStore( client, { table, dimensions : VECTOR_CONTRACT_DIMENSIONS } );

                await store.ensureSchema();

                return { store, dispose : async () => {await pool.query( `DROP TABLE IF EXISTS ${table}` );} };
            }
        }
    ];

export const cacheBackends: Array<BackendEntry<ICacheStore, CacheContractOptions>> =
    [
        {
            name    : 'MemoryCacheStore',
            options : { lenientValues : true },
            factory : () => {return { store : new MemoryCacheStore(), ...fakeClock() };}
        },
        {
            name    : 'SqliteCacheStore (node:sqlite)',
            options : { skip : !SQLITE_AVAILABLE },
            factory : async () =>
            {
                const clock = fakeClock();
                const store = new SqliteCacheStore( sqliteClient() );

                await store.ensureSchema();

                return { store, ...clock };
            }
        },
        {
            name    : 'RedisCacheStore (fake client)',
            factory : () => {return { store : new RedisCacheStore( new FakeRedis() ), ...fakeClock() };}
        },
        {
            name    : 'RedisCacheStore',
            options : { skip : !REDIS_URL },
            factory : async () =>
            {
                const { client, prefix, cleanup } = await redisHandle();

                return { store : new RedisCacheStore( client, { prefix } ), dispose : cleanup };
            }
        },
        {
            name    : 'PostgresCacheStore',
            options : { skip : !POSTGRES_URL },
            factory : async () =>
            {
                const { client, pool } = await postgresClient();
                const table = uniqueName( 'cache' );
                const store = new PostgresCacheStore( client, { table } );

                await store.ensureSchema();

                return { store, dispose : async () => {await pool.query( `DROP TABLE IF EXISTS ${table}` );} };
            }
        }
    ];

export const fileBackends: Array<BackendEntry<IFileStore, FileContractOptions>> =
    [
        { name : 'MemoryFileStore', factory : () => {return { store : new MemoryFileStore() };} },
        {
            name    : 'S3FileStore (fake S3)',
            options : { enforcesPaths : true },
            factory : () =>
            {
                const fake = new FakeS3();

                return {
                    store : new S3FileStore( { endpoint : 'http://fake-s3.test', region : 'us-east-1', bucket : 'test-bucket', credentials : fake.credentials, fetch : fake.fetch, multipartThresholdBytes : 5, partSizeBytes : 4 } )
                };
            }
        },
        {
            name    : 'S3FileStore',
            options : { enforcesPaths : true, skip : !S3_CONFIGURED },
            factory : () =>
            {
                const { store, cleanup } = trackedFileStore( new S3FileStore( {
                    endpoint                : S3_ENDPOINT,
                    region                  : S3_REGION,
                    bucket                  : S3_BUCKET,
                    prefix                  : uniqueName( 'contract' ),
                    credentials             : { accessKeyId : S3_ACCESS_KEY_ID!, secretAccessKey : S3_SECRET_ACCESS_KEY! },
                    multipartThresholdBytes : 5 * 1024 * 1024
                } ) );

                return { store, dispose : cleanup };
            }
        },
        {
            name    : 'LocalDiskFileStore',
            options : { enforcesPaths : true },
            factory : async () =>
            {
                const dir = await fsPromises.mkdtemp( path.join( os.tmpdir(), 'ai-contract-disk-' ) );

                return {
                    store   : new LocalDiskFileStore( dir ),
                    dispose : async () => {await fsPromises.rm( dir, { recursive : true, force : true } );}
                };
            }
        }
    ];
