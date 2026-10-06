import { describe, it, expect } from 'vitest';
import
{
    MemoryDocStore,
    MemoryVectorStore,
    MemoryCacheStore,
    MemoryFileStore,
    StorageInstrument
} from '../../src/storage/index.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import { SpendTracker, UnitCostRegistry } from '../../src/spend/index.js';
import type { Span } from '../../src/trace/types.js';
import type { CategorySpendInput } from '../../src/spend/types.js';

function tracedContext(): { ctx: SimpleExecutionContext, spans: Span[], spend: CategorySpendInput[] }
{
    const spans: Span[] = [];
    const spend: CategorySpendInput[] = [];
    const ctx = new SimpleExecutionContext( {
        onSpanEnd : ( s ) => {spans.push( s );},
        onSpend   : ( e ) => {spend.push( e );}
    } );

    return { ctx, spans, spend };
}

describe( 'Memory store specifics', () =>
{
    describe( 'MemoryCacheStore', () =>
    {
        it( 'evicts the least recently used entry beyond maxEntries', async () =>
        {
            const store = new MemoryCacheStore( { maxEntries : 2 } );

            await store.set( 'k1', 'val1' );
            await store.set( 'k2', 'val2' );
            await store.get( 'k1' );
            await store.set( 'k3', 'val3' );

            expect( await store.has( 'k2' ) ).toBe( false );
            expect( await store.get( 'k1' ) ).toBe( 'val1' );
            expect( await store.get( 'k3' ) ).toBe( 'val3' );
        } );

        it( 'applies defaultTTLSeconds', async () =>
        {
            const store = new MemoryCacheStore( { defaultTTLSeconds : -1 } );

            await store.set( 'k', 'v' );
            expect( await store.get( 'k' ) ).toBeNull();
        } );
    } );

    describe( 'MemoryVectorStore', () =>
    {
        it( 'locks dimensions on first write when none is configured', async () =>
        {
            const store = new MemoryVectorStore();

            expect( store.dimensions ).toBeUndefined();
            await store.upsert( [ { id : 'a', values : [ 1, 0 ] } ] );
            expect( store.dimensions ).toBe( 2 );
            await expect( store.upsert( [ { id : 'b', values : [ 1, 0, 0 ] } ] ) ).rejects.toThrow( /dimension/i );

            await store.clear();
            expect( store.dimensions ).toBeUndefined();
        } );

        it( 'does not lock dimensions when the first batch is rejected', async () =>
        {
            const store = new MemoryVectorStore();

            await expect(
                store.upsert( [ { id : 'a', values : [ 1, 0 ] }, { id : 'b', values : [ 1, 0, 0 ] } ] )
            ).rejects.toThrow( /dimension/i );
            expect( await store.count() ).toBe( 0 );
        } );
    } );

    describe( 'instrumentation', () =>
    {
        it( 'emits storage:<kind>:<op> spans with attributes and routes spend to the child context', async () =>
        {
            const { ctx, spans, spend } = tracedContext();
            const docs = new MemoryDocStore();
            const cache = new MemoryCacheStore();
            const vectors = new MemoryVectorStore();
            const files = new MemoryFileStore();

            await docs.set( 'c', 'id1', { a : 1 }, { context : ctx } );
            await docs.getWithMeta( 'c', 'id1', { context : ctx } );
            await docs.conditionalWrite( 'c', 'id2', { a : 1 }, { context : ctx, expectedVersion : null } );
            await docs.list( 'c', undefined, { context : ctx } );
            await docs.delete( 'c', 'id1', { context : ctx } );
            await cache.set( 'k', 1, undefined, { context : ctx } );
            await cache.get( 'k', { context : ctx } );
            await cache.delete( 'k', { context : ctx } );
            await vectors.upsert( [ { id : 'v', values : [ 1, 0 ] } ], { context : ctx } );
            await vectors.query( [ 1, 0 ], { topK : 1, context : ctx } );
            await vectors.delete( [ 'v' ], { context : ctx } );
            await files.write( 'f.txt', 'x', { context : ctx } );
            await files.read( 'f.txt', { context : ctx } );
            await files.delete( 'f.txt', { context : ctx } );

            expect( spans.map( ( s ) => {return s.name;} ) ).toEqual( [
                'storage:doc:set',
                'storage:doc:get',
                'storage:doc:conditionalWrite',
                'storage:doc:list',
                'storage:doc:delete',
                'storage:cache:set',
                'storage:cache:get',
                'storage:cache:delete',
                'storage:vector:upsert',
                'storage:vector:query',
                'storage:vector:delete',
                'storage:file:write',
                'storage:file:read',
                'storage:file:delete'
            ] );
            expect( spans[0].kind ).toBe( 'storage' );
            expect( spans[0].attributes['storage.collection'] ).toBe( 'c' );
            expect( spans[0].attributes['storage.id'] ).toBe( 'id1' );
            expect( spend.length ).toBeGreaterThanOrEqual( 14 );
            expect( spend.every( ( e ) => {return e.category === 'storage';} ) ).toBe( true );
        } );

        it( 'does not report spend for failed conditional writes', async () =>
        {
            const { ctx, spend } = tracedContext();
            const docs = new MemoryDocStore();

            await docs.set( 'c', 'id', { a : 1 } );
            await docs.conditionalWrite( 'c', 'id', { a : 2 }, { context : ctx, expectedVersion : null } );

            expect( spend ).toHaveLength( 0 );
        } );

        it( 'falls back to the store tracker without a context', async () =>
        {
            const tracker = new SpendTracker();
            const pricing = new UnitCostRegistry();

            pricing.register( 'storage:doc_write', 0.5 );

            const docs = new MemoryDocStore( { tracker, storagePricing : pricing } );

            await docs.set( 'c', 'id', { a : 1 } );

            expect( tracker.getCategorySpend( 'storage' ) ).toBeCloseTo( 0.5, 6 );
        } );

        it( 'StorageInstrument.run passes the caller context through when it cannot create spans', async () =>
        {
            const instrument = new StorageInstrument( 'doc' );
            const seen: unknown[] = [];
            const ctx = { reportSpend : () => {return;} } as unknown as SimpleExecutionContext;

            await instrument.run( 'op', ctx, undefined, async ( c ) => {seen.push( c );} );
            await instrument.run( 'op', undefined, undefined, async ( c ) => {seen.push( c );} );

            expect( seen ).toEqual( [ ctx, undefined ] );
        } );
    } );
} );
