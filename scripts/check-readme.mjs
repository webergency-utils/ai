#!/usr/bin/env node
// Compiles README snippets tagged `<!-- check -->` against the package types (R18) and verifies
// that the runtime claim in the README matches `engines.node` (R19).
//
// Usage: node scripts/check-readme.mjs [--readme <file>] [--types dist|src]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSnippets, mapDiagnostics } from './lib/readme-snippets.mjs';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const argv = process.argv.slice( 2 );
const option = ( name, fallback ) => { const i = argv.indexOf( name ); return i >= 0 ? argv[i + 1] : fallback; };

const readmePath = path.resolve( option( '--readme', path.join( root, 'README.md' ) ) );
const typesFrom = option( '--types', 'dist' );
const markdown = readFileSync( readmePath, 'utf8' );
const pkg = JSON.parse( readFileSync( path.join( root, 'package.json' ), 'utf8' ) );
const problems = [];

if( readmePath === path.join( root, 'README.md' ) && !markdown.includes( `Node.js \`${ pkg.engines.node }\`` ) )
{
    problems.push( `README.md: must state "Node.js \`${ pkg.engines.node }\`" (derived from package.json engines.node)` );
}

const snippets = extractSnippets( markdown );

if( snippets.length === 0 )
{
    problems.push( 'README.md: no <!-- check --> snippets found' );
}

if( snippets.length )
{
    const work = mkdtempSync( path.join( tmpdir(), 'readme-check-' ) );

    try
    {
        snippets.forEach( ( snippet, index ) => writeFileSync( path.join( work, `snippet-${ index }.ts` ), snippet.code ) );

        const target = ( sub ) => ( typesFrom === 'src' ? `${ root }/src/${ sub }` : `${ root }/dist/${ sub }` ).replace( /\\/g, '/' );
        const mapping = { '@webergency-utils/ai' : [ target( 'index' ) ] };

        for( const sub of [ 'core', 'providers', 'storage', 'mcp', 'spend', 'agent', 'workflow', 'trace' ] )
        {
            mapping[`@webergency-utils/ai/${ sub }`] = [ target( `${ sub }/index` ) ];
        }

        writeFileSync( path.join( work, 'tsconfig.json' ), JSON.stringify(
        {
            compilerOptions :
            {
                target : 'ES2022', module : 'ESNext', moduleResolution : 'bundler', strict : true, noEmit : true,
                skipLibCheck : true, esModuleInterop : true, resolveJsonModule : true,
                noUnusedLocals : false, types : [ 'node' ], typeRoots : [ path.join( root, 'node_modules', '@types' ) ],
                baseUrl : work, paths : mapping
            },
            include : [ '*.ts' ]
        } ) );

        const tsc = path.join( root, 'node_modules', 'typescript', 'bin', 'tsc' );
        const result = spawnSync( process.execPath, [ tsc, '-p', path.join( work, 'tsconfig.json' ), '--pretty', 'false' ], { encoding : 'utf8', cwd : work } );
        const output = `${ result.stdout }${ result.stderr }`;

        if( result.status !== 0 )
        {
            const mapped = mapDiagnostics( output, snippets );
            problems.push( ...( mapped.length ? mapped : [ output.trim() ] ) );
        }
    }
    finally
    {
        rmSync( work, { recursive : true, force : true } );
    }
}

if( problems.length )
{
    console.error( 'check-readme: FAILED' );
    for( const problem of problems ) console.error( `  ${ problem }` );
    process.exit( 1 );
}

console.log( `check-readme: ok (${ snippets.length } snippet(s) compiled against ${ typesFrom })` );
