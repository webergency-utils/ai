import { it, expect, beforeEach, afterEach } from 'vitest';
import type { ICacheStore } from '../../../src/storage/index.js';
import { InvalidInputError } from '../../../src/core/error.js';
import { contractSuite, sleep } from './shared.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './shared.js';

export interface CacheContractOptions extends ContractOptions
{
    /** The in-memory store keeps structured-cloneable values (Date, Map, ...) and skips the JSON guard. */
    lenientValues? : boolean
}

/**
 * Executable definition of `ICacheStore` behavior (LRU capacity is memory-specific and not part of the contract).
 */
export function runCacheStoreContract( name: string, factory: ContractFactory<ICacheStore>, options?: CacheContractOptions ): void
{
    contractSuite( `ICacheStore contract: ${name}`, options, () =>
    {
        let handle: ContractHandle<ICacheStore>;
        let store: ICacheStore;

        const advance = ( ms: number ): Promise<void> => {return handle.advanceTime ? handle.advanceTime( ms ) : sleep( ms );};

        beforeEach( async () =>
        {
            handle = await factory();
            store = handle.store;
        } );

        afterEach( async () =>
        {
            await handle.dispose?.();
        } );

        it( 'round-trips JSON values with clone isolation', async () =>
        {
            const value = { a : [ 1, 2, { b : 'c' } ], n : null, s : 'ünï' };

            await store.set( 'k', value );
            value.a.push( 3 );

            const got = await store.get<typeof value>( 'k' );

            expect( got ).toEqual( { a : [ 1, 2, { b : 'c' } ], n : null, s : 'ünï' } );
            got!.a.push( 9 );
            expect( ( await store.get<typeof value>( 'k' ) )!.a ).toHaveLength( 3 );
        } );

        it( 'stores scalars and falsy values', async () =>
        {
            await store.set( 's', 'text' );
            await store.set( 'z', 0 );
            await store.set( 'f', false );
            await store.set( 'e', '' );

            expect( await store.get( 's' ) ).toBe( 'text' );
            expect( await store.get( 'z' ) ).toBe( 0 );
            expect( await store.get( 'f' ) ).toBe( false );
            expect( await store.get( 'e' ) ).toBe( '' );
            expect( await store.has( 'z' ) ).toBe( true );
        } );

        it( 'returns null / false for missing keys', async () =>
        {
            expect( await store.get( 'missing' ) ).toBeNull();
            expect( await store.has( 'missing' ) ).toBe( false );
            expect( await store.delete( 'missing' ) ).toBe( false );
            expect( await store.size() ).toBe( 0 );
        } );

        it( 'overwrites existing keys', async () =>
        {
            await store.set( 'k', 'one' );
            await store.set( 'k', 'two' );

            expect( await store.get( 'k' ) ).toBe( 'two' );
            expect( await store.size() ).toBe( 1 );
        } );

        it( 'handles unusual keys', async () =>
        {
            const keys = [ 'a:b', 'with space', 'quote\'s "x"', 'ünï/cødé', '%25', '' ];

            for( const k of keys )
            {
                await store.set( k, { k } );
            }

            for( const k of keys )
            {
                expect( await store.get( k ) ).toEqual( { k } );
            }

            expect( await store.size() ).toBe( keys.length );
        } );

        it( 'deletes entries and reports whether one existed', async () =>
        {
            await store.set( 'k', 1 );

            expect( await store.delete( 'k' ) ).toBe( true );
            expect( await store.delete( 'k' ) ).toBe( false );
            expect( await store.has( 'k' ) ).toBe( false );
        } );

        it( 'counts and clears', async () =>
        {
            await store.set( 'a', 1 );
            await store.set( 'b', 2 );

            expect( await store.size() ).toBe( 2 );

            await store.clear();
            expect( await store.size() ).toBe( 0 );
            expect( await store.get( 'a' ) ).toBeNull();
        } );

        it( 'expires entries by TTL in get, has and size (AE4)', async () =>
        {
            await store.set( 'short', 'v', 1 );
            await store.set( 'long', 'v', 3600 );
            await store.set( 'forever', 'v' );

            expect( await store.get( 'short' ) ).toBe( 'v' );
            expect( await store.size() ).toBe( 3 );

            await advance( 1100 );

            expect( await store.get( 'short' ) ).toBeNull();
            expect( await store.has( 'short' ) ).toBe( false );
            expect( await store.size() ).toBe( 2 );
            expect( await store.get( 'long' ) ).toBe( 'v' );
            expect( await store.get( 'forever' ) ).toBe( 'v' );
        } );

        it( 'treats a non-positive TTL as already expired', async () =>
        {
            await store.set( 'gone', 'v', -1 );

            expect( await store.get( 'gone' ) ).toBeNull();
            expect( await store.has( 'gone' ) ).toBe( false );
            expect( await store.size() ).toBe( 0 );
        } );

        it( 'clears the TTL when a key is rewritten without one', async () =>
        {
            await store.set( 'k', 'v', 1 );
            await store.set( 'k', 'w' );
            await advance( 1100 );

            expect( await store.get( 'k' ) ).toBe( 'w' );
        } );

        it( 'rejects values JSON cannot represent', async () =>
        {
            if( options?.lenientValues )
            {
                return;
            }

            await expect( store.set( 'k', { when : new Date() } ) ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( store.set( 'k', { n : NaN } ) ).rejects.toBeInstanceOf( InvalidInputError );
            expect( await store.has( 'k' ) ).toBe( false );
        } );
    } );
}
