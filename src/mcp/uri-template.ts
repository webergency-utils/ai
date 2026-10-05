import { AIError } from '../core/error.js';

export interface CompiledUriTemplate
{
    /** Variable names in order of appearance. */
    variables : string[]
    /** Matches a concrete URI; returns percent-decoded variables or undefined when it does not match. */
    match( uri: string ): Record<string, string> | undefined
}

const VARIABLE_NAME = /^[A-Za-z0-9_]+$/;
// RFC 6570 level 1 simple expansion only ever produces unreserved characters or percent-encoded octets.
const VARIABLE_PATTERN = '((?:[A-Za-z0-9\\-._~]|%[0-9A-Fa-f]{2})+)';

function invalid( template: string, reason: string ): AIError
{
    return new AIError( 
        `Invalid MCP resource URI template '${template}': ${reason}`, 
        'MCP_INVALID_URI_TEMPLATE', 
        { template, reason } 
    );
}

/**
 * Compiles an RFC 6570 **level 1** template (`{var}` only). Operators (`+ # . / ; ? &`), modifiers (`*`, `:n`),
 * lists, adjacent variables and repeated names are rejected at registration, never silently mis-matched.
 */
export function compileUriTemplate( template: string ): CompiledUriTemplate
{
    if( typeof template !== 'string' || template === '' )
    {
        throw invalid( String( template ), 'template must be a non-empty string' );
    }

    const variables: string[] = [];
    let pattern = '';
    let literal = '';
    let lastWasVariable = false;
    let i = 0;

    const flushLiteral = (): void => 
    {
        if( literal !== '' )
        {
            pattern += literal.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
            literal = '';
            lastWasVariable = false;
        }
    };

    while( i < template.length )
    {
        const char = template[i];

        if( char === '}' )
        {
            throw invalid( template, `unmatched '}' at position ${i}` );
        }

        if( char !== '{' )
        {
            literal += char;
            i++;
            continue;
        }

        const close = template.indexOf( '}', i );

        if( close === -1 )
        {
            throw invalid( template, `unterminated '{' at position ${i}` );
        }

        const name = template.slice( i + 1, close );

        if( !VARIABLE_NAME.test( name ) )
        {
            throw invalid( template, `only level-1 '{var}' expressions are supported, got '{${name}}'` );
        }

        if( variables.includes( name ) )
        {
            throw invalid( template, `variable '${name}' appears more than once` );
        }

        flushLiteral();

        if( lastWasVariable )
        {
            throw invalid( template, `variables '${variables[variables.length - 1]}' and '${name}' are adjacent with no separator, so matching would be ambiguous` );
        }

        variables.push( name );
        pattern += VARIABLE_PATTERN;
        lastWasVariable = true;
        i = close + 1;
    }

    flushLiteral();

    if( variables.length === 0 )
    {
        throw invalid( template, 'it declares no variables; register it with registerResource() instead' );
    }

    const matcher = new RegExp( `^${pattern}$` );

    return {
        variables,
        match( uri: string ): Record<string, string> | undefined
        {
            const result = matcher.exec( uri );

            if( !result )
            {
                return undefined;
            }

            const values: Record<string, string> = {};

            try
            {
                variables.forEach( ( name, index ) => 
                {
                    values[name] = decodeURIComponent( result[index + 1] );
                } );
            }
            catch
            {
                // Percent-escapes that are not valid UTF-8 cannot be a legitimate expansion.
                return undefined;
            }

            return values;
        }
    };
}
