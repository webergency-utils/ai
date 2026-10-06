/**
 * Pure release guard (R21). Returns a list of problems; empty means the release may proceed.
 * @param {{ tag?: string, version: string, sha?: string, requireMain?: boolean, isOnMain?: ( sha: string ) => boolean }} input
 * @returns {string[]}
 */
export function checkRelease( { tag, version, sha, requireMain = false, isOnMain } )
{
    const problems = [];

    if( !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test( version ) )
    {
        problems.push( `package.json version "${ version }" is not valid semver` );
    }

    if( tag !== undefined && tag !== '' )
    {
        const stripped = tag.startsWith( 'v' ) ? tag.slice( 1 ) : tag;

        if( stripped !== version )
        {
            problems.push( `release tag "${ tag }" does not match package.json version "${ version }"` );
        }
    }
    else if( requireMain )
    {
        problems.push( 'a release tag is required for a real publish' );
    }

    if( requireMain )
    {
        if( !sha || !isOnMain )
        {
            problems.push( 'cannot verify that the release commit is on main (missing sha or ancestry check)' );
        }
        else if( !isOnMain( sha ) )
        {
            problems.push( `release commit ${ sha } is not reachable from main` );
        }
    }

    return problems;
}
