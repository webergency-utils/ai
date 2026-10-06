#!/usr/bin/env node
// Asserts that `npm pack` contains exactly what we intend to publish (R1).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkPackFiles } from './lib/pack-rules.mjs';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const raw = execFileSync( npm, [ 'pack', '--json', '--dry-run', '--ignore-scripts' ],
{
    cwd      : root,
    encoding : 'utf8',
    shell    : process.platform === 'win32',
    stdio    : [ 'ignore', 'pipe', 'pipe' ]
});

const [ report ] = JSON.parse( raw );
const files = report.files.map( ( f ) => f.path );

const problems = checkPackFiles( files,
{
    read : ( file ) =>
    {
        try { return readFileSync( path.join( root, file ), 'utf8' ); }
        catch { return undefined; }
    }
});

if( problems.length )
{
    console.error( `check-pack: ${ problems.length } problem(s) in ${ report.name }@${ report.version }:` );
    for( const problem of problems ) console.error( `  - ${ problem }` );
    process.exit( 1 );
}

console.log( `check-pack: ok (${ files.length } files, ${ ( report.unpackedSize / 1024 ).toFixed( 0 ) } kB unpacked)` );
