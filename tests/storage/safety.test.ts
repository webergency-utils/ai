import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { LocalDiskFileStore } from '../../src/storage/index.js';
import { PathEscapeError, DimensionMismatchError } from '../../src/core/error.js';
import { MemoryCacheStore, MemoryDocStore, MemoryVectorStore } from '../../src/storage/index.js';

describe( 'LocalDiskFileStore safety (U7)', () => 
{
    const testDir = path.resolve( process.cwd(), 'scratch/test-disk-store-safety' );
    let store: LocalDiskFileStore;

    beforeAll( async () => 
    {
        await fsPromises.rm( testDir, { recursive : true, force : true } );
        await fsPromises.mkdir( testDir, { recursive : true } );
        store = new LocalDiskFileStore( testDir );
    } );

    afterAll( async () => 
    {
        await fsPromises.rm( testDir, { recursive : true, force : true } );
    } );

    it( 'should reject path traversal attempts', async () => 
    {
        await expect( store.write( '../../traversal.txt', 'evil' ) )
            .rejects
            .toThrow( PathEscapeError );
    } );

    it( 'allows filenames that start with two dots (R34)', async () => 
    {
        const meta = await store.write( '..foo.txt', 'ok' );
        expect( meta.path ).toBe( '..foo.txt' );
        expect( new TextDecoder().decode( ( await store.read( '..foo.txt' ) )! ) ).toBe( 'ok' );
    } );

    it( 'rejects symlink escape outside the store root (R34)', async () => 
    {
        const outside = path.resolve( process.cwd(), 'scratch/test-disk-outside' );
        await fsPromises.rm( outside, { recursive : true, force : true } );
        await fsPromises.mkdir( outside, { recursive : true } );
        await fsPromises.writeFile( path.join( outside, 'secret.txt' ), 'secret' );

        const linkPath = path.join( testDir, 'escape-link' );

        try
        {
            await fsPromises.symlink( outside, linkPath, 'dir' );
        }
        catch
        {
            // Symlinks may be unavailable (e.g. Windows without privilege) — skip.
            await fsPromises.rm( outside, { recursive : true, force : true } );

            return;
        }

        await expect( store.read( 'escape-link/secret.txt' ) )
            .rejects
            .toThrow( PathEscapeError );

        await fsPromises.rm( outside, { recursive : true, force : true } );
    } );

    it( 'surfaces stream write errors (R35)', async () => 
    {
        const failing = new Readable( {
            read()
            {
                this.destroy( new Error( 'stream boom' ) );
            }
        } );

        await expect( store.write( 
            'fail-stream.bin', 
            Readable.toWeb( failing ) as ReadableStream<Uint8Array> 
        ) ).rejects.toThrow( /stream boom/ );
    } );
} );

describe( 'MemoryCacheStore live sizing (R36)', () => 
{
    it( 'ignores expired entries toward max size and evicts them first', async () => 
    {
        vi.useFakeTimers();
        const store = new MemoryCacheStore( { maxEntries : 2 } );

        try
        {
            await store.set( 'expired', 'x', 1 );
            await vi.advanceTimersByTimeAsync( 2_000 );

            expect( await store.size() ).toBe( 0 );

            await store.set( 'a', '1' );
            await store.set( 'b', '2', 1 );
            await vi.advanceTimersByTimeAsync( 2_000 );

            // b is expired; inserting c should not evict live a
            await store.set( 'c', '3' );

            expect( await store.get( 'a' ) ).toBe( '1' );
            expect( await store.get( 'c' ) ).toBe( '3' );
            expect( await store.size() ).toBe( 2 );
        }
        finally
        {
            vi.useRealTimers();
        }
    } );
} );

describe( 'MemoryVectorStore dimensions (R37)', () => 
{
    it( 'throws DimensionMismatchError on mismatched vectors', async () => 
    {
        const store = new MemoryVectorStore();

        await store.upsert( [ { id : 'a', values : [ 1, 0, 0 ] } ] );

        await expect( store.upsert( [ { id : 'b', values : [ 1, 0 ] } ] ) )
            .rejects
            .toThrow( DimensionMismatchError );

        await expect( store.query( [ 1, 0 ] ) )
            .rejects
            .toThrow( DimensionMismatchError );
    } );
} );

describe( 'MemoryDocStore conditional write (KTD7)', () => 
{
    it( 'wins create-if-absent and loses on version mismatch', async () => 
    {
        const store = new MemoryDocStore();

        const created = await store.conditionalWrite( 'runs', 'r1', { owner : 'a' }, {
            expectedVersion : null
        } );
        expect( created.written ).toBe( true );
        expect( created.version ).toBe( 1 );

        const conflict = await store.conditionalWrite( 'runs', 'r1', { owner : 'b' }, {
            expectedVersion : null
        } );
        expect( conflict.written ).toBe( false );
        expect( conflict.version ).toBe( 1 );

        const updated = await store.conditionalWrite( 'runs', 'r1', { owner : 'a', claimedAt : 1 }, {
            expectedVersion : 1
        } );
        expect( updated.written ).toBe( true );
        expect( updated.version ).toBe( 2 );

        const stale = await store.conditionalWrite( 'runs', 'r1', { owner : 'c' }, {
            expectedVersion : 1
        } );
        expect( stale.written ).toBe( false );
        expect( stale.version ).toBe( 2 );

        const meta = await store.getWithMeta<{ owner: string }>( 'runs', 'r1' );
        expect( meta?.version ).toBe( 2 );
        expect( meta?.doc.owner ).toBe( 'a' );
    } );
} );
