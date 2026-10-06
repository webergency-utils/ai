#!/usr/bin/env node
// Fails when the default suite skips tests outside scripts/skip-allowlist.json (R11).
// Usage: node scripts/check-skips.mjs [vitest-report.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findUnexpectedSkips } from './lib/skip-rules.mjs';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const reportPath = process.argv[2] ?? path.join( root, 'vitest-report.json' );
const report = JSON.parse( readFileSync( reportPath, 'utf8' ) );
const { allow } = JSON.parse( readFileSync( path.join( root, 'scripts', 'skip-allowlist.json' ), 'utf8' ) );

const unexpected = findUnexpectedSkips( report, allow, root );

if( unexpected.length )
{
    console.error( `check-skips: ${ unexpected.length } unexpected skipped test(s):` );
    for( const { file, test, status } of unexpected.slice( 0, 50 ) ) console.error( `  - [${ status }] ${ file }: ${ test }` );
    process.exit( 1 );
}

console.log( `check-skips: ok (${ report.numPendingTests ?? 0 } allowlisted skips)` );
