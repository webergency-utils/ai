import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IVectorStore } from '../../../src/storage/index.js';
import { DimensionMismatchError, InvalidInputError } from '../../../src/core/error.js';
import { contractSuite } from './shared.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './shared.js';

/** Dimension every factory passed to {@link runVectorStoreContract} must configure. */
export const VECTOR_CONTRACT_DIMENSIONS = 3;

function cosine( a: number[], b: number[] ): number
{
    let dot = 0;
    let na = 0;
    let nb = 0;

    for( let i = 0; i < a.length; i++ )
    {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }

    return dot / ( Math.sqrt( na ) * Math.sqrt( nb ) );
}

/** Small deterministic PRNG so parity vectors are identical on every run. */
function seeded( seed: number ): () => number
{
    let x = seed;

    return () =>
    {
        x = ( x * 1664525 + 1013904223 ) % 4294967296;

        return x / 4294967296 - 0.5;
    };
}

/**
 * Executable definition of `IVectorStore` behavior. The factory must produce an empty store locked to
 * {@link VECTOR_CONTRACT_DIMENSIONS} dimensions.
 */
export function runVectorStoreContract( name: string, factory: ContractFactory<IVectorStore>, options?: ContractOptions ): void
{
    contractSuite( `IVectorStore contract: ${name}`, options, () =>
    {
        let handle: ContractHandle<IVectorStore>;
        let store: IVectorStore;

        beforeEach( async () =>
        {
            handle = await factory();
            store = handle.store;
        } );

        afterEach( async () =>
        {
            await handle.dispose?.();
        } );

        const seed = async (): Promise<void> =>
        {
            await store.upsert( [
                { id : 'ortho', values : [ 0, 1, 0 ], content : 'Orthogonal', metadata : { topic : 'math', rank : 1 } },
                { id : 'near', values : [ 0.9, 0.1, 0 ], content : 'Near', metadata : { topic : 'ai', rank : 2 } },
                { id : 'exact', values : [ 1, 0, 0 ], content : 'Exact', metadata : { topic : 'ai', rank : 3 } },
                { id : 'opposite', values : [ -1, 0, 0 ] }
            ] );
        };

        it( 'ranks by cosine similarity with memory-compatible scores', async () =>
        {
            await seed();

            const results = await store.query( [ 1, 0, 0 ], 4 );

            expect( results.map( ( r ) => {return r.id;} ) ).toEqual( [ 'exact', 'near', 'ortho', 'opposite' ] );
            expect( results[0].score ).toBeCloseTo( 1, 5 );
            expect( results[1].score ).toBeCloseTo( cosine( [ 1, 0, 0 ], [ 0.9, 0.1, 0 ] ), 5 );
            expect( results[2].score ).toBeCloseTo( 0, 5 );
            expect( results[3].score ).toBeCloseTo( -1, 5 );
        } );

        it( 'round-trips content and metadata, and omits them when absent', async () =>
        {
            await seed();

            const results = await store.query( [ 1, 0, 0 ], 4 );
            const byId = new Map( results.map( ( r ) => {return [ r.id, r ] as const;} ) );

            expect( byId.get( 'exact' )!.content ).toBe( 'Exact' );
            expect( byId.get( 'exact' )!.metadata ).toEqual( { topic : 'ai', rank : 3 } );
            expect( byId.get( 'opposite' )!.content ?? undefined ).toBeUndefined();
            expect( byId.get( 'opposite' )!.metadata ?? undefined ).toBeUndefined();
        } );

        it( 'honors topK in numeric and option forms, defaulting to 5', async () =>
        {
            await seed();
            await store.upsert( [ 'a', 'b', 'c', 'd' ].map( ( id, i ) => {return { id, values : [ 1, i + 1, 0 ] };} ) );

            expect( await store.query( [ 1, 0, 0 ], 2 ) ).toHaveLength( 2 );
            expect( await store.query( [ 1, 0, 0 ], { topK : 3 } ) ).toHaveLength( 3 );
            expect( await store.query( [ 1, 0, 0 ] ) ).toHaveLength( 5 );
            expect( await store.query( [ 1, 0, 0 ], 0 ) ).toEqual( [] );
            expect( await store.query( [ 1, 0, 0 ], 100 ) ).toHaveLength( 8 );
        } );

        it( 'filters by scalar metadata equality in both call forms', async () =>
        {
            await seed();

            const viaArg = await store.query( [ 1, 0, 0 ], 10, { topic : 'ai' } );
            const viaOptions = await store.query( [ 1, 0, 0 ], { topK : 10, filter : { topic : 'ai', rank : 2 } } );

            expect( viaArg.map( ( r ) => {return r.id;} ) ).toEqual( [ 'exact', 'near' ] );
            expect( viaOptions.map( ( r ) => {return r.id;} ) ).toEqual( [ 'near' ] );
            expect( await store.query( [ 1, 0, 0 ], 10, { topic : 'none' } ) ).toEqual( [] );
            expect( await store.query( [ 1, 0, 0 ], 10, { rank : '2' } ) ).toEqual( [] );
        } );

        it( 'excludes records without metadata when a filter is given', async () =>
        {
            await seed();

            const ids = ( await store.query( [ 1, 0, 0 ], 10, { topic : 'ai' } ) ).map( ( r ) => {return r.id;} );

            expect( ids ).not.toContain( 'opposite' );
        } );

        it( 'rejects non-scalar filters', async () =>
        {
            await expect( store.query( [ 1, 0, 0 ], 5, { topic : { $in : [ 'ai' ] } } ) ).rejects.toBeInstanceOf( InvalidInputError );
        } );

        it( 'replaces records with the same id', async () =>
        {
            await store.upsert( [ { id : 'x', values : [ 1, 0, 0 ], content : 'old', metadata : { v : 1 } } ] );
            await store.upsert( [ { id : 'x', values : [ 0, 1, 0 ], content : 'new', metadata : { v : 2 } } ] );

            expect( await store.count() ).toBe( 1 );

            const [ hit ] = await store.query( [ 0, 1, 0 ], 1 );

            expect( hit.id ).toBe( 'x' );
            expect( hit.content ).toBe( 'new' );
            expect( hit.metadata ).toEqual( { v : 2 } );
            expect( hit.score ).toBeCloseTo( 1, 5 );
        } );

        it( 'accepts duplicate ids inside one batch (last wins) and empty batches', async () =>
        {
            await store.upsert( [] );
            await store.upsert( [ { id : 'x', values : [ 1, 0, 0 ], content : 'first' }, { id : 'x', values : [ 1, 0, 0 ], content : 'second' } ] );

            expect( await store.count() ).toBe( 1 );
            expect( ( await store.query( [ 1, 0, 0 ], 1 ) )[0].content ).toBe( 'second' );
        } );

        it( 'supports unusual ids', async () =>
        {
            const ids = [ 'a:b', 'with space', 'quote\'s', 'ünï/cødé', '' ];

            await store.upsert( ids.map( ( id ) => {return { id, values : [ 1, 1, 1 ] };} ) );

            const got = ( await store.query( [ 1, 1, 1 ], 10 ) ).map( ( r ) => {return r.id;} ).sort();

            expect( got ).toEqual( [ ...ids ].sort() );
        } );

        it( 'deletes records, ignoring unknown ids, and clears', async () =>
        {
            await seed();
            await store.delete( [ 'exact', 'unknown' ] );
            await store.delete( [] );

            expect( await store.count() ).toBe( 3 );
            expect( ( await store.query( [ 1, 0, 0 ], 10 ) ).map( ( r ) => {return r.id;} ) ).not.toContain( 'exact' );

            await store.clear();
            expect( await store.count() ).toBe( 0 );
            expect( await store.query( [ 1, 0, 0 ], 10 ) ).toEqual( [] );
        } );

        it( 'rejects wrong-length vectors with DimensionMismatchError and writes nothing (AE5)', async () =>
        {
            await expect( store.upsert( [ { id : 'bad', values : [ 1, 2, 3, 4 ] } ] ) ).rejects.toBeInstanceOf( DimensionMismatchError );
            await expect( store.query( [ 1, 2 ], 3 ) ).rejects.toBeInstanceOf( DimensionMismatchError );
            await expect(
                store.upsert( [ { id : 'ok', values : [ 1, 2, 3 ] }, { id : 'bad', values : [ 1 ] } ] )
            ).rejects.toBeInstanceOf( DimensionMismatchError );

            expect( await store.count() ).toBe( 0 );
        } );

        it( 'rejects metadata JSON cannot represent', async () =>
        {
            await expect(
                store.upsert( [ { id : 'bad', values : [ 1, 0, 0 ], metadata : { when : new Date() } } ] )
            ).rejects.toBeInstanceOf( InvalidInputError );
            expect( await store.count() ).toBe( 0 );
        } );

        it( 'matches brute-force cosine ordering and scores for 50 seeded vectors (AE6)', async () =>
        {
            const rand = seeded( 42 );
            const records = Array.from( { length : 50 }, ( _, i ) =>
            {
                return { id : `v${i}`, values : [ rand(), rand(), rand() ], metadata : { bucket : i % 2 } };
            } );
            const query = [ 0.3, -0.2, 0.9 ];

            await store.upsert( records );

            const expected = records
                .map( ( r ) => {return { id : r.id, score : cosine( query, r.values ) };} )
                .sort( ( a, b ) => {return b.score - a.score;} )
                .slice( 0, 5 );
            const actual = await store.query( query, 5 );

            expect( actual.map( ( r ) => {return r.id;} ) ).toEqual( expected.map( ( r ) => {return r.id;} ) );

            for( let i = 0; i < 5; i++ )
            {
                // float4 storage in pgvector bounds the achievable agreement; memory is exact.
                expect( Math.abs( actual[i].score - expected[i].score ) ).toBeLessThan( 1e-6 );
            }

            const odd = await store.query( query, 50, { bucket : 1 } );

            expect( odd ).toHaveLength( 25 );
        } );
    } );
}
