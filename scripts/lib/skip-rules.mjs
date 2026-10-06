import path from 'node:path';

/**
 * Find skipped/todo tests in a vitest JSON report that are not covered by the allowlist (R11).
 * @param {{ testResults: { name: string, assertionResults: { status: string, fullName?: string, title?: string }[] }[] }} report
 * @param {{ file: string }[]} allow  Repo-relative POSIX file paths whose skips are expected.
 * @param {string} [cwd]              Used to relativise absolute report paths.
 * @returns {{ file: string, test: string, status: string }[]}
 */
export function findUnexpectedSkips( report, allow, cwd = process.cwd() )
{
    const allowed = new Set( allow.map( ( entry ) => entry.file ) );
    const unexpected = [];

    for( const result of report.testResults ?? [] )
    {
        const file = path.relative( cwd, result.name ).split( path.sep ).join( '/' );

        for( const test of result.assertionResults ?? [] )
        {
            if( ![ 'skipped', 'pending', 'todo', 'disabled' ].includes( test.status ) )
            {
                continue;
            }

            if( !allowed.has( file ) )
            {
                unexpected.push( { file, test : test.fullName ?? test.title ?? '(unnamed)', status : test.status } );
            }
        }
    }

    return unexpected;
}
