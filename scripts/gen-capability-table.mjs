#!/usr/bin/env node
// Regenerates the provider capability table in README.md from the adapters' real capability flags
// (R17). `--check` fails when the README block is out of date instead of rewriting it.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderCapabilityTable, replaceBlock } from './lib/capability-table.mjs';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const check = process.argv.includes( '--check' );
const { createModel, defaultRegistry } = await import( pathToFileURL( path.join( root, 'dist', 'index.js' ) ).href );

const PROVIDERS = [ 'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'deepseek', 'ollama' ];
const missing = PROVIDERS.filter( ( p ) => !defaultRegistry.has( p ) );

if( missing.length )
{
    console.error( `gen-capability-table: provider(s) not registered: ${ missing.join( ', ' ) }` );
    process.exit( 1 );
}

const byProvider = Object.fromEntries( PROVIDERS.map( ( provider ) => [ provider, createModel( { provider, model : 'capability-probe', apiKey : 'probe' } ).capabilities ] ) );
const readmePath = path.join( root, 'README.md' );
const current = readFileSync( readmePath, 'utf8' );
const next = replaceBlock( current, renderCapabilityTable( byProvider ) );

if( next === current )
{
    console.log( 'gen-capability-table: README is up to date' );
}
else if( check )
{
    console.error( 'gen-capability-table: README capability table is stale; run `npm run gen:capabilities`' );
    process.exit( 1 );
}
else
{
    writeFileSync( readmePath, next );
    console.log( 'gen-capability-table: README updated' );
}
