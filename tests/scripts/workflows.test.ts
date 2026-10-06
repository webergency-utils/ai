import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath( new URL( '../../.github/workflows/', import.meta.url ) );
const pkg = JSON.parse( readFileSync( fileURLToPath( new URL( '../../package.json', import.meta.url ) ), 'utf8' ) );
const files = readdirSync( dir ).filter( ( f ) => f.endsWith( '.yml' ) );
const read = ( f: string ) => readFileSync( dir + f, 'utf8' );

describe( 'workflow hardening (R8, R10, R20-R22)', () =>
{
    it( 'finds the workflows', () =>
    {
        expect( files ).toEqual( expect.arrayContaining( [ 'ci.yml', 'publish.yml', 'fuzz.yml' ] ) );
    } );

    it.each( files )( '%s pins every third-party action to a commit SHA with a version comment', ( file ) =>
    {
        const uses = read( file ).split( '\n' ).filter( ( l ) => /^\s*(-\s*)?uses:/.test( l ) );

        for( const line of uses )
        {
            expect( line, line ).toMatch( /uses:\s+[\w./-]+@[0-9a-f]{40}\s+#\s*v?\d+/ );
        }
    } );

    it.each( files )( '%s declares top-level permissions without write scopes', ( file ) =>
    {
        const text = read( file );
        const top = text.match( /^permissions:[ \t]*\n((?:[ \t]+\S.*\n)+)/m );
        expect( top, 'top-level permissions block' ).not.toBeNull();
        expect( top![1] ).not.toMatch( /write/ );
        expect( text ).not.toMatch( /read-all|write-all/ );
    } );

    it( 'fuzz workflow only references branches that exist', () =>
    {
        expect( read( 'fuzz.yml' ) ).not.toMatch( /master/ );
    } );

    it( 'CI Node matrix matches engines.node and includes Windows, macOS and Bun', () =>
    {
        const ci = read( 'ci.yml' );
        const minimum = Number( /(\d+)/.exec( pkg.engines.node )![1] );
        const matrix = /node-version:\s*\[\s*([\d,\s]+)\]/.exec( ci )![1]!.split( ',' ).map( ( n ) => Number( n.trim() ) );

        expect( Math.min( ...matrix ) ).toBe( minimum );
        expect( matrix ).toEqual( expect.arrayContaining( [ 20, 22, 24 ] ) );
        expect( ci ).toMatch( /windows-latest/ );
        expect( ci ).toMatch( /macos-latest/ );
        expect( ci ).toMatch( /oven-sh\/setup-bun/ );
        expect( ci ).toMatch( /check-skips/ );
    } );

    describe( 'publish.yml', () =>
    {
        const text = read( 'publish.yml' );
        const index = ( needle: string ) => text.indexOf( needle );

        it( 'runs on release and manual dispatch with dry_run defaulting to true', () =>
        {
            expect( text ).toMatch( /release:\s*\n\s+types:\s*\[\s*published\s*\]/ );
            expect( text ).toMatch( /workflow_dispatch:/ );
            expect( text ).toMatch( /dry_run:[\s\S]*?default:\s*true/ );
        } );

        it( 'pins npm to a major, never latest', () =>
        {
            expect( text ).not.toMatch( /npm@latest/ );
            expect( text ).toMatch( /npm@11/ );
        } );

        it( 'runs the quality gates before the version guard and publish, in order', () =>
        {
            const order = [ 'npm ci', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm run test:coverage', 'npm run smoke:pack', 'npm run lint:package', 'scripts/verify-release.mjs', 'npm publish --provenance --access public --dry-run' ];
            const positions = order.map( index );

            expect( positions.every( ( p ) => p >= 0 ), order.filter( ( o ) => index( o ) < 0 ).join() ).toBe( true );
            expect( [ ...positions ].sort( ( a, b ) => a - b ) ).toEqual( positions );
        } );

        it( 'publishes with provenance and supports --dry-run', () =>
        {
            expect( text ).toMatch( /npm publish[^\n]*--provenance/ );
            expect( text ).toMatch( /--dry-run/ );
        } );
    } );
} );
