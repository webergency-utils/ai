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
    RedisCacheStore
} from '../../src/storage/index.js';
import type { IDocumentStore, IVectorStore, ICacheStore, IFileStore, SqlClient } from '../../src/storage/index.js';
import type { CacheContractOptions } from './contract/cache.contract.js';
import type { FileContractOptions } from './contract/file.contract.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './contract/shared.js';
import { uniqueName } from './contract/shared.js';
import { FakeRedis } from '../helpers/fake-redis.js';
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
