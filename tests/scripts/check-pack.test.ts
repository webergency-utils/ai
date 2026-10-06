import { describe, it, expect } from 'vitest';
import { checkPackFiles } from '../../scripts/lib/pack-rules.mjs';

const GOOD = [
    'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md',
    'dist/index.js', 'dist/index.d.ts', 'dist/index.js.map',
    'src/index.ts'
];

describe( 'checkPackFiles (R1)', () =>
{
    it( 'accepts the intended tarball layout', () =>
    {
        expect( checkPackFiles( GOOD ) ).toEqual( [] );
    } );

    it( 'AE1: names a stray tests/ path', () =>
    {
        const problems = checkPackFiles( [ ...GOOD, 'tests/core/a.test.ts' ] );
        expect( problems ).toHaveLength( 1 );
        expect( problems[0] ).toContain( 'tests/core/a.test.ts' );
        expect( problems[0] ).toContain( 'denied' );
    } );

    it.each( [ '.env', '.env.local', 'scratch/x.ts', 'fuzz_ai.cjs', 'src/fixtures/a.json', 'dist/.tsbuildinfo', 'coverage/lcov.info' ] )( 'denies %s', ( file ) =>
    {
        const problems = checkPackFiles( [ ...GOOD, file ] );
        expect( problems.some( ( p ) => p.startsWith( file ) ) ).toBe( true );
    } );

    it( 'rejects files outside the allowlist', () =>
    {
        expect( checkPackFiles( [ ...GOOD, 'eslint.config.js' ] ) ).toEqual( [ 'eslint.config.js: not in allowlist' ] );
    } );

    it( 'requires package.json, README, LICENSE and compiled output', () =>
    {
        const problems = checkPackFiles( [ 'src/index.ts' ] );
        expect( problems ).toEqual( expect.arrayContaining( [
            'package.json: missing from tarball',
            'README.md: missing from tarball',
            'LICENSE: missing from tarball',
            expect.stringContaining( 'no compiled JavaScript' )
        ] ) );
    } );

    it( 'fails on source maps that point outside the tarball', () =>
    {
        const files = GOOD.filter( ( f ) => f !== 'src/index.ts' );
        const problems = checkPackFiles( files, { read : () => JSON.stringify( { sources : [ '../src/index.ts' ] } ) } );
        expect( problems ).toHaveLength( 1 );
        expect( problems[0] ).toContain( 'src/index.ts' );
        expect( problems[0] ).toContain( 'not in the tarball' );
    } );

    it( 'accepts source maps whose sources ship', () =>
    {
        expect( checkPackFiles( GOOD, { read : () => JSON.stringify( { sources : [ '../src/index.ts' ] } ) } ) ).toEqual( [] );
    } );

    it( 'reports invalid map JSON and tolerates unreadable maps', () =>
    {
        expect( checkPackFiles( GOOD, { read : () => '{nope' } ) ).toEqual( [ 'dist/index.js.map: invalid source map JSON' ] );
        expect( checkPackFiles( GOOD, { read : () => undefined } ) ).toEqual( [] );
    } );
} );
