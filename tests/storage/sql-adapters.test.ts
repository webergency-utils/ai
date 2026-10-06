import { describe, it, expect } from 'vitest';
import
{
    PostgresDocStore,
    PostgresCacheStore,
    SqliteDocStore,
    SqliteCacheStore,
    SqlParams,
    POSTGRES_DIALECT,
    SQLITE_DIALECT,
    assertIdentifier,
    fromPg,
    fromLibsql,
    fromNodeSqlite,
    StorageError,
    isUniqueViolation
} from '../../src/storage/index.js';
import type { SqlClient } from '../../src/storage/index.js';
import { InvalidInputError } from '../../src/core/error.js';
import { SQLITE_AVAILABLE, sqliteClient } from './backends.js';

interface Call
{
    sql    : string
    params : unknown[]
}

function fakeClient( respond: ( call: Call ) => { rows?: unknown[], rowCount?: number } | Error = () => {return {};} ): { client: SqlClient, calls: Call[] }
{
    const calls: Call[] = [];
    const client: SqlClient = {
        async query<T>( sql: string, params: unknown[] )
        {
            const call = { sql, params };

            calls.push( call );

            const out = respond( call );

            if( out instanceof Error ){throw out;}

            return { rows : ( out.rows ?? [] ) as T[], rowCount : out.rowCount ?? out.rows?.length ?? 0 };
        }
    };

    return { client, calls };
}

describe( 'SQL identifiers (R6, AE9)', () =>
{
    it( 'rejects injection attempts and malformed names at construction', () =>
    {
        const { client, calls } = fakeClient();

        for( const bad of [ 'docs; DROP TABLE x', '1abc', '', 'a-b', 'a b', 'a"b', 'x'.repeat( 64 ), 'schema.table' ] )
        {
            expect( () => {return new PostgresDocStore( client, { table : bad } );}, bad ).toThrow( InvalidInputError );
            expect( () => {return new SqliteDocStore( client, { table : bad } );}, bad ).toThrow( InvalidInputError );
            expect( () => {return new PostgresCacheStore( client, { table : bad } );}, bad ).toThrow( InvalidInputError );
            expect( () => {return new SqliteCacheStore( client, { table : bad } );}, bad ).toThrow( InvalidInputError );
        }

        expect( calls ).toHaveLength( 0 );
    } );

    it( 'accepts valid identifiers', () =>
    {
        expect( assertIdentifier( 'ai_documents', 't' ) ).toBe( 'ai_documents' );
        expect( assertIdentifier( '_T1', 't' ) ).toBe( '_T1' );
        expect( assertIdentifier( 'x'.repeat( 63 ), 't' ) ).toHaveLength( 63 );
        expect( () => {return assertIdentifier( 42, 't' );} ).toThrow( InvalidInputError );
    } );
} );

describe( 'SqlParams / dialects', () =>
{
    it( 'numbers placeholders for Postgres and repeats ? for SQLite', () =>
    {
        const pg = new SqlParams( POSTGRES_DIALECT );
        const lite = new SqlParams( SQLITE_DIALECT );

        expect( [ pg.add( 'a' ), pg.add( 'b' ) ] ).toEqual( [ '$1', '$2' ] );
        expect( [ lite.add( 'a' ), lite.add( 'b' ) ] ).toEqual( [ '?', '?' ] );
        expect( lite.values ).toEqual( [ 'a', 'b' ] );
    } );

    it( 'renders type-strict JSON equality per dialect', () =>
    {
        const pg = new SqlParams( POSTGRES_DIALECT );

        expect( POSTGRES_DIALECT.jsonEquals( pg, 'doc', 'age', 30 ) ).toBe( '( doc -> $1::text ) = $2::jsonb' );
        expect( pg.values ).toEqual( [ 'age', '30' ] );

        const lite = new SqlParams( SQLITE_DIALECT );

        expect( SQLITE_DIALECT.jsonEquals( lite, 'doc', 'x', null ) ).toContain( 'type = \'null\'' );
        expect( SQLITE_DIALECT.jsonEquals( lite, 'doc', 'x', true ) ).toContain( 'type = \'true\'' );
        expect( SQLITE_DIALECT.jsonEquals( lite, 'doc', 'x', false ) ).toContain( 'type = \'false\'' );
        expect( SQLITE_DIALECT.jsonEquals( lite, 'doc', 'x', 'v' ) ).toContain( 'type = \'text\' AND value = ?' );
        expect( SQLITE_DIALECT.jsonEquals( lite, 'doc', 'x', 1 ) ).toContain( 'type IN ( \'integer\', \'real\' ) AND value = ?' );
    } );
} );

describe( 'PostgresDocStore SQL', () =>
{
    it( 'ensureSchema is idempotent DDL with JSONB and a composite key', async () =>
    {
        const { client, calls } = fakeClient();

        await new PostgresDocStore( client, { table : 'docs' } ).ensureSchema();

        expect( calls ).toHaveLength( 1 );
        expect( calls[0].sql ).toBe( 'CREATE TABLE IF NOT EXISTS docs ( collection TEXT NOT NULL, id TEXT NOT NULL, doc JSONB NOT NULL, version BIGINT NOT NULL, PRIMARY KEY ( collection, id ) )' );
    } );

    it( 'issues create-only CAS as a single INSERT .. ON CONFLICT DO NOTHING with bound values only (R7)', async () =>
    {
        const { client, calls } = fakeClient( () => {return { rows : [ { version : '1' } ] };} );
        const res = await new PostgresDocStore( client, { table : 'docs' } ).conditionalWrite( 'c\'; --', 'i', { a : 1 }, { expectedVersion : null } );

        expect( res ).toEqual( { written : true, version : 1 } );
        expect( calls ).toHaveLength( 1 );
        expect( calls[0].sql ).toBe( 'INSERT INTO docs ( collection, id, doc, version ) VALUES ( $1, $2, $3::jsonb, 1 ) ON CONFLICT ( collection, id ) DO NOTHING RETURNING version' );
        expect( calls[0].params ).toEqual( [ 'c\'; --', 'i', '{"a":1}' ] );
    } );

    it( 'issues versioned CAS as one UPDATE .. WHERE version = n and reads the winner version on loss', async () =>
    {
        let n = 0;
        const { client, calls } = fakeClient( () => {return n++ === 0 ? { rows : [] } : { rows : [ { version : '7' } ] };} );
        const res = await new PostgresDocStore( client, { table : 'docs' } ).conditionalWrite( 'c', 'i', { a : 1 }, { expectedVersion : 3 } );

        expect( res ).toEqual( { written : false, version : 7 } );
        expect( calls[0].sql ).toBe( 'UPDATE docs SET doc = $1::jsonb, version = version + 1 WHERE collection = $2 AND id = $3 AND version = $4 RETURNING version' );
        expect( calls[0].params ).toEqual( [ '{"a":1}', 'c', 'i', 3 ] );
        expect( calls[1].sql ).toBe( 'SELECT version FROM docs WHERE collection = $1 AND id = $2' );
    } );

    it( 'returns version 0 when a versioned write targets a missing document', async () =>
    {
        const { client } = fakeClient();

        expect( await new PostgresDocStore( client ).conditionalWrite( 'c', 'i', {}, { expectedVersion : 1 } ) ).toEqual( { written : false, version : 0 } );
    } );

    it( 'maps a unique violation inside create-only CAS to written:false (R6a)', async () =>
    {
        let n = 0;
        const dup = Object.assign( new Error( 'duplicate key value violates unique constraint' ), { code : '23505' } );
        const { client } = fakeClient( () => {return n++ === 0 ? dup : { rows : [ { version : 4 } ] };} );

        expect( await new PostgresDocStore( client ).conditionalWrite( 'c', 'i', {}, { expectedVersion : null } ) ).toEqual( { written : false, version : 4 } );
    } );

    it( 'upserts with a version bump on set', async () =>
    {
        const { client, calls } = fakeClient();

        await new PostgresDocStore( client, { table : 'docs' } ).set( 'c', 'i', { a : 1 } );

        expect( calls[0].sql ).toBe( 'INSERT INTO docs ( collection, id, doc, version ) VALUES ( $1, $2, $3::jsonb, 1 ) ON CONFLICT ( collection, id ) DO UPDATE SET doc = excluded.doc, version = docs.version + 1' );
    } );

    it( 'builds list filters from bound keys and values', async () =>
    {
        const { client, calls } = fakeClient( () => {return { rows : [ { doc : '{"a":1}' } ] };} );
        const rows = await new PostgresDocStore( client, { table : 'docs' } ).list( 'c', { role : 'x\' OR 1=1', age : 3 } );

        expect( rows ).toEqual( [ { a : 1 } ] );
        expect( calls[0].sql ).toBe( 'SELECT doc::text AS doc FROM docs WHERE collection = $1 AND ( doc -> $2::text ) = $3::jsonb AND ( doc -> $4::text ) = $5::jsonb' );
        expect( calls[0].params ).toEqual( [ 'c', 'role', '"x\' OR 1=1"', 'age', '3' ] );
    } );

    it( 'normalizes bigint versions returned as strings', async () =>
    {
        const { client } = fakeClient( () => {return { rows : [ { doc : '{"a":1}', version : '12' } ] };} );

        expect( await new PostgresDocStore( client ).getWithMeta( 'c', 'i' ) ).toEqual( { doc : { a : 1 }, version : 12 } );
    } );

    it( 'issues no SQL for invalid input', async () =>
    {
        const { client, calls } = fakeClient();
        const store = new PostgresDocStore( client );

        await expect( store.set( 'c', 'i', { d : new Date() } ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.conditionalWrite( 'c', 'i', { n : NaN }, { expectedVersion : null } ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.conditionalWrite( 'c', 'i', {}, { expectedVersion : 1.5 } ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.list( 'c', { a : { b : 1 } } ) ).rejects.toBeInstanceOf( InvalidInputError );

        expect( calls ).toHaveLength( 0 );
    } );

    it( 'wraps driver errors in StorageError with backend, operation and cause (R6a)', async () =>
    {
        const cause = new Error( 'relation "ai_documents" does not exist' );
        const { client } = fakeClient( () => {return cause;} );
        const store = new PostgresDocStore( client );

        for( const run of [
            () => {return store.get( 'c', 'i' );},
            () => {return store.set( 'c', 'i', {} );},
            () => {return store.delete( 'c', 'i' );},
            () => {return store.list( 'c' );},
            () => {return store.count( 'c' );},
            () => {return store.clear();},
            () => {return store.ensureSchema();},
            () => {return store.conditionalWrite( 'c', 'i', {}, { expectedVersion : 1 } );}
        ] )
        {
            const err = await run().then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

            expect( err ).toBeInstanceOf( StorageError );
            expect( err.code ).toBe( 'STORAGE_ERROR' );
            expect( err.backend ).toBe( 'postgres' );
            expect( err.cause ).toBe( cause );
            expect( err.message ).toContain( 'does not exist' );
        }
    } );

    it( 'clears one collection or the whole table', async () =>
    {
        const { client, calls } = fakeClient();
        const store = new PostgresDocStore( client, { table : 'docs' } );

        await store.clear( 'c' );
        await store.clear();

        expect( calls.map( ( c ) => {return c.sql;} ) ).toEqual( [ 'DELETE FROM docs WHERE collection = $1', 'DELETE FROM docs' ] );
    } );

    it( 'reports spend only for successful conditional writes', async () =>
    {
        const spend: string[] = [];
        const ctx = { reportSpend : ( e: { subcategory?: string } ) => {spend.push( e.subcategory ?? '' );} } as never;
        let n = 0;
        const { client } = fakeClient( () => {return n++ === 0 ? { rows : [ { version : 1 } ] } : { rows : [] };} );
        const store = new PostgresDocStore( client );

        await store.conditionalWrite( 'c', 'i', {}, { expectedVersion : null, context : ctx } );
        await store.conditionalWrite( 'c', 'i', {}, { expectedVersion : null, context : ctx } );

        expect( spend ).toEqual( [ 'doc_write' ] );
    } );
} );

describe( 'SqliteDocStore SQL', () =>
{
    it( 'uses positional placeholders and TEXT JSON', async () =>
    {
        const { client, calls } = fakeClient( () => {return { rows : [ { version : 1 } ] };} );
        const store = new SqliteDocStore( client, { table : 'docs' } );

        await store.ensureSchema();
        await store.conditionalWrite( 'c', 'i', { a : 1 }, { expectedVersion : null } );
        await store.conditionalWrite( 'c', 'i', { a : 1 }, { expectedVersion : 2 } );

        expect( calls[0].sql ).toContain( 'doc TEXT NOT NULL, version INTEGER NOT NULL' );
        expect( calls[1].sql ).toBe( 'INSERT INTO docs ( collection, id, doc, version ) VALUES ( ?, ?, ?, 1 ) ON CONFLICT ( collection, id ) DO NOTHING RETURNING version' );
        expect( calls[2].sql ).toBe( 'UPDATE docs SET doc = ?, version = version + 1 WHERE collection = ? AND id = ? AND version = ? RETURNING version' );
        expect( calls[2].params ).toEqual( [ '{"a":1}', 'c', 'i', 2 ] );
    } );

    it( 'reports the backend as sqlite in errors', async () =>
    {
        const { client } = fakeClient( () => {return new Error( 'no such table' );} );
        const err = await new SqliteDocStore( client ).get( 'c', 'i' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err.backend ).toBe( 'sqlite' );
        expect( err.operation ).toBe( 'doc.get' );
    } );
} );

describe( 'SQL cache stores', () =>
{
    it( 'rejects maxEntries (R12a) and issues no SQL', () =>
    {
        const { client, calls } = fakeClient();

        expect( () => {return new PostgresCacheStore( client, { maxEntries : 10 } as never );} ).toThrow( InvalidInputError );
        expect( () => {return new SqliteCacheStore( client, { maxEntries : 10 } as never );} ).toThrow( /maxEntries/ );
        expect( calls ).toHaveLength( 0 );
    } );

    it( 'stores expires_at from the injected clock and filters reads by it', async () =>
    {
        const { client, calls } = fakeClient( () => {return { rows : [ { value : '"v"' } ] };} );
        const store = new PostgresCacheStore( client, { table : 'c', now : () => {return 1000;} } );

        await store.set( 'k', 'v', 2 );
        await store.get( 'k' );

        expect( calls[0].sql ).toBe( 'INSERT INTO c ( key, value, expires_at ) VALUES ( $1, $2::jsonb, $3 ) ON CONFLICT ( key ) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at' );
        expect( calls[0].params ).toEqual( [ 'k', '"v"', 3000 ] );
        expect( calls[1].sql ).toBe( 'SELECT value::text AS value FROM c WHERE key = $1 AND ( expires_at IS NULL OR expires_at >= $2 )' );
        expect( calls[1].params ).toEqual( [ 'k', 1000 ] );
    } );

    it( 'applies defaultTTLSeconds and stores NULL expiry when none', async () =>
    {
        const { client, calls } = fakeClient();
        const withDefault = new SqliteCacheStore( client, { now : () => {return 0;}, defaultTTLSeconds : 5 } );
        const without = new SqliteCacheStore( client, { now : () => {return 0;} } );

        await withDefault.set( 'a', 1 );
        await withDefault.set( 'b', 1, 1 );
        await without.set( 'c', 1 );

        expect( calls.map( ( c ) => {return c.params[2];} ) ).toEqual( [ 5000, 1000, null ] );
    } );

    it( 'turns a non-positive TTL into a delete', async () =>
    {
        const { client, calls } = fakeClient();

        await new SqliteCacheStore( client, { table : 'c' } ).set( 'k', 1, 0 );

        expect( calls ).toHaveLength( 1 );
        expect( calls[0].sql ).toBe( 'DELETE FROM c WHERE key = ?' );
    } );

    it( 'excludes expired rows from has and size, and purges them explicitly', async () =>
    {
        const { client, calls } = fakeClient( ( call ) => {return call.sql.startsWith( 'DELETE' ) ? { rowCount : 4 } : { rows : [ { n : '3' } ] };} );
        const store = new PostgresCacheStore( client, { table : 'c', now : () => {return 50;} } );

        await store.has( 'k' );
        expect( await store.size() ).toBe( 3 );
        expect( await store.purgeExpired() ).toBe( 4 );

        expect( calls[0].sql ).toContain( '( expires_at IS NULL OR expires_at >= $2 )' );
        expect( calls[1].sql ).toBe( 'SELECT COUNT(*) AS n FROM c WHERE ( expires_at IS NULL OR expires_at >= $1 )' );
        expect( calls[2].sql ).toBe( 'DELETE FROM c WHERE expires_at IS NOT NULL AND expires_at < $1' );
        expect( calls[2].params ).toEqual( [ 50 ] );
    } );

    it( 'ensureSchema creates the table and an expiry index', async () =>
    {
        const { client, calls } = fakeClient();

        await new PostgresCacheStore( client, { table : 'c' } ).ensureSchema();

        expect( calls.map( ( c ) => {return c.sql;} ) ).toEqual( [
            'CREATE TABLE IF NOT EXISTS c ( key TEXT PRIMARY KEY, value JSONB NOT NULL, expires_at BIGINT )',
            'CREATE INDEX IF NOT EXISTS c_expires_idx ON c ( expires_at )'
        ] );
    } );

    it( 'wraps driver errors and validates values before any SQL', async () =>
    {
        const { client, calls } = fakeClient( () => {return new Error( 'boom' );} );
        const store = new PostgresCacheStore( client );

        await expect( store.set( 'k', { d : new Date() } ) ).rejects.toBeInstanceOf( InvalidInputError );
        expect( calls ).toHaveLength( 0 );
        await expect( store.get( 'k' ) ).rejects.toBeInstanceOf( StorageError );
        await expect( store.size() ).rejects.toBeInstanceOf( StorageError );
    } );
} );

describe( 'client shims', () =>
{
    it( 'fromPg maps rowCount and null rowCount', async () =>
    {
        const calls: unknown[][] = [];
        const client = fromPg( {
            async query( text, values )
            {
                calls.push( [ text, values ] );

                return text === 'a' ? { rows : [ { x : 1 } ], rowCount : null } : { rows : [], rowCount : 5 };
            }
        } );

        expect( await client.query( 'a', [ 1 ] ) ).toEqual( { rows : [ { x : 1 } ], rowCount : 1 } );
        expect( await client.query( 'b', [] ) ).toEqual( { rows : [], rowCount : 5 } );
        expect( calls[0] ).toEqual( [ 'a', [ 1 ] ] );
    } );

    it( 'fromLibsql converts positional rows into objects', async () =>
    {
        const client = fromLibsql( {
            async execute( stmt )
            {
                return stmt.sql.startsWith( 'SELECT' )
                    ? { columns : [ 'doc', 'version' ], rows : [ [ '{}', 2 ] ], rowsAffected : 0 }
                    : { columns : [], rows : [], rowsAffected : 3 };
            }
        } );

        expect( await client.query( 'SELECT 1', [] ) ).toEqual( { rows : [ { doc : '{}', version : 2 } ], rowCount : 1 } );
        expect( await client.query( 'DELETE FROM t', [] ) ).toEqual( { rows : [], rowCount : 3 } );
    } );

    it( 'fromNodeSqlite routes row-returning statements to all() and others to run()', async () =>
    {
        const seen: string[] = [];
        const client = fromNodeSqlite( {
            prepare( sql )
            {
                return {
                    all : () => {seen.push( `all:${sql}` ); return [ { a : 1 } ];},
                    run : () => {seen.push( `run:${sql}` ); return { changes : 2n };}
                };
            }
        } );

        expect( await client.query( 'SELECT 1', [] ) ).toEqual( { rows : [ { a : 1 } ], rowCount : 1 } );
        expect( await client.query( 'INSERT INTO t VALUES (1) RETURNING a', [] ) ).toEqual( { rows : [ { a : 1 } ], rowCount : 1 } );
        expect( await client.query( 'DELETE FROM t', [] ) ).toEqual( { rows : [], rowCount : 2 } );
        expect( seen ).toEqual( [ 'all:SELECT 1', 'all:INSERT INTO t VALUES (1) RETURNING a', 'run:DELETE FROM t' ] );
    } );
} );

describe( 'isUniqueViolation', () =>
{
    it( 'recognizes Postgres, SQLite and message based violations', () =>
    {
        expect( isUniqueViolation( { code : '23505' } ) ).toBe( true );
        expect( isUniqueViolation( { code : 'SQLITE_CONSTRAINT_PRIMARYKEY' } ) ).toBe( true );
        expect( isUniqueViolation( { errcode : 1555 } ) ).toBe( true );
        expect( isUniqueViolation( new Error( 'UNIQUE constraint failed: docs.id' ) ) ).toBe( true );
        expect( isUniqueViolation( new Error( 'connection reset' ) ) ).toBe( false );
        expect( isUniqueViolation( null ) ).toBe( false );
        expect( isUniqueViolation( 'x' ) ).toBe( false );
    } );
} );

describe.skipIf( !SQLITE_AVAILABLE )( 'SQLite adapters on a real database', () =>
{
    it( 'ensureSchema is idempotent and a missing schema surfaces as StorageError', async () =>
    {
        const docs = new SqliteDocStore( sqliteClient() );
        const cache = new SqliteCacheStore( sqliteClient() );

        const missing = await docs.get( 'c', 'i' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( missing ).toBeInstanceOf( StorageError );
        expect( missing.message ).toMatch( /no such table/i );
        await expect( cache.get( 'k' ) ).rejects.toBeInstanceOf( StorageError );

        await docs.ensureSchema();
        await docs.ensureSchema();
        await cache.ensureSchema();
        await cache.ensureSchema();

        await docs.set( 'c', 'i', { ok : true } );
        expect( await docs.get( 'c', 'i' ) ).toEqual( { ok : true } );
    } );

    it( 'keeps tables isolated and CAS atomic across store instances sharing one database', async () =>
    {
        const client = sqliteClient();
        const a = new SqliteDocStore( client, { table : 'docs_a' } );
        const b = new SqliteDocStore( client, { table : 'docs_b' } );

        await a.ensureSchema();
        await b.ensureSchema();
        await a.set( 'c', 'i', { from : 'a' } );

        expect( await b.get( 'c', 'i' ) ).toBeNull();
        expect( await a.conditionalWrite( 'c', 'i', { from : 'a2' }, { expectedVersion : 1 } ) ).toEqual( { written : true, version : 2 } );
        expect( await a.conditionalWrite( 'c', 'i', { from : 'a3' }, { expectedVersion : 1 } ) ).toEqual( { written : false, version : 2 } );
    } );

    it( 'purges expired cache rows physically', async () =>
    {
        let now = 1_000;
        const cache = new SqliteCacheStore( sqliteClient(), { now : () => {return now;} } );

        await cache.ensureSchema();
        await cache.set( 'a', 1, 1 );
        await cache.set( 'b', 2 );
        now += 2_000;

        expect( await cache.size() ).toBe( 1 );
        expect( await cache.purgeExpired() ).toBe( 1 );
        expect( await cache.purgeExpired() ).toBe( 0 );
    } );
} );
