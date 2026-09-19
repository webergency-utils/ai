import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { LocalDiskFileStore } from '../../src/storage/index.js';

describe( 'LocalDiskFileStore', () => 
{
    const testDir = path.resolve( process.cwd(), 'scratch/test-disk-store' );
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

    it( 'should write string content and read it back', async () => 
    {
        const meta = await store.write( 'nested/test.txt', 'Disk file content' );
        expect( meta.path ).toBe( 'nested/test.txt' );
        expect( meta.size ).toBe( 17 );
        expect( await store.exists( 'nested/test.txt' ) ).toBe( true );

        const buffer = await store.read( 'nested/test.txt' );
        expect( buffer ).toBeDefined();
        expect( new TextDecoder().decode( buffer! ) ).toBe( 'Disk file content' );

        const stat = await store.getMetadata( 'nested/test.txt' );
        expect( stat?.size ).toBe( 17 );
    } );

    it( 'should stream file back as Web ReadableStream', async () => 
    {
        await store.write( 'stream-test.bin', new Uint8Array( [ 1, 2, 3, 4, 5 ] ) );

        const stream = await store.readStream( 'stream-test.bin' );
        expect( stream ).toBeDefined();

        const reader = stream!.getReader();
        const { value, done } = await reader.read();

        expect( done ).toBe( false );
        expect( Array.from( value! ) ).toEqual( [ 1, 2, 3, 4, 5 ] );
    } );

    it( 'should return null for non-existent files', async () => 
    {
        expect( await store.read( 'missing.txt' ) ).toBeNull();
        expect( await store.readStream( 'missing.txt' ) ).toBeNull();
        expect( await store.getMetadata( 'missing.txt' ) ).toBeNull();
        expect( await store.delete( 'missing.txt' ) ).toBe( false );
    } );

    it( 'should reject path traversal attempts', async () => 
    {
        await expect( store.write( '../../traversal.txt', 'evil' ) )
            .rejects
            .toThrow( /traverses outside/ );
    } );
} );
