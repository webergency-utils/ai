import { it, expect, beforeEach, afterEach } from 'vitest';
import type { IDocumentStore } from '../../../src/storage/index.js';
import { InvalidInputError } from '../../../src/core/error.js';
import { contractSuite, uniqueName } from './shared.js';
import type { ContractFactory, ContractHandle, ContractOptions } from './shared.js';

/**
 * Executable definition of `IDocumentStore` behavior. Every backend must pass this suite unmodified.
 */
export function runDocumentStoreContract( name: string, factory: ContractFactory<IDocumentStore>, options?: ContractOptions ): void
{
    contractSuite( `IDocumentStore contract: ${name}`, options, () =>
    {
        let handle: ContractHandle<IDocumentStore>;
        let store: IDocumentStore;
        let col: string;

        beforeEach( async () =>
        {
            handle = await factory();
            store = handle.store;
            col = uniqueName( 'col' );
        } );

        afterEach( async () =>
        {
            await handle.dispose?.();
        } );

        it( 'round-trips documents with deep clone isolation', async () =>
        {
            const doc = { name : 'Alice', nested : { tags : [ 'a', 'b' ], n : 1.5 }, nil : null, ok : true };

            await store.set( col, 'u1', doc );
            doc.nested.tags.push( 'mutated' );

            const got = await store.get<typeof doc>( col, 'u1' );

            expect( got ).toEqual( { name : 'Alice', nested : { tags : [ 'a', 'b' ], n : 1.5 }, nil : null, ok : true } );

            got!.nested.tags.push( 'again' );
            expect( ( await store.get<typeof doc>( col, 'u1' ) )!.nested.tags ).toEqual( [ 'a', 'b' ] );
        } );

        it( 'returns null for missing documents and collections', async () =>
        {
            expect( await store.get( col, 'nope' ) ).toBeNull();
            expect( await store.getWithMeta( col, 'nope' ) ).toBeNull();
            expect( await store.delete( col, 'nope' ) ).toBe( false );
            expect( await store.list( col ) ).toEqual( [] );
            expect( await store.count( col ) ).toBe( 0 );
        } );

        it( 'handles unusual ids, collections and unicode content', async () =>
        {
            const ids = [ 'a:b', 'with space', 'quote\'s "double"', 'ünï/cødé', '%25', 'x\\y', '' ];

            for( const id of ids )
            {
                await store.set( `${col}:odd`, id, { id, text : '日本語 🚀' } );
            }

            for( const id of ids )
            {
                expect( await store.get( `${col}:odd`, id ) ).toEqual( { id, text : '日本語 🚀' } );
            }

            expect( await store.count( `${col}:odd` ) ).toBe( ids.length );
        } );

        it( 'bumps the version on every write (AE2)', async () =>
        {
            await store.set( col, 'a', { v : 1 } );
            await store.set( col, 'a', { v : 2 } );
            await store.set( col, 'a', { v : 3 } );

            expect( await store.getWithMeta( col, 'a' ) ).toEqual( { doc : { v : 3 }, version : 3 } );
            expect( await store.conditionalWrite( col, 'a', { v : 99 }, { expectedVersion : 2 } ) ).toEqual( { written : false, version : 3 } );
            expect( ( await store.get( col, 'a' ) ) ).toEqual( { v : 3 } );
        } );

        it( 'supports create-only and versioned conditional writes', async () =>
        {
            expect( await store.conditionalWrite( col, 'a', { v : 1 }, { expectedVersion : null } ) ).toEqual( { written : true, version : 1 } );
            expect( await store.conditionalWrite( col, 'a', { v : 2 }, { expectedVersion : null } ) ).toEqual( { written : false, version : 1 } );
            expect( await store.conditionalWrite( col, 'a', { v : 2 }, { expectedVersion : 1 } ) ).toEqual( { written : true, version : 2 } );
            expect( await store.conditionalWrite( col, 'a', { v : 3 }, { expectedVersion : 1 } ) ).toEqual( { written : false, version : 2 } );
            expect( await store.getWithMeta( col, 'a' ) ).toEqual( { doc : { v : 2 }, version : 2 } );
        } );

        it( 'refuses a versioned conditional write on a missing document', async () =>
        {
            expect( await store.conditionalWrite( col, 'ghost', { v : 1 }, { expectedVersion : 3 } ) ).toEqual( { written : false, version : 0 } );
            expect( await store.get( col, 'ghost' ) ).toBeNull();
        } );

        it( 'lets exactly one of 20 concurrent create-only writers win (AE1)', async () =>
        {
            const results = await Promise.all(
                Array.from( { length : 20 }, ( _, i ) =>
                {
                    return store.conditionalWrite( col, 'race', { writer : i }, { expectedVersion : null } );
                } )
            );
            const winners = results.filter( ( r ) => {return r.written;} );

            expect( winners ).toHaveLength( 1 );
            expect( winners[0].version ).toBe( 1 );

            for( const loser of results.filter( ( r ) => {return !r.written;} ) )
            {
                expect( loser.version ).toBe( 1 );
            }

            expect( ( await store.getWithMeta<{ writer: number }>( col, 'race' ) )!.version ).toBe( 1 );
        } );

        it( 'lets exactly one of 10 concurrent versioned writers win', async () =>
        {
            await store.set( col, 'race', { v : 0 } );

            const results = await Promise.all(
                Array.from( { length : 10 }, ( _, i ) =>
                {
                    return store.conditionalWrite( col, 'race', { v : i + 1 }, { expectedVersion : 1 } );
                } )
            );

            expect( results.filter( ( r ) => {return r.written;} ) ).toHaveLength( 1 );
            expect( ( await store.getWithMeta( col, 'race' ) )!.version ).toBe( 2 );
        } );

        it( 'deletes and reports whether a document existed', async () =>
        {
            await store.set( col, 'a', { v : 1 } );

            expect( await store.delete( col, 'a' ) ).toBe( true );
            expect( await store.delete( col, 'a' ) ).toBe( false );
            expect( await store.get( col, 'a' ) ).toBeNull();

            // A deleted document starts a new version history.
            expect( await store.conditionalWrite( col, 'a', { v : 2 }, { expectedVersion : null } ) ).toEqual( { written : true, version : 1 } );
        } );

        it( 'lists with scalar equality filters', async () =>
        {
            await store.set( col, '1', { role : 'admin', age : 30, active : true, team : null } );
            await store.set( col, '2', { role : 'user', age : 30, active : false, team : 'x' } );
            await store.set( col, '3', { role : 'user', age : 41, active : true } );

            const ids = async ( filter?: Record<string, unknown> ): Promise<number[]> =>
            {
                const rows = await store.list<{ age: number, role: string }>( col, filter );

                return rows.map( ( r ) => {return r.age * 10 + ( r.role === 'admin' ? 1 : 0 );} ).sort( ( a, b ) => {return a - b;} );
            };

            expect( await store.list( col ) ).toHaveLength( 3 );
            expect( await store.list( col, {} ) ).toHaveLength( 3 );
            expect( await ids( { role : 'user' } ) ).toEqual( [ 300, 410 ] );
            expect( await ids( { age : 30 } ) ).toEqual( [ 300, 301 ] );
            expect( await ids( { role : 'user', age : 30 } ) ).toEqual( [ 300 ] );
            expect( await ids( { active : true } ) ).toEqual( [ 301, 410 ] );
            expect( await ids( { active : false } ) ).toEqual( [ 300 ] );
            expect( await ids( { team : null } ) ).toEqual( [ 301 ] );
            expect( await ids( { role : 'nobody' } ) ).toEqual( [] );
            expect( await ids( { missing : 'x' } ) ).toEqual( [] );
        } );

        it( 'compares filter values strictly by type', async () =>
        {
            await store.set( col, '1', { n : 1, s : '1', b : true } );

            expect( await store.list( col, { n : '1' } ) ).toHaveLength( 0 );
            expect( await store.list( col, { s : 1 } ) ).toHaveLength( 0 );
            expect( await store.list( col, { b : 1 } ) ).toHaveLength( 0 );
            expect( await store.list( col, { n : 1, s : '1', b : true } ) ).toHaveLength( 1 );
        } );

        it( 'treats filter keys literally (no path or SQL interpretation)', async () =>
        {
            await store.set( col, '1', { 'a.b' : 1, a : { b : 2 }, 'q"uote' : 'x' } );

            expect( await store.list( col, { 'a.b' : 1 } ) ).toHaveLength( 1 );
            expect( await store.list( col, { 'a.b' : 2 } ) ).toHaveLength( 0 );
            expect( await store.list( col, { 'q"uote' : 'x' } ) ).toHaveLength( 1 );
            expect( await store.list( col, { 'x\' OR \'1\'=\'1' : 'x' } ) ).toHaveLength( 0 );
        } );

        it( 'rejects non-scalar filter values uniformly', async () =>
        {
            await expect( store.list( col, { a : { b : 1 } } ) ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( store.list( col, { a : [ 1 ] } ) ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( store.list( col, { a : undefined } ) ).rejects.toBeInstanceOf( InvalidInputError );
        } );

        it( 'counts and clears per collection and globally', async () =>
        {
            const other = `${col}_other`;

            await store.set( col, 'a', { v : 1 } );
            await store.set( col, 'b', { v : 2 } );
            await store.set( other, 'a', { v : 3 } );

            expect( await store.count( col ) ).toBe( 2 );
            expect( await store.count( other ) ).toBe( 1 );

            await store.clear( col );
            expect( await store.count( col ) ).toBe( 0 );
            expect( await store.get( col, 'a' ) ).toBeNull();
            expect( await store.get( other, 'a' ) ).toEqual( { v : 3 } );

            await store.clear();
            expect( await store.count( other ) ).toBe( 0 );
        } );

        it( 'isolates the same id across collections', async () =>
        {
            await store.set( col, 'same', { from : 'one' } );
            await store.set( `${col}_2`, 'same', { from : 'two' } );

            expect( await store.get( col, 'same' ) ).toEqual( { from : 'one' } );
            expect( await store.get( `${col}_2`, 'same' ) ).toEqual( { from : 'two' } );
        } );

        it( 'tolerates undefined object properties by dropping them', async () =>
        {
            await store.set( col, 'a', { keep : 1, drop : undefined } );

            expect( await store.get( col, 'a' ) ).toEqual( { keep : 1 } );
        } );

        it( 'rejects values JSON cannot represent, naming the path (AE3)', async () =>
        {
            const bad: Array<[ string, unknown, string ]> =
            [
                [ 'Date', { when : new Date() }, 'doc.when' ],
                [ 'undefined in array', { list : [ 1, undefined ] }, 'doc.list[1]' ],
                [ 'bigint', { deep : { big : 10n } }, 'doc.deep.big' ],
                [ 'NaN', { n : NaN }, 'doc.n' ],
                [ 'Infinity', { n : Infinity }, 'doc.n' ],
                [ 'function', { f : () => {return 1;} }, 'doc.f' ],
                [ 'Map', { m : new Map() }, 'doc.m' ]
            ];

            for( const [ label, doc, path ] of bad )
            {
                const err = await store.set( col, 'bad', doc ).then( () => {return null;}, ( e: unknown ) => {return e;} );

                expect( err, label ).toBeInstanceOf( InvalidInputError );
                expect( ( err as Error ).message, label ).toContain( path );

                const cas = await store.conditionalWrite( col, 'bad', doc, { expectedVersion : null } ).then( () => {return null;}, ( e: unknown ) => {return e;} );

                expect( cas, label ).toBeInstanceOf( InvalidInputError );
            }

            expect( await store.get( col, 'bad' ) ).toBeNull();

            const circular: Record<string, unknown> = {};

            circular.self = circular;
            await expect( store.set( col, 'bad', circular ) ).rejects.toBeInstanceOf( InvalidInputError );
        } );
    } );
}
