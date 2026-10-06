import { describe, it, expect } from 'vitest';
import { PgVectorStore, MemoryVectorStore, StorageError } from '../../src/storage/index.js';
import type { SqlClient } from '../../src/storage/index.js';
import { DimensionMismatchError, InvalidInputError } from '../../src/core/error.js';
import { POSTGRES_URL, postgresClient } from './backends.js';
import { uniqueName } from './contract/shared.js';

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
            calls.push( { sql, params } );

            const out = respond( { sql, params } );

            if( out instanceof Error ){throw out;}

            return { rows : ( out.rows ?? [] ) as T[], rowCount : out.rowCount ?? out.rows?.length ?? 0 };
        }
    };

    return { client, calls };
}

describe( 'PgVectorStore construction (R13, AE9)', () =>
{
    it( 'requires valid dimensions and identifiers', () =>
    {
        const { client } = fakeClient();

        expect( () => {return new PgVectorStore( client, {} as never );} ).toThrow( InvalidInputError );

        for( const dimensions of [ 0, -1, 1.5, NaN, 16_001 ] )
        {
            expect( () => {return new PgVectorStore( client, { dimensions } );}, String( dimensions ) ).toThrow( InvalidInputError );
        }

        expect( () => {return new PgVectorStore( client, { dimensions : 3, table : 'v; DROP TABLE x' } );} ).toThrow( InvalidInputError );
        expect( () => {return new PgVectorStore( client, { dimensions : 3, index : { type : 'ivfflat' as never } } );} ).toThrow( InvalidInputError );
        expect( () => {return new PgVectorStore( client, { dimensions : 3, index : { type : 'hnsw', m : 0 } } );} ).toThrow( InvalidInputError );
        expect( () => {return new PgVectorStore( client, { dimensions : 3, table : 'x'.repeat( 60 ), index : { type : 'hnsw' } } );} ).toThrow( InvalidInputError );
        expect( new PgVectorStore( client, { dimensions : 3 } ).dimensions ).toBe( 3 );
    } );
} );

describe( 'PgVectorStore SQL', () =>
{
    it( 'locks dimensions before sending any SQL (AE5)', async () =>
    {
        const { client, calls } = fakeClient();
        const store = new PgVectorStore( client, { dimensions : 3 } );

        await expect( store.upsert( [ { id : 'a', values : [ 1, 2, 3, 4 ] } ] ) ).rejects.toBeInstanceOf( DimensionMismatchError );
        await expect( store.upsert( [ { id : 'ok', values : [ 1, 2, 3 ] }, { id : 'bad', values : [ 1 ] } ] ) ).rejects.toBeInstanceOf( DimensionMismatchError );
        await expect( store.query( [ 1, 2 ] ) ).rejects.toBeInstanceOf( DimensionMismatchError );
        await expect( store.upsert( [ { id : 'a', values : [ 1, NaN, 3 ] } ] ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.upsert( [ { id : 'a', values : [ 1, 2, 3 ], metadata : { d : new Date() } } ] ) ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( store.query( [ 1, 2, 3 ], 5, { a : { b : 1 } } ) ).rejects.toBeInstanceOf( InvalidInputError );

        expect( calls ).toHaveLength( 0 );
    } );

    it( 'ensureSchema creates the extension, the table and the HNSW index', async () =>
    {
        const { client, calls } = fakeClient();

        await new PgVectorStore( client, { table : 'v', dimensions : 1536, index : { type : 'hnsw', m : 24, efConstruction : 100 } } ).ensureSchema();

        expect( calls.map( ( c ) => {return c.sql;} ) ).toEqual( [
            'CREATE EXTENSION IF NOT EXISTS vector',
            'CREATE TABLE IF NOT EXISTS v ( id TEXT PRIMARY KEY, embedding vector(1536) NOT NULL, metadata JSONB, content TEXT )',
            'CREATE INDEX IF NOT EXISTS v_embedding_hnsw ON v USING hnsw ( embedding vector_cosine_ops ) WITH ( m = 24, ef_construction = 100 )'
        ] );
    } );

    it( 'omits WITH for default index parameters and skips the index when not requested', async () =>
    {
        const withIndex = fakeClient();
        const without = fakeClient();

        await new PgVectorStore( withIndex.client, { table : 'v', dimensions : 3, index : { type : 'hnsw' } } ).ensureSchema();
        await new PgVectorStore( without.client, { table : 'v', dimensions : 3 } ).ensureSchema();

        expect( withIndex.calls[2].sql ).toBe( 'CREATE INDEX IF NOT EXISTS v_embedding_hnsw ON v USING hnsw ( embedding vector_cosine_ops )' );
        expect( without.calls ).toHaveLength( 2 );
    } );

    it( 'surfaces a missing extension as StorageError with a remediation hint (R15)', async () =>
    {
        const { client } = fakeClient( ( call ) => {return call.sql.startsWith( 'CREATE EXTENSION' ) ? new Error( 'extension "vector" is not available' ) : {};} );
        const err = await new PgVectorStore( client, { dimensions : 3 } ).ensureSchema().then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.backend ).toBe( 'pgvector' );
        expect( err.message ).toContain( 'not available' );
        expect( err.message ).toContain( 'pgvector/pgvector' );
        expect( err.message ).toContain( 'CREATE EXTENSION vector' );
    } );

    it( 'adds the hint when later statements fail because the vector type is missing, but not for unrelated errors', async () =>
    {
        const missing = fakeClient( () => {return new Error( 'type "vector" does not exist' );} );
        const other = fakeClient( () => {return new Error( 'relation "ai_vectors" does not exist' );} );

        const a = await new PgVectorStore( missing.client, { dimensions : 3 } ).count().then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;
        const b = await new PgVectorStore( other.client, { dimensions : 3 } ).count().then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( a.message ).toContain( 'pgvector/pgvector' );
        expect( b.message ).not.toContain( 'pgvector/pgvector' );
        expect( b ).toBeInstanceOf( StorageError );
    } );

    it( 'upserts with bound values, vector literals and deduplicated ids', async () =>
    {
        const { client, calls } = fakeClient();

        await new PgVectorStore( client, { table : 'v', dimensions : 3 } ).upsert( [
            { id : 'a', values : [ 1, 0, 0.5 ], metadata : { t : 'x' }, content : 'hello' },
            { id : 'b', values : [ 0, 1, 0 ] },
            { id : 'a', values : [ 0, 0, 1 ], content : 'second' }
        ] );

        expect( calls ).toHaveLength( 1 );
        expect( calls[0].sql ).toBe(
            'INSERT INTO v ( id, embedding, metadata, content ) VALUES ( $1, $2::vector, $3::jsonb, $4 ), ( $5, $6::vector, $7::jsonb, $8 ) ON CONFLICT ( id ) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, content = EXCLUDED.content'
        );
        expect( calls[0].params ).toEqual( [ 'a', '[0,0,1]', null, 'second', 'b', '[0,1,0]', null, null ] );
    } );

    it( 'splits large upserts into bounded statements', async () =>
    {
        const { client, calls } = fakeClient();
        const records = Array.from( { length : 450 }, ( _, i ) => {return { id : `r${i}`, values : [ 1, 2, 3 ] };} );

        await new PgVectorStore( client, { dimensions : 3 } ).upsert( records );

        expect( calls ).toHaveLength( 3 );
        expect( calls[0].params ).toHaveLength( 800 );
        expect( calls[2].params ).toHaveLength( 200 );
    } );

    it( 'builds a cosine similarity query with containment filter and limit (R14)', async () =>
    {
        const { client, calls } = fakeClient( () => {return { rows : [ { id : 'a', metadata : '{"t":"x"}', content : null, score : '0.5' } ] };} );
        const res = await new PgVectorStore( client, { table : 'v', dimensions : 3 } ).query( [ 1, 0, 0 ], { topK : 7, filter : { t : 'x' } } );

        expect( res ).toEqual( [ { id : 'a', score : 0.5, metadata : { t : 'x' }, content : undefined } ] );
        expect( calls[0].sql ).toBe(
            'SELECT id, metadata::text AS metadata, content, CASE WHEN ( embedding <=> $1::vector ) = \'NaN\'::float8 THEN 0 ELSE 1 - ( embedding <=> $1::vector ) END AS score FROM v WHERE metadata @> $2::jsonb ORDER BY embedding <=> $1::vector LIMIT $3'
        );
        expect( calls[0].params ).toEqual( [ '[1,0,0]', '{"t":"x"}', 7 ] );
    } );

    it( 'omits WHERE without a filter, honors the positional filter argument and clamps topK', async () =>
    {
        const { client, calls } = fakeClient();
        const store = new PgVectorStore( client, { table : 'v', dimensions : 2 } );

        await store.query( [ 1, 0 ] );
        await store.query( [ 1, 0 ], 3.9, { a : 1 } );
        expect( await store.query( [ 1, 0 ], 0 ) ).toEqual( [] );
        expect( await store.query( [ 1, 0 ], -4 ) ).toEqual( [] );

        expect( calls ).toHaveLength( 2 );
        expect( calls[0].sql ).not.toContain( 'WHERE' );
        expect( calls[0].params ).toEqual( [ '[1,0]', 5 ] );
        expect( calls[1].params ).toEqual( [ '[1,0]', '{"a":1}', 3 ] );
    } );

    it( 'deletes with an array parameter and skips SQL for an empty list', async () =>
    {
        const { client, calls } = fakeClient();
        const store = new PgVectorStore( client, { table : 'v', dimensions : 2 } );

        await store.delete( [] );
        await store.delete( [ 'a', 'b' ] );
        await store.clear();

        expect( calls.map( ( c ) => {return c.sql;} ) ).toEqual( [ 'DELETE FROM v WHERE id = ANY( $1::text[] )', 'DELETE FROM v' ] );
        expect( calls[0].params ).toEqual( [ [ 'a', 'b' ] ] );
    } );

    it( 'counts rows and reports spend through the context', async () =>
    {
        const spend: Array<[ string | undefined, number | undefined ]> = [];
        const ctx = { reportSpend : ( e: { subcategory?: string, units?: number } ) => {spend.push( [ e.subcategory, e.units ] );} } as never;
        const { client } = fakeClient( ( call ) => {return call.sql.includes( 'COUNT' ) ? { rows : [ { n : '42' } ] } : {};} );
        const store = new PgVectorStore( client, { dimensions : 2 } );

        expect( await store.count() ).toBe( 42 );
        await store.upsert( [ { id : 'a', values : [ 1, 2 ] } ], { context : ctx } );
        await store.query( [ 1, 2 ], { topK : 1, context : ctx } );
        await store.delete( [ 'a' ], { context : ctx } );

        expect( spend ).toEqual( [ [ 'vector_write', 1 ], [ 'vector_query', 1 ], [ 'vector_delete', 1 ] ] );
    } );

    it( 'wraps driver errors in StorageError', async () =>
    {
        const { client } = fakeClient( () => {return new Error( 'connection terminated' );} );
        const store = new PgVectorStore( client, { dimensions : 2 } );

        await expect( store.query( [ 1, 2 ] ) ).rejects.toBeInstanceOf( StorageError );
        await expect( store.upsert( [ { id : 'a', values : [ 1, 2 ] } ] ) ).rejects.toBeInstanceOf( StorageError );
        await expect( store.clear() ).rejects.toBeInstanceOf( StorageError );
    } );
} );

describe.skipIf( !POSTGRES_URL )( 'PgVectorStore against Postgres + pgvector', () =>
{
    it( 'matches MemoryVectorStore top-5 ids and scores within 1e-6 for 50 seeded vectors (AE6)', async () =>
    {
        const { client, pool } = await postgresClient();
        const table = uniqueName( 'parity' );
        const pg = new PgVectorStore( client, { table, dimensions : 8 } );
        const memory = new MemoryVectorStore( { dimensions : 8 } );
        let x = 7;
        const rand = (): number => {x = ( x * 1103515245 + 12345 ) % 2147483648; return x / 2147483648 - 0.5;};
        const records = Array.from( { length : 50 }, ( _, i ) => {return { id : `v${i}`, values : Array.from( { length : 8 }, rand ), metadata : { g : i % 3 } };} );
        const query = Array.from( { length : 8 }, rand );

        try
        {
            await pg.ensureSchema();
            await pg.upsert( records );
            await memory.upsert( records );

            const a = await pg.query( query, 5 );
            const b = await memory.query( query, 5 );

            expect( a.map( ( r ) => {return r.id;} ) ).toEqual( b.map( ( r ) => {return r.id;} ) );

            a.forEach( ( r, i ) => {expect( Math.abs( r.score - b[i].score ) ).toBeLessThan( 1e-6 );} );

            const filteredA = await pg.query( query, 5, { g : 1 } );
            const filteredB = await memory.query( query, 5, { g : 1 } );

            expect( filteredA.map( ( r ) => {return r.id;} ) ).toEqual( filteredB.map( ( r ) => {return r.id;} ) );
        }
        finally
        {
            await pool.query( `DROP TABLE IF EXISTS ${table}` );
        }
    } );

    it( 'creates the HNSW index idempotently and still answers queries', async () =>
    {
        const { client, pool } = await postgresClient();
        const table = uniqueName( 'hnsw' );
        const store = new PgVectorStore( client, { table, dimensions : 3, index : { type : 'hnsw', m : 8, efConstruction : 32 } } );

        try
        {
            await store.ensureSchema();
            await store.ensureSchema();
            await store.upsert( [ { id : 'a', values : [ 1, 0, 0 ] }, { id : 'b', values : [ 0, 1, 0 ] } ] );

            expect( ( await store.query( [ 1, 0, 0 ], 1 ) )[0].id ).toBe( 'a' );
        }
        finally
        {
            await pool.query( `DROP TABLE IF EXISTS ${table}` );
        }
    } );

    it( 'reports a zero vector similarity of 0 instead of NaN', async () =>
    {
        const { client, pool } = await postgresClient();
        const table = uniqueName( 'zero' );
        const store = new PgVectorStore( client, { table, dimensions : 3 } );

        try
        {
            await store.ensureSchema();
            await store.upsert( [ { id : 'z', values : [ 0, 0, 0 ] } ] );

            expect( ( await store.query( [ 1, 0, 0 ], 1 ) )[0].score ).toBe( 0 );
        }
        finally
        {
            await pool.query( `DROP TABLE IF EXISTS ${table}` );
        }
    } );
} );
