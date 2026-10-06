import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSnippets, mapDiagnostics } from '../../scripts/lib/readme-snippets.mjs';
import { END, START, renderCapabilityTable, replaceBlock } from '../../scripts/lib/capability-table.mjs';
import { createModel, defaultRegistry } from '../../src/providers/registry.js';

const root = fileURLToPath( new URL( '../../', import.meta.url ) );
const readme = readFileSync( path.join( root, 'README.md' ), 'utf8' );
const pkg = JSON.parse( readFileSync( path.join( root, 'package.json' ), 'utf8' ) );

describe( 'extractSnippets (R18)', () =>
{
    it( 'extracts only tagged typescript fences with their README line', () =>
    {
        const md = [ '# t', '```typescript', 'untagged();', '```', '', '<!-- check -->', '', '```typescript', 'const a = 1;', 'const b = 2;', '```', '' ].join( '\n' );

        expect( extractSnippets( md ) ).toEqual( [ { code : 'const a = 1;\nconst b = 2;', line : 9 } ] );
    } );

    it( 'rejects a tag without a typescript fence and unterminated fences', () =>
    {
        expect( () => extractSnippets( '<!-- check -->\n\ntext' ) ).toThrow( /README\.md:1/ );
        expect( () => extractSnippets( '<!-- check -->\n```ts\nconst a = 1;' ) ).toThrow( /unterminated/ );
    } );

    it( 'maps tsc diagnostics back to README lines and ignores noise', () =>
    {
        const out = [ 'snippet-1.ts(3,7): error TS2304: Cannot find name \'x\'.', 'noise', 'snippet-0.ts(1,1): error TS1005: oops' ].join( '\n' );

        expect( mapDiagnostics( out, [ { line : 10 }, { line : 40 } ] ) ).toEqual( [
            'README.md:42:7 error TS2304: Cannot find name \'x\'.',
            'README.md:10:1 error TS1005: oops'
        ] );
    } );
} );

describe( 'README accuracy (R17-R19)', () =>
{
    it( 'AE9: check-readme fails with the TypeScript error and README line for a renamed export', () =>
    {
        const dir = mkdtempSync( path.join( tmpdir(), 'readme-ae9-' ) );

        try
        {
            const file = path.join( dir, 'README.md' );
            writeFileSync( file, [ '# Broken', '', 'text', '<!-- check -->', '```typescript', 'import { createModell } from \'@webergency-utils/ai\';', 'createModell;', '```' ].join( '\n' ) );

            const result = spawnSync( process.execPath, [ path.join( root, 'scripts', 'check-readme.mjs' ), '--readme', file, '--types', 'src' ], { encoding : 'utf8' } );

            expect( result.status ).toBe( 1 );
            expect( result.stderr ).toContain( 'README.md:6:10' );
            expect( result.stderr ).toContain( 'createModell' );
        }
        finally
        {
            rmSync( dir, { recursive : true, force : true } );
        }
    }, 60_000 );

    it( 'the generated capability block matches the adapters\' real flags', () =>
    {
        const providers = [ 'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'deepseek', 'ollama' ];

        for( const provider of providers )
        {
            expect( defaultRegistry.has( provider ), provider ).toBe( true );
        }

        const table = renderCapabilityTable( Object.fromEntries( providers.map( ( provider ) =>
            [ provider, createModel( { provider, model : 'capability-probe', apiKey : 'probe' } ).capabilities! ] ) ) );

        expect( replaceBlock( readme, table ) ).toBe( readme );
        expect( readme ).toContain( START );
        expect( readme ).toContain( END );
    } );

    it( 'replaceBlock requires both markers', () =>
    {
        expect( () => replaceBlock( 'no markers', 'x' ) ).toThrow( /must contain/ );
    } );

    it( 'states the Node range from engines.node and no stale claims', () =>
    {
        expect( readme ).toContain( `Node.js \`${ pkg.engines.node }\`` );
        expect( readme ).not.toMatch( /coverage-100/ );
        expect( readme ).not.toMatch( /Node\.js \(20\+\)/ );
        expect( readme ).not.toMatch( /createModel\( config: ModelConfig \): ModelProtocol/ );
        expect( readme ).toContain( 'ESM-only' );
    } );

    it( 'SECURITY.md lists 0.x as supported and the changelog has a 0.1.0 entry', () =>
    {
        const security = readFileSync( path.join( root, 'SECURITY.md' ), 'utf8' );
        const changelog = readFileSync( path.join( root, 'CHANGELOG.md' ), 'utf8' );

        expect( security ).toMatch( /\|\s*0\.x\s*\|/ );
        expect( security ).not.toMatch( /\|\s*1\.x\s*\|/ );
        expect( changelog ).toMatch( /## \[0\.1\.0\]/ );
        expect( changelog ).toMatch( /Keep a Changelog/ );
    } );
} );
