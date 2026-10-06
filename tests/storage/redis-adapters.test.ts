import { describe, it, expect } from 'vitest';
import
{
    RedisDocStore,
    RedisCacheStore,
    REDIS_SCRIPTS,
    fromIoRedis,
    fromNodeRedis,
    StorageError
} from '../../src/storage/index.js';
import type { RedisClient } from '../../src/storage/index.js';
import { InvalidInputError } from '../../src/core/error.js';
import { FakeRedis } from '../helpers/fake-redis.js';

describe( 'Redis Lua scripts', () =>
{
    it( 'have balanced blocks and only use supported commands', () =>
    {
        for( const [ name, script ] of Object.entries( REDIS_SCRIPTS ) )
        {
            const body = script.replace( /'[^']*'/g, '\'\'' );
            const opens = ( body.match( /\b(if|for|function)\b/g ) ?? [] ).length;
            const closes = ( body.match( /\bend\b/g ) ?? [] ).length;

            expect( closes, name ).toBe( opens );

            const commands = [ ...script.matchAll( /redis\.call\('([A-Z]+)'/g ) ].map( ( m ) => {return m[1];} );

            for( const c of commands )
            {
                expect( [ 'GET', 'SET', 'DEL', 'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'EXISTS' ], `${name}: ${c}` ).toContain( c );
            }
        }
    } );

    it( 'never re-encode the stored document (version prefix is parsed with a pattern)', () =>
    {
        expect( REDIS_SCRIPTS.docSet ).not.toContain( 'cjson' );
        expect( REDIS_SCRIPTS.docCas ).not.toContain( 'cjson' );
        expect( REDIS_SCRIPTS.docSet ).toContain( 'string.match' );
    } );
} );

describe( 'RedisDocStore against a fake client', () =>
{
    it( 'validates the prefix at construction (R6)', () =>
    {
        for( const bad of [ '', '1abc', 'has space', 'semi;colon', 'x'.repeat( 128 ) ] )
        {
            expect( () => {return new RedisDocStore( new FakeRedis(), { prefix : bad } );}, bad ).toThrow( InvalidInputError );
            expect( () => {return new RedisCacheStore( new FakeRedis(), { prefix : bad } );}, bad ).toThrow( InvalidInputError );
        }

        expect( () => {return new RedisDocStore( new FakeRedis(), { prefix : 'my-app:ai.v1' } );} ).not.toThrow();
    } );

    it( 'runs CAS as exactly one EVAL with declared keys and ordered arguments (R7)', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis, { prefix : 'p' } );

        await store.conditionalWrite( 'my col', 'a/b', { x : 1 }, { expectedVersion : null } );
        await store.conditionalWrite( 'my col', 'a/b', { x : 2 }, { expectedVersion : 1 } );

        expect( redis.calls ).toHaveLength( 2 );
        expect( redis.calls[0].script ).toBe( REDIS_SCRIPTS.docCas );
        expect( redis.calls[0].keys ).toEqual( [ 'p:doc:my%20col:a%2Fb', 'p:idx:my%20col', 'p:collections' ] );
        expect( redis.calls[0].args ).toEqual( [ '{"x":1}', 'a%2Fb', 'my%20col', '' ] );
        expect( redis.calls[1].args[3] ).toBe( '1' );
    } );

    it( 'stores {version, doc} envelopes with the version first', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis, { prefix : 'p' } );

        await store.set( 'c', 'i', { a : [ 1 ] } );
        await store.set( 'c', 'i', { a : [ 2 ] } );

        expect( await redis.get( 'p:doc:c:i' ) ).toBe( '{"version":2,"doc":{"a":[2]}}' );
    } );

    it( 'does not let colons in collection or id alias other documents', async () =>
    {
        const store = new RedisDocStore( new FakeRedis() );

        await store.set( 'a:b', 'c', { which : 1 } );
        await store.set( 'a', 'b:c', { which : 2 } );

        expect( await store.get( 'a:b', 'c' ) ).toEqual( { which : 1 } );
        expect( await store.get( 'a', 'b:c' ) ).toEqual( { which : 2 } );
        expect( await store.count( 'a' ) ).toBe( 1 );
    } );

    it( 'clear() removes every collection through the registry, including odd names', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis, { prefix : 'p' } );

        await store.set( 'a:b', '1', {} );
        await store.set( 'ünï', '2', {} );
        await store.clear();

        expect( redis.keys() ).toEqual( [] );
    } );

    it( 'drops empty index and registry entries when the last document is deleted', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis, { prefix : 'p' } );

        await store.set( 'c', 'i', {} );
        expect( redis.keys() ).toEqual( [ 'p:collections', 'p:doc:c:i', 'p:idx:c' ] );
        await store.delete( 'c', 'i' );
        expect( redis.keys() ).toEqual( [] );
    } );

    it( 'self-heals the index when a document key vanished', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis, { prefix : 'p' } );

        await store.set( 'c', 'i', { a : 1 } );
        await store.set( 'c', 'j', { a : 2 } );
        redis.calls.length = 0;
        // Simulate an external eviction of one document key.
        await redis.eval( REDIS_SCRIPTS.cacheDelete, [ 'p:doc:c:i', 'unused' ], [ 'x' ] );

        expect( await store.list( 'c' ) ).toEqual( [ { a : 2 } ] );
        expect( await store.count( 'c' ) ).toBe( 1 );
    } );

    it( 'rejects invalid input without touching Redis', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisDocStore( redis );

        await expect( store.set( 'c', 'i', { d : new Date() } ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.conditionalWrite( 'c', 'i', {}, { expectedVersion : -1 } ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.list( 'c', { a : [ 1 ] } ) ).rejects.toBeInstanceOf( InvalidInputError );

        expect( redis.calls ).toHaveLength( 0 );
    } );

    it( 'wraps client errors in StorageError and rejects malformed script replies', async () =>
    {
        const boom = new Error( 'READONLY You can\'t write against a read only replica' );
        const failing: RedisClient = {
            eval   : async () => {throw boom;},
            get    : async () => {throw boom;},
            exists : async () => {throw boom;}
        };
        const store = new RedisDocStore( failing );
        const err = await store.set( 'c', 'i', {} ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.backend ).toBe( 'redis' );
        expect( err.operation ).toBe( 'doc.set' );
        expect( err.cause ).toBe( boom );
        await expect( store.get( 'c', 'i' ) ).rejects.toBeInstanceOf( StorageError );
        await expect( new RedisCacheStore( failing ).has( 'k' ) ).rejects.toBeInstanceOf( StorageError );

        const garbled = new RedisDocStore( { ...failing, eval : async () => {return 'nope';} } );

        await expect( garbled.conditionalWrite( 'c', 'i', {}, { expectedVersion : null } ) ).rejects.toBeInstanceOf( StorageError );
    } );
} );

describe( 'RedisCacheStore against a fake client', () =>
{
    it( 'rejects maxEntries (R12a)', () =>
    {
        expect( () => {return new RedisCacheStore( new FakeRedis(), { maxEntries : 5 } as never );} ).toThrow( /maxEntries/ );
    } );

    it( 'sends TTL as PX milliseconds, rounding up, with defaultTTLSeconds as fallback', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisCacheStore( redis, { prefix : 'p', defaultTTLSeconds : 2 } );

        await store.set( 'k', 1, 1.0004 );
        await store.set( 'k', 1 );
        await store.set( 'forever', 1, undefined );

        const pxs = redis.calls.map( ( c ) => {return c.args[2];} );

        expect( pxs ).toEqual( [ '1001', '2000', '2000' ] );
        expect( redis.calls[0].keys ).toEqual( [ 'p:cache:k', 'p:cache-index' ] );
    } );

    it( 'omits PX when no TTL is configured', async () =>
    {
        const redis = new FakeRedis();

        await new RedisCacheStore( redis ).set( 'k', 1 );

        expect( redis.calls[0].args[2] ).toBe( '' );
    } );

    it( 'never sends a non-positive PX (Redis would reject it)', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisCacheStore( redis );

        await store.set( 'k', 1 );
        await store.set( 'k', 1, 0 );

        expect( redis.calls.at( -1 )!.script ).toBe( REDIS_SCRIPTS.cacheDelete );
        expect( await store.has( 'k' ) ).toBe( false );
    } );

    it( 'prunes expired members from the index when sizing', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisCacheStore( redis, { prefix : 'p' } );
        const realNow = Date.now;

        try
        {
            await store.set( 'a', 1, 1 );
            await store.set( 'b', 1 );
            Date.now = () => {return realNow() + 5000;};

            expect( await store.size() ).toBe( 1 );
            expect( redis.keys() ).toEqual( [ 'p:cache-index', 'p:cache:b' ] );
        }
        finally
        {
            Date.now = realNow;
        }
    } );

    it( 'uses EXISTS for has and wraps validation before any call', async () =>
    {
        const redis = new FakeRedis();
        const store = new RedisCacheStore( redis, { prefix : 'p' } );

        await expect( store.set( 'k', { n : NaN } ) ).rejects.toBeInstanceOf( InvalidInputError );
        expect( redis.calls ).toHaveLength( 0 );

        await store.set( 'k', 1 );
        await store.has( 'k' );

        expect( redis.calls.at( -1 ) ).toMatchObject( { kind : 'exists', keys : [ 'p:cache:k' ] } );
    } );
} );

describe( 'Redis client shims', () =>
{
    it( 'fromIoRedis passes numKeys followed by keys and args', async () =>
    {
        const seen: unknown[][] = [];
        const client = fromIoRedis( {
            eval   : async ( ...a ) => {seen.push( a ); return 'ok';},
            get    : async ( k ) => {seen.push( [ 'get', k ] ); return 'v';},
            exists : async ( ...k ) => {seen.push( [ 'exists', ...k ] ); return k.length;}
        } );

        expect( await client.eval( 'S', [ 'k1', 'k2' ], [ 'a1' ] ) ).toBe( 'ok' );
        expect( await client.get( 'x' ) ).toBe( 'v' );
        expect( await client.exists( [ 'a', 'b' ] ) ).toBe( 2 );
        expect( seen ).toEqual( [ [ 'S', 2, 'k1', 'k2', 'a1' ], [ 'get', 'x' ], [ 'exists', 'a', 'b' ] ] );
    } );

    it( 'fromNodeRedis passes an options object', async () =>
    {
        const seen: unknown[][] = [];
        const client = fromNodeRedis( {
            eval   : async ( ...a ) => {seen.push( a ); return 1;},
            get    : async () => {return null;},
            exists : async ( keys ) => {seen.push( [ 'exists', keys ] ); return 0;}
        } );

        await client.eval( 'S', [ 'k1' ], [ 'a1', 'a2' ] );
        await client.exists( [ 'a' ] );

        expect( seen ).toEqual( [ [ 'S', { keys : [ 'k1' ], arguments : [ 'a1', 'a2' ] } ], [ 'exists', [ 'a' ] ] ] );
    } );
} );
