import path from 'node:path';

/** Paths (or prefixes ending in `/`) that may appear in the published tarball. */
export const ALLOWED = [
    'dist/',
    'src/',
    'package.json',
    'README.md',
    'LICENSE',
    'SECURITY.md',
    'CHANGELOG.md'
];

/** Substring / regex patterns that must never appear in the tarball, even under an allowed prefix. */
export const DENIED = [
    { name: 'tests', test: ( p ) => /(^|\/)tests?\//.test( p ) },
    { name: 'fixtures', test: ( p ) => /(^|\/)fixtures?\//.test( p ) },
    { name: 'scratch', test: ( p ) => /(^|\/)scratch\//.test( p ) },
    { name: 'fuzz harness', test: ( p ) => /(^|\/)fuzz[^/]*\.(c|m)?js$/.test( p ) },
    { name: 'dotenv', test: ( p ) => /(^|\/)\.env(\.|$)/.test( p ) },
    { name: 'tsbuildinfo', test: ( p ) => /\.tsbuildinfo$/.test( p ) },
    { name: 'coverage output', test: ( p ) => /(^|\/)coverage\//.test( p ) },
    { name: 'tarball', test: ( p ) => /\.tgz$/.test( p ) }
];

/**
 * Validate a tarball file list.
 * @param {string[]} files    Paths relative to the package root (as reported by `npm pack --json`).
 * @param {{ read?: ( file: string ) => string | undefined }} [options]  `read` returns file text (used for `.map` files).
 * @returns {string[]} human-readable problems (empty when valid)
 */
export function checkPackFiles( files, options = {} )
{
    const problems = [];
    const set = new Set( files );

    for( const file of files )
    {
        const denied = DENIED.find( ( rule ) => rule.test( file ) );

        if( denied )
        {
            problems.push( `${ file }: denied (${ denied.name })` );
            continue;
        }

        const allowed = ALLOWED.some( ( entry ) => entry.endsWith( '/' ) ? file.startsWith( entry ) : file === entry );

        if( !allowed )
        {
            problems.push( `${ file }: not in allowlist` );
        }
    }

    for( const required of [ 'package.json', 'README.md', 'LICENSE' ] )
    {
        if( !set.has( required ) )
        {
            problems.push( `${ required }: missing from tarball` );
        }
    }

    if( !files.some( ( file ) => file.startsWith( 'dist/' ) && file.endsWith( '.js' ) ) )
    {
        problems.push( 'dist/: no compiled JavaScript present (run the build before packing)' );
    }

    for( const file of files.filter( ( f ) => f.endsWith( '.map' ) ) )
    {
        const text = options.read?.( file );

        if( text === undefined )
        {
            continue;
        }

        let map;

        try
        {
            map = JSON.parse( text );
        }
        catch
        {
            problems.push( `${ file }: invalid source map JSON` );
            continue;
        }

        for( const source of map.sources ?? [] )
        {
            const resolved = path.posix.normalize( path.posix.join( path.posix.dirname( file ), source ) );

            if( !set.has( resolved ) )
            {
                problems.push( `${ file }: source "${ source }" resolves to ${ resolved}, which is not in the tarball` );
            }
        }
    }

    return problems;
}
