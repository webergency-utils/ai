import { describe, it, expect } from 'vitest';
import { findUnexpectedSkips, type VitestJsonReport } from '../../scripts/lib/skip-rules.mjs';

const cwd = '/repo';
const report = ( files: Record<string, string[]> ): VitestJsonReport => ( {
    testResults : Object.entries( files ).map( ( [ file, statuses ] ) => ( {
        name             : `${ cwd }/${ file }`,
        assertionResults : statuses.map( ( status, i ) => ( { status, fullName : `case ${ i }` } ) )
    } ) )
} );

describe( 'findUnexpectedSkips (R11)', () =>
{
    const allow = [ { file : 'tests/storage/contract.test.ts' } ];

    it( 'accepts a fully-passing suite', () =>
    {
        expect( findUnexpectedSkips( report( { 'tests/a.test.ts' : [ 'passed' ] } ), allow, cwd ) ).toEqual( [] );
    } );

    it( 'accepts skips in allowlisted files', () =>
    {
        expect( findUnexpectedSkips( report( { 'tests/storage/contract.test.ts' : [ 'skipped', 'passed' ] } ), allow, cwd ) ).toEqual( [] );
    } );

    it( 'reports skipped, pending and todo tests elsewhere with file and name', () =>
    {
        const result = findUnexpectedSkips( report( { 'tests/a.test.ts' : [ 'skipped', 'todo', 'pending', 'failed' ] } ), allow, cwd );
        expect( result.map( ( r ) => r.status ) ).toEqual( [ 'skipped', 'todo', 'pending' ] );
        expect( result[0] ).toEqual( { file : 'tests/a.test.ts', test : 'case 0', status : 'skipped' } );
    } );

    it( 'tolerates an empty report and missing titles', () =>
    {
        expect( findUnexpectedSkips( { testResults : [] }, allow, cwd ) ).toEqual( [] );
        const nameless = { testResults : [ { name : `${ cwd }/x.test.ts`, assertionResults : [ { status : 'skipped' } ] } ] };
        expect( findUnexpectedSkips( nameless, allow, cwd )[0]!.test ).toBe( '(unnamed)' );
    } );
} );
