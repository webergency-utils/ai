/**
 * Extract README snippets tagged `<!-- check -->` (R18).
 * A tag applies to the next fenced `typescript` block (blank lines allowed in between).
 * @param {string} markdown
 * @returns {{ code: string, line: number }[]}  `line` is the 1-based README line of the first code line.
 */
export function extractSnippets( markdown )
{
    const lines = markdown.split( '\n' );
    const snippets = [];

    for( let i = 0; i < lines.length; i++ )
    {
        if( lines[i].trim() !== '<!-- check -->' )
        {
            continue;
        }

        let j = i + 1;

        while( j < lines.length && lines[j].trim() === '' )
        {
            j++;
        }

        if( !/^```(typescript|ts)\s*$/.test( lines[j] ?? '' ) )
        {
            throw new Error( `README.md:${ i + 1 }: <!-- check --> must be followed by a fenced typescript block` );
        }

        const start = j + 1;
        let end = start;

        while( end < lines.length && !/^```\s*$/.test( lines[end] ) )
        {
            end++;
        }

        if( end >= lines.length )
        {
            throw new Error( `README.md:${ j + 1 }: unterminated code fence` );
        }

        snippets.push( { code : lines.slice( start, end ).join( '\n' ), line : start + 1 } );
        i = end;
    }

    return snippets;
}

/**
 * Map `tsc` diagnostics for `snippet-<n>.ts` files back to README lines.
 * @param {string} output   Raw tsc stdout
 * @param {{ line: number }[]} snippets
 * @returns {string[]} e.g. `README.md:142:5 error TS2305: ...`
 */
export function mapDiagnostics( output, snippets )
{
    const mapped = [];

    for( const raw of output.split( '\n' ) )
    {
        const match = /snippet-(\d+)\.ts\((\d+),(\d+)\): (error TS\d+: .*)$/.exec( raw.trim() );

        if( !match )
        {
            continue;
        }

        const snippet = snippets[Number( match[1] )];
        const readmeLine = ( snippet?.line ?? 1 ) + Number( match[2] ) - 1;

        mapped.push( `README.md:${ readmeLine }:${ match[3] } ${ match[4] }` );
    }

    return mapped;
}
