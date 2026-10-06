#!/usr/bin/env node
// Packed-artifact smoke test (R7): pack -> install into a temp consumer -> import every subpath at
// runtime -> compile a TypeScript consumer against the shipped .d.ts under NodeNext and bundler.
//
// Usage: node scripts/smoke-pack.mjs [--runtime=node|bun] [--skip-types] [--keep]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const args = new Set( process.argv.slice( 2 ) );
const runtime = [ ...args ].find( ( a ) => a.startsWith( '--runtime=' ) )?.slice( 10 ) ?? 'node';
const skipTypes = args.has( '--skip-types' );
const keep = args.has( '--keep' );
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function run( cmd, cmdArgs, options = {} )
{
    const result = spawnSync( cmd, cmdArgs, { encoding : 'utf8', shell : isWin, ...options } );

    if( result.status !== 0 )
    {
        const output = `${ result.stdout ?? '' }${ result.stderr ?? '' }`.trim();
        throw new Error( `${ cmd } ${ cmdArgs.join( ' ' ) } exited with ${ result.status }\n${ output }` );
    }

    return result.stdout;
}

const work = mkdtempSync( path.join( tmpdir(), 'ai-smoke-' ) );
let failed = false;

try
{
    console.log( 'smoke-pack: packing…' );
    const packOut = run( npm, [ 'pack', '--json', '--pack-destination', work ], { cwd : root } );
    const [ report ] = JSON.parse( packOut.slice( packOut.indexOf( '[' ) ) );
    const tarball = path.join( work, report.filename );

    const consumer = path.join( work, 'consumer' );
    mkdirSync( consumer );
    writeFileSync( path.join( consumer, 'package.json' ), JSON.stringify( { name : 'smoke-consumer', private : true, type : 'module' } ) );

    console.log( 'smoke-pack: installing tarball into a clean project…' );
    run( npm, [ 'install', '--no-audit', '--no-fund', '--ignore-scripts', tarball ], { cwd : consumer } );

    for( const peer of [ 'openai', '@anthropic-ai/sdk', '@google/genai', 'ollama' ] )
    {
        if( existsSync( path.join( consumer, 'node_modules', peer ) ) )
        {
            throw new Error( `optional peer "${ peer }" was installed automatically; peers must stay optional` );
        }
    }

    // Every file named by `exports`/`main`/`types` must exist in the installed package. TypeScript
    // silently falls back from a wrong `types` path to a sibling `.d.ts`, so check the paths directly.
    const installed = path.join( consumer, 'node_modules', '@webergency-utils', 'ai' );
    const manifest = JSON.parse( readFileSync( path.join( installed, 'package.json' ), 'utf8' ) );
    const targets = [];
    const collect = ( value ) =>
    {
        if( typeof value === 'string' ) targets.push( value );
        else if( value && typeof value === 'object' ) Object.values( value ).forEach( collect );
    };

    collect( manifest.exports );
    collect( manifest.main );
    collect( manifest.types );

    const missing = targets.filter( ( target ) => !existsSync( path.join( installed, target ) ) );

    if( missing.length )
    {
        throw new Error( `package.json points at files that are not in the tarball: ${ missing.join( ', ' ) }` );
    }

    copyFileSync( path.join( root, 'scripts', 'fixtures', 'smoke-imports.mjs' ), path.join( consumer, 'smoke-imports.mjs' ) );

    console.log( `smoke-pack: importing every subpath under ${ runtime }…` );
    process.stdout.write( run( runtime === 'bun' ? 'bun' : process.execPath, [ 'smoke-imports.mjs' ], { cwd : consumer } ) );

    if( !skipTypes )
    {
        // Reuse the repo's TypeScript and Node typings instead of downloading them again.
        const nm = path.join( consumer, 'node_modules' );
        mkdirSync( path.join( nm, '@types' ), { recursive : true } );
        symlinkSync( path.join( root, 'node_modules', '@types', 'node' ), path.join( nm, '@types', 'node' ), 'junction' );
        const tsc = path.join( root, 'node_modules', 'typescript', 'bin', 'tsc' );

        copyFileSync( path.join( root, 'scripts', 'fixtures', 'consumer.ts' ), path.join( consumer, 'consumer.ts' ) );

        for( const [ label, module, moduleResolution ] of [ [ 'NodeNext', 'NodeNext', 'NodeNext' ], [ 'bundler', 'ESNext', 'bundler' ] ] )
        {
            writeFileSync( path.join( consumer, `tsconfig.${ label }.json` ), JSON.stringify(
            {
                compilerOptions : { target : 'ES2022', module, moduleResolution, strict : true, noEmit : true, skipLibCheck : false, types : [ 'node' ], resolveJsonModule : true },
                files           : [ 'consumer.ts' ]
            } ) );

            console.log( `smoke-pack: type-checking consumer (moduleResolution: ${ label })…` );
            run( process.execPath, [ tsc, '-p', `tsconfig.${ label }.json` ], { cwd : consumer } );
        }
    }

    console.log( `smoke-pack: ok (${ report.name }@${ report.version }, ${ report.files.length } files)` );
}
catch( error )
{
    failed = true;
    console.error( `smoke-pack: FAILED\n${ error.message }` );
}
finally
{
    if( keep )
    {
        console.log( `smoke-pack: kept ${ work } (${ readdirSync( work ).join( ', ' ) })` );
    }
    else
    {
        rmSync( work, { recursive : true, force : true } );
    }
}

process.exit( failed ? 1 : 0 );
