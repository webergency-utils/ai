import { describe, it, expect } from 'vitest';
import { checkRelease } from '../../scripts/lib/release-guard.mjs';

describe( 'checkRelease (R21)', () =>
{
    it( 'accepts a matching tag on main', () =>
    {
        expect( checkRelease( { tag : 'v0.1.0', version : '0.1.0', sha : 'abc', requireMain : true, isOnMain : () => true } ) ).toEqual( [] );
        expect( checkRelease( { tag : '0.1.0', version : '0.1.0' } ) ).toEqual( [] );
    } );

    it( 'AE10: rejects tag v0.2.0 against package.json 0.1.0', () =>
    {
        const problems = checkRelease( { tag : 'v0.2.0', version : '0.1.0' } );
        expect( problems ).toHaveLength( 1 );
        expect( problems[0] ).toContain( 'v0.2.0' );
        expect( problems[0] ).toContain( '0.1.0' );
    } );

    it( 'rejects a commit that is not on main', () =>
    {
        const problems = checkRelease( { tag : 'v0.1.0', version : '0.1.0', sha : 'deadbeef', requireMain : true, isOnMain : () => false } );
        expect( problems ).toEqual( [ 'release commit deadbeef is not reachable from main' ] );
    } );

    it( 'requires a tag and an ancestry check for a real publish', () =>
    {
        expect( checkRelease( { version : '0.1.0', requireMain : true, sha : 'a', isOnMain : () => true } ) ).toEqual( [ 'a release tag is required for a real publish' ] );
        expect( checkRelease( { tag : 'v0.1.0', version : '0.1.0', requireMain : true } )[0] ).toContain( 'cannot verify' );
    } );

    it( 'allows an untagged dry run and rejects non-semver versions', () =>
    {
        expect( checkRelease( { version : '0.1.0' } ) ).toEqual( [] );
        expect( checkRelease( { version : 'latest' } )[0] ).toContain( 'not valid semver' );
        expect( checkRelease( { tag : 'v1.0.0-rc.1', version : '1.0.0-rc.1' } ) ).toEqual( [] );
    } );
} );
