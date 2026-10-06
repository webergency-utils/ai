import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IFileStore } from '../../../src/storage/index.js';
import { PathEscapeError } from '../../../src/core/error.js';
import { contractSuite, uniqueName } from './shared.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './shared.js';

export interface FileContractOptions extends ContractOptions
{
    /** Backend rejects traversal (`..`), absolute and NUL paths with `PathEscapeError`. */
    enforcesPaths? : boolean
}

async function collect( stream: ReadableStream<Uint8Array> ): Promise<Uint8Array>
{
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while( true )
    {
        const { done, value } = await reader.read();

        if( done ){break;}

        chunks.push( value );
    }

    const out = new Uint8Array( chunks.reduce( ( n, c ) => {return n + c.byteLength;}, 0 ) );
    let offset = 0;

    for( const c of chunks )
    {
        out.set( c, offset );
        offset += c.byteLength;
    }

    return out;
}

function toStream( chunks: Uint8Array[] ): ReadableStream<Uint8Array>
{
    let i = 0;

    return new ReadableStream<Uint8Array>( {
        pull( controller )
        {
            if( i < chunks.length )
            {
                controller.enqueue( chunks[i++] );
            }
            else
            {
                controller.close();
            }
        }
    } );
}

/**
 * Executable definition of `IFileStore` behavior.
 */
export function runFileStoreContract( name: string, factory: ContractFactory<IFileStore>, options?: FileContractOptions ): void
{
    contractSuite( `IFileStore contract: ${name}`, options, () =>
    {
        let handle: ContractHandle<IFileStore>;
        let store: IFileStore;
        let dir: string;

        beforeEach( async () =>
        {
            handle = await factory();
            store = handle.store;
            dir = uniqueName( 'dir' );
        } );

        afterEach( async () =>
        {
            await handle.dispose?.();
        } );

        const text = ( data: Uint8Array | null ): string | null => {return data ? new TextDecoder().decode( data ) : null;};

        it( 'writes strings and reads them back with metadata', async () =>
        {
            const meta = await store.write( `${dir}/hello.txt`, 'Hello Storage World' );

            expect( meta.path ).toBe( `${dir}/hello.txt` );
            expect( meta.size ).toBe( 19 );
            expect( meta.createdAt ).toBeInstanceOf( Date );
            expect( meta.updatedAt ).toBeInstanceOf( Date );
            expect( text( await store.read( `${dir}/hello.txt` ) ) ).toBe( 'Hello Storage World' );
            expect( await store.exists( `${dir}/hello.txt` ) ).toBe( true );

            const stat = await store.getMetadata( `${dir}/hello.txt` );

            expect( stat?.size ).toBe( 19 );
            expect( stat?.path ).toBe( `${dir}/hello.txt` );
        } );

        it( 'round-trips every byte value', async () =>
        {
            const bytes = Uint8Array.from( { length : 256 }, ( _, i ) => {return i;} );

            await store.write( `${dir}/all.bin`, bytes );

            expect( Array.from( ( await store.read( `${dir}/all.bin` ) )! ) ).toEqual( Array.from( bytes ) );
        } );

        it( 'stores empty files', async () =>
        {
            const meta = await store.write( `${dir}/empty`, '' );

            expect( meta.size ).toBe( 0 );
            expect( ( await store.read( `${dir}/empty` ) )!.byteLength ).toBe( 0 );
            expect( await store.exists( `${dir}/empty` ) ).toBe( true );
        } );

        it( 'accepts streamed content', async () =>
        {
            const enc = new TextEncoder();
            const meta = await store.write( `${dir}/streamed.txt`, toStream( [ enc.encode( 'alpha-' ), enc.encode( 'beta-' ), enc.encode( 'gamma' ) ] ) );

            expect( meta.size ).toBe( 16 );
            expect( text( await store.read( `${dir}/streamed.txt` ) ) ).toBe( 'alpha-beta-gamma' );
        } );

        it( 'streams content back', async () =>
        {
            await store.write( `${dir}/s.bin`, new Uint8Array( [ 1, 2, 3, 4, 5 ] ) );

            const stream = await store.readStream( `${dir}/s.bin` );

            expect( stream ).not.toBeNull();
            expect( Array.from( await collect( stream! ) ) ).toEqual( [ 1, 2, 3, 4, 5 ] );
        } );

        it( 'overwrites existing files', async () =>
        {
            await store.write( `${dir}/f.txt`, 'one' );
            await store.write( `${dir}/f.txt`, 'two!' );

            expect( text( await store.read( `${dir}/f.txt` ) ) ).toBe( 'two!' );
            expect( ( await store.getMetadata( `${dir}/f.txt` ) )?.size ).toBe( 4 );
        } );

        it( 'returns null / false for missing files', async () =>
        {
            expect( await store.read( `${dir}/missing` ) ).toBeNull();
            expect( await store.readStream( `${dir}/missing` ) ).toBeNull();
            expect( await store.getMetadata( `${dir}/missing` ) ).toBeNull();
            expect( await store.exists( `${dir}/missing` ) ).toBe( false );
            expect( await store.delete( `${dir}/missing` ) ).toBe( false );
        } );

        it( 'deletes files and reports whether one existed', async () =>
        {
            await store.write( `${dir}/d.txt`, 'x' );

            expect( await store.delete( `${dir}/d.txt` ) ).toBe( true );
            expect( await store.exists( `${dir}/d.txt` ) ).toBe( false );
            expect( await store.delete( `${dir}/d.txt` ) ).toBe( false );
        } );

        it( 'supports nested paths and names needing URI encoding', async () =>
        {
            const paths = [ `${dir}/a/b/c.txt`, `${dir}/sp ace/ünï cødé.txt`, ...( process.platform === 'win32' ? [] : [ `${dir}/sym+bols=&?#%.txt` ] ), `${dir}/quote's.txt` ];

            for( const p of paths )
            {
                await store.write( p, p );
            }

            for( const p of paths )
            {
                expect( text( await store.read( p ) ) ).toBe( p );
            }
        } );

        it( 'rejects traversal, absolute and NUL paths', async () =>
        {
            if( !options?.enforcesPaths )
            {
                return;
            }

            for( const bad of [ '../escape.txt', `${dir}/../../escape.txt`, '/etc/passwd', `${dir}/nul\0byte` ] )
            {
                await expect( store.write( bad, 'evil' ), bad ).rejects.toBeInstanceOf( PathEscapeError );
                await expect( store.read( bad ), bad ).rejects.toBeInstanceOf( PathEscapeError );
            }
        } );
    } );
}
