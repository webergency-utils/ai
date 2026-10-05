import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../..' );

describe( 'decision types are checked at compile time (R5, R18, AE1)', () =>
{
    it( 'accepts typed usage and rejects misspelled labels, unknown questions, and undeclared branches', () =>
    {
        const tsc = path.join( root, 'node_modules/typescript/bin/tsc' );
        const result = spawnSync( process.execPath, [ tsc, '-p', path.join( root, 'tests/decision/types/tsconfig.json' ) ], { encoding : 'utf8', cwd : root } );

        // An unused @ts-expect-error is itself a compile error, so a pass proves every bad line failed to compile.
        expect( result.stdout + result.stderr ).toBe( '' );
        expect( result.status ).toBe( 0 );
    }, 60_000 );
} );
