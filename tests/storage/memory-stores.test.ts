import { describe, it, expect } from 'vitest';
import { 
    MemoryDocStore, 
    MemoryVectorStore, 
    MemoryCacheStore, 
    MemoryFileStore 
} from '../../src/storage/index.js';

describe( 'In-Memory Storage Reference Drivers', () => 
{
    describe( 'MemoryDocStore', () => 
    {
        it( 'should support CRUD operations with deep clone isolation', async () => 
        {
            const store = new MemoryDocStore();

            const doc = { name : 'Alice', role : 'admin' };
            await store.set( 'users', 'u1', doc );

            // Mutation on original should not affect store
            doc.role = 'user';

            const retrieved = await store.get<typeof doc>( 'users', 'u1' );
            expect( retrieved ).toEqual( { name : 'Alice', role : 'admin' } );

            // Mutation on retrieved should not affect store
            retrieved!.role = 'superadmin';
            const retrievedAgain = await store.get<typeof doc>( 'users', 'u1' );
            expect( retrievedAgain?.role ).toBe( 'admin' );

            expect( await store.count( 'users' ) ).toBe( 1 );

            const list = await store.list( 'users', { role : 'admin' } );
            expect( list ).toHaveLength( 1 );

            const emptyList = await store.list( 'users', { role : 'nonexistent' } );
            expect( emptyList ).toHaveLength( 0 );

            const deleted = await store.delete( 'users', 'u1' );
            expect( deleted ).toBe( true );
            expect( await store.get( 'users', 'u1' ) ).toBeNull();
        } );
    } );

    describe( 'MemoryVectorStore', () => 
    {
        it( 'should rank nearest vectors by cosine similarity and filter by metadata', async () => 
        {
            const store = new MemoryVectorStore();

            await store.upsert( 
                [
                    {
                        id       : 'doc-ortho',
                        values   : [ 0, 1, 0 ],
                        content  : 'Orthogonal vector',
                        metadata : { topic : 'math' }
                    },
                    {
                        id       : 'doc-near',
                        values   : [ 0.9, 0.1, 0 ],
                        content  : 'Nearly parallel vector',
                        metadata : { topic : 'ai' }
                    },
                    {
                        id       : 'doc-exact',
                        values   : [ 1, 0, 0 ],
                        content  : 'Exact match vector',
                        metadata : { topic : 'ai' }
                    }
                ] );

            expect( await store.count() ).toBe( 3 );

            // Query with [1, 0, 0]
            const queryVec = [ 1, 0, 0 ];
            const results = await store.query( queryVec, 2 );

            expect( results ).toHaveLength( 2 );
            expect( results[0].id ).toBe( 'doc-exact' );
            expect( results[0].score ).toBeCloseTo( 1.0, 4 );
            expect( results[1].id ).toBe( 'doc-near' );
            expect( results[1].score ).toBeGreaterThan( 0.9 );

            // Query with filter
            const filteredResults = await store.query( queryVec, 5, { topic : 'math' } );
            expect( filteredResults ).toHaveLength( 1 );
            expect( filteredResults[0].id ).toBe( 'doc-ortho' );

            await store.delete( [ 'doc-exact' ] );
            expect( await store.count() ).toBe( 2 );
        } );
    } );

    describe( 'MemoryCacheStore', () => 
    {
        it( 'should respect TTL expiration and LRU capacity pruning', async () => 
        {
            const store = new MemoryCacheStore( { maxEntries : 2 } );

            await store.set( 'k1', 'val1' );
            await store.set( 'k2', 'val2' );

            expect( await store.get( 'k1' ) ).toBe( 'val1' );
            expect( await store.has( 'k2' ) ).toBe( true );

            // Touch k1 to make k2 the oldest LRU
            await store.get( 'k1' );

            // Insert k3 which should evict oldest (k2)
            await store.set( 'k3', 'val3' );

            expect( await store.has( 'k2' ) ).toBe( false );
            expect( await store.get( 'k1' ) ).toBe( 'val1' );
            expect( await store.get( 'k3' ) ).toBe( 'val3' );

            // TTL expiration test with 0 second TTL (immediate expiry)
            await store.set( 'temp', 'data', -1 );
            expect( await store.get( 'temp' ) ).toBeNull();
            expect( await store.has( 'temp' ) ).toBe( false );
        } );
    } );

    describe( 'MemoryFileStore', () => 
    {
        it( 'should write, read, stream, and check existence', async () => 
        {
            const store = new MemoryFileStore();

            const meta = await store.write( 'uploads/hello.txt', 'Hello Storage World' );
            expect( meta.path ).toBe( 'uploads/hello.txt' );
            expect( meta.size ).toBe( 19 );
            expect( await store.exists( 'uploads/hello.txt' ) ).toBe( true );

            const data = await store.read( 'uploads/hello.txt' );
            expect( data ).toBeDefined();
            expect( new TextDecoder().decode( data! ) ).toBe( 'Hello Storage World' );

            const stream = await store.readStream( 'uploads/hello.txt' );
            expect( stream ).toBeDefined();
            const reader = stream!.getReader();
            const chunk = await reader.read();
            expect( new TextDecoder().decode( chunk.value ) ).toBe( 'Hello Storage World' );

            expect( await store.delete( 'uploads/hello.txt' ) ).toBe( true );
            expect( await store.exists( 'uploads/hello.txt' ) ).toBe( false );
        } );
    } );
} );
