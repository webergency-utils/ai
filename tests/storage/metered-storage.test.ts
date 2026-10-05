import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import 
{
    MemoryVectorStore,
    MemoryDocStore,
    MemoryFileStore,
    LocalDiskFileStore,
    MemoryCacheStore
} from '../../src/storage/index.js';
import 
{
    SpendTracker,
    UnitCostRegistry
} from '../../src/spend/index.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';

describe( 'Metered Storage Drivers', () => 
{
    let tempDir: string;

    beforeEach( async () => 
    {
        tempDir = await fsPromises.mkdtemp( path.join( os.tmpdir(), 'ai-storage-metered-' ) );
    } );

    afterEach( async () => 
    {
        await fsPromises.rm( tempDir, { recursive : true, force : true } );
    } );

    it( 'should meter vector queries and writes at store level (AE2)', async () => 
    {
        const tracker = new SpendTracker();
        const pricing = new UnitCostRegistry();

        // AE2: $0.05 per 1,000 queries = $0.00005 per query
        pricing.register( 'storage:vector_query', 0.05 / 1000 );

        const store = new MemoryVectorStore( {
            tracker,
            storagePricing : pricing
        } );

        await store.upsert( [
            { id : 'v1', values : [ 1, 0, 0 ] },
            { id : 'v2', values : [ 0, 1, 0 ] }
        ] );

        // 20 vector searches
        for( let i = 0; i < 20; i++ )
        {
            await store.query( [ 1, 0, 0 ], 1 );
        }

        // 20 * 0.00005 = 0.001
        // Plus upsert: default unit pricing storage:vector_write = 0.00025 * 2 = 0.0005
        expect( tracker.getCategorySpend( 'storage' ) ).toBeCloseTo( 0.0015, 4 );
    } );

    it( 'should support per-call context override for vector queries (AE2 with context)', async () => 
    {
        const globalTracker = new SpendTracker();
        const threadTracker = new SpendTracker();
        const pricing = new UnitCostRegistry();

        pricing.register( 'storage:vector_query', 0.05 / 1000 );

        // Store configured with default tracker
        const store = new MemoryVectorStore( {
            tracker        : globalTracker,
            storagePricing : pricing
        } );

        await store.upsert( [ { id : 'v1', values : [ 0.5, 0.5 ] } ] );

        // Upsert was attributed to global tracker
        expect( globalTracker.getCategorySpend( 'storage' ) ).toBeGreaterThan( 0 );
        expect( threadTracker.getCategorySpend( 'storage' ) ).toBe( 0 );

        const context = new SimpleExecutionContext( {
            tracker  : threadTracker,
            threadId : 'session-42'
        } );

        // 20 searches with context
        for( let i = 0; i < 20; i++ )
        {
            await store.query( [ 0.5, 0.5 ], { topK : 1, context } );
        }

        // Thread tracker gets 20 * 0.00005 = 0.001
        expect( threadTracker.getCategorySpend( 'storage' ) ).toBeCloseTo( 0.001, 4 );
        expect( threadTracker.categoryRecords[ 0 ].threadId ).toBe( 'session-42' );
    } );

    it( 'should meter file writes and reads based on byte size', async () => 
    {
        const tracker = new SpendTracker();
        const store = new MemoryFileStore( { tracker } );

        // 100 KB file (102,400 bytes)
        const fileContent = new Uint8Array( 102_400 );
        fileContent.fill( 65 );

        await store.write( 'test-100kb.bin', fileContent );

        // Default storage:bytes is 0.00000000002 per byte
        // 102,400 * 0.00000000002 = 0.000002048
        expect( tracker.getCategorySpend( 'storage' ) ).toBeGreaterThan( 0 );

        const prevSpend = tracker.getCategorySpend( 'storage' );

        await store.read( 'test-100kb.bin' );

        expect( tracker.getCategorySpend( 'storage' ) ).toBeCloseTo( prevSpend * 2, 8 );
    } );

    it( 'should meter LocalDiskFileStore transfers', async () => 
    {
        const tracker = new SpendTracker();
        const store = new LocalDiskFileStore( tempDir, { tracker } );

        const data = 'Hello, metered disk storage!';
        await store.write( 'sample.txt', data );

        expect( tracker.getCategorySpend( 'storage' ) ).toBeGreaterThan( 0 );
        expect( tracker.categoryRecords ).toHaveLength( 1 );
        expect( tracker.categoryRecords[ 0 ].units ).toBe( Buffer.byteLength( data ) );
    } );

    it( 'should meter document store operations', async () => 
    {
        const tracker = new SpendTracker();
        const store = new MemoryDocStore( { tracker } );

        await store.set( 'users', 'u1', { name : 'Alice' } );
        await store.get( 'users', 'u1' );
        await store.list( 'users' );
        await store.delete( 'users', 'u1' );

        // 4 operations metered
        expect( tracker.categoryRecords ).toHaveLength( 4 );
        expect( tracker.getCategorySpend( 'storage' ) ).toBeGreaterThan( 0 );
    } );

    it( 'should meter cache store operations', async () => 
    {
        const tracker = new SpendTracker();
        const store = new MemoryCacheStore( { tracker } );

        await store.set( 'prompt-cache:1', { response : 'OK' } );
        const cached = await store.get( 'prompt-cache:1' );

        expect( cached ).toEqual( { response : 'OK' } );
        expect( tracker.categoryRecords ).toHaveLength( 2 );
        expect( tracker.getCategorySpend( 'storage' ) ).toBeGreaterThan( 0 );
    } );
} );
