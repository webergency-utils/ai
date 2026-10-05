#!/usr/bin/env node
/**
 * Run Jazzer.js against a fuzz target using the local @jazzer.js/core install.
 * Usage: node scripts/run-fuzz.mjs <target.cjs> [-- -runs=N]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire( import.meta.url );
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

let jazzerBin;

try
{
    const pkg = require.resolve( '@jazzer.js/core/package.json' );
    const pkgDir = path.dirname( pkg );
    jazzerBin = path.join( pkgDir, 'dist', 'cli.js' );
}
catch
{
    console.error( 'Missing @jazzer.js/core. Install it with: npm i -D @jazzer.js/core' );
    process.exit( 1 );
}

const args = process.argv.slice( 2 );

if( args.length === 0 )
{
    console.error( 'Usage: node scripts/run-fuzz.mjs <fuzz_target.cjs> [-- jazzer-args...]' );
    process.exit( 1 );
}

const target = path.resolve( root, args[0] );
const sep = args.indexOf( '--' );
const libFuzzerArgs = sep === -1 
    ? [ '-runs=1000', '-max_total_time=60' ] 
    : args.slice( sep + 1 );

// Jazzer.js options come first; libFuzzer flags must follow `--`.
const result = spawnSync( 
    process.execPath, 
    [ jazzerBin, target, '--', ...libFuzzerArgs ], 
    { stdio : 'inherit', cwd : root } 
);

process.exit( result.status ?? 1 );
