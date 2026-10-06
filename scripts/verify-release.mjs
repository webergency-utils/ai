#!/usr/bin/env node
// Guard run by publish.yml before `npm publish` (R21).
// Usage: node scripts/verify-release.mjs [--tag <tag>] [--require-main] [--main-ref origin/main]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkRelease } from './lib/release-guard.mjs';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const argv = process.argv.slice( 2 );
const option = ( name ) => { const i = argv.indexOf( name ); return i >= 0 ? argv[i + 1] : undefined; };

const tag = option( '--tag' );
const mainRef = option( '--main-ref' ) ?? 'origin/main';
const requireMain = argv.includes( '--require-main' );
const { version } = JSON.parse( readFileSync( path.join( root, 'package.json' ), 'utf8' ) );

const git = ( ...gitArgs ) => spawnSync( 'git', gitArgs, { cwd : root, encoding : 'utf8' } );
const sha = git( 'rev-list', '-n', '1', tag ? tag : 'HEAD' ).stdout.trim() || undefined;

const problems = checkRelease(
{
    tag,
    version,
    sha,
    requireMain,
    isOnMain : ( commit ) => git( 'merge-base', '--is-ancestor', commit, mainRef ).status === 0
});

if( problems.length )
{
    console.error( 'verify-release: refusing to publish:' );
    for( const problem of problems ) console.error( `  - ${ problem }` );
    process.exit( 1 );
}

console.log( `verify-release: ok (version ${ version }${ tag ? `, tag ${ tag }` : '' }${ requireMain ? `, on ${ mainRef }` : '' })` );
