#!/usr/bin/env node
// One command that equals CI's quality gates (success criterion): `npm run release:check`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Same order as the `quality` and `coverage` jobs in .github/workflows/ci.yml.
const steps =
[
    [ 'lint' ],
    [ 'typecheck' ],
    [ 'build' ],
    [ 'test:coverage' ],
    [ 'check:pack' ],
    [ 'lint:package' ],
    [ 'smoke:pack' ],
    [ 'check:readme' ],
    [ 'gen:capabilities', '--', '--check' ]
];

for( const [ script, ...rest ] of steps )
{
    console.log( `\n==> npm run ${ [ script, ...rest ].join( ' ' ) }` );

    const result = spawnSync( npm, [ 'run', script, ...rest ], { cwd : root, stdio : 'inherit', shell : process.platform === 'win32' } );

    if( result.status !== 0 )
    {
        console.error( `\nrelease:check failed at "${ script }"` );
        process.exit( result.status ?? 1 );
    }
}

console.log( '\nrelease:check: all gates passed' );
