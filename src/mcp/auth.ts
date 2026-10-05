import { AIError } from '../core/error.js';

/** One parsed `WWW-Authenticate` challenge. Parameter names are lower-cased. */
export interface MCPAuthChallenge
{
    scheme : string
    params : Record<string, string>
}

export interface MCPUnauthorizedInfo
{
    status             : 401
    /** Request URL without query string or credentials. */
    url                : string
    challenge?         : MCPAuthChallenge
    /** `resource_metadata` URL from the challenge (RFC 9728), when the server sent one. */
    resourceMetadata?  : string
}

export interface MCPAuthProvider
{
    /** Headers (typically `Authorization`) added to every request. Never logged or put in errors. */
    getHeaders(): Promise<Record<string, string>>
    /**
     * Called once per request on `401`. Return `true` after refreshing credentials to retry the request once;
     * `false` (or omit the hook) surfaces `MCPAuthError`.
     */
    onUnauthorized?( info: MCPUnauthorizedInfo ): Promise<boolean>
}

export interface MCPAuthOptions
{
    /** Static headers sent with every request. Treated as secret: never logged or put in errors. */
    headers?      : Record<string, string>
    authProvider? : MCPAuthProvider
}

/** Raised on HTTP 401 (`MCP_UNAUTHORIZED`) and 403 (`MCP_FORBIDDEN`). Carries no request headers. */
export class MCPAuthError extends AIError
{
    public readonly status             : 401 | 403;
    public readonly url                : string;
    public readonly challenge?         : MCPAuthChallenge;
    public readonly resourceMetadata?  : string;

    constructor( status: 401 | 403, url: string, challenge?: MCPAuthChallenge )
    {
        const resourceMetadata = challenge?.params.resource_metadata;

        super( 
            status === 401
                ? `MCP server rejected the credentials (HTTP 401)${challenge?.params.error ? `: ${challenge.params.error}` : ''}`
                : 'MCP server refused access (HTTP 403)', 
            status === 401 ? 'MCP_UNAUTHORIZED' : 'MCP_FORBIDDEN', 
            { status, url, challenge, resourceMetadata } 
        );
        this.name = 'MCPAuthError';
        this.status = status;
        this.url = url;
        this.challenge = challenge;
        this.resourceMetadata = resourceMetadata;
    }
}

const TOKEN_CHAR = /[^\s,="]/;

/**
 * Parses a `WWW-Authenticate` header value into challenges. Supports several comma-separated challenges,
 * token and quoted-string parameter values (with `\` escapes and commas inside quotes). `token68`
 * credentials are not supported and are ignored.
 */
export function parseWWWAuthenticate( header: string | null | undefined ): MCPAuthChallenge[]
{
    const challenges: MCPAuthChallenge[] = [];

    if( !header )
    {
        return challenges;
    }

    let i = 0;
    const n = header.length;

    const skipSeparators = (): void => 
    {
        while( i < n && ( header[i] === ',' || /\s/.test( header[i] ) ) )
        {
            i++;
        }
    };

    const skipSpaces = (): void => 
    {
        while( i < n && /\s/.test( header[i] ) )
        {
            i++;
        }
    };

    const readToken = (): string => 
    {
        const start = i;

        while( i < n && TOKEN_CHAR.test( header[i] ) )
        {
            i++;
        }

        return header.slice( start, i );
    };

    const readValue = (): string => 
    {
        if( header[i] !== '"' )
        {
            return readToken();
        }

        i++;
        let value = '';

        while( i < n && header[i] !== '"' )
        {
            if( header[i] === '\\' && i + 1 < n )
            {
                i++;
            }

            value += header[i++];
        }

        i++; // closing quote

        return value;
    };

    skipSeparators();

    while( i < n )
    {
        const scheme = readToken();

        if( scheme === '' )
        {
            // Stray '=' or '"': skip it so parsing always makes progress.
            i++;
            skipSeparators();
            continue;
        }

        const challenge: MCPAuthChallenge = { scheme, params : {} };
        challenges.push( challenge );

        while( true )
        {
            skipSeparators();

            if( i >= n )
            {
                break;
            }

            const mark = i;
            const name = readToken();
            skipSpaces();

            if( name !== '' && header[i] === '=' )
            {
                i++;
                skipSpaces();
                challenge.params[name.toLowerCase()] = readValue();
                continue;
            }

            // Not a parameter: the next challenge's scheme begins here.
            i = mark;
            break;
        }
    }

    return challenges;
}

/** Picks the Bearer challenge when present, otherwise the first one. */
export function selectChallenge( challenges: MCPAuthChallenge[] ): MCPAuthChallenge | undefined
{
    return challenges.find( ( c ) => {return c.scheme.toLowerCase() === 'bearer';} ) ?? challenges[0];
}

/** Builds the `WWW-Authenticate: Bearer ...` value the server handler sends. */
export function formatBearerChallenge( params: { resourceMetadata?: string, error?: string, errorDescription?: string, scope?: string } = {} ): string
{
    const quote = ( value: string ): string => {return `"${value.replace( /["\\]/g, '\\$&' )}"`;};
    const parts: string[] = [];

    if( params.error )
    {
        parts.push( `error=${quote( params.error )}` );
    }

    if( params.errorDescription )
    {
        parts.push( `error_description=${quote( params.errorDescription )}` );
    }

    if( params.scope )
    {
        parts.push( `scope=${quote( params.scope )}` );
    }

    if( params.resourceMetadata )
    {
        parts.push( `resource_metadata=${quote( params.resourceMetadata )}` );
    }

    return parts.length > 0 ? `Bearer ${parts.join( ', ' )}` : 'Bearer';
}

/** Static headers first, then the provider's (the provider wins on collisions). */
export async function applyAuth( options: MCPAuthOptions ): Promise<Record<string, string>>
{
    const provided = options.authProvider ? await options.authProvider.getHeaders() : {};

    return { ...( options.headers ?? {} ), ...provided };
}

function safeUrl( url: string ): string
{
    try
    {
        const parsed = new URL( url );

        return `${parsed.origin}${parsed.pathname}`;
    }
    catch
    {
        return '<invalid url>';
    }
}

export interface AuthorizedFetchInput
{
    fetch   : typeof fetch
    url     : string
    init    : Omit<RequestInit, 'headers'>
    /** Protocol headers (content type, session id, ...); auth headers are layered on top. */
    headers : () => Record<string, string>
    auth    : MCPAuthOptions
}

/**
 * The single place the 401/403 rule lives, shared by every HTTP transport:
 * 401 → `onUnauthorized` once → retry once → otherwise `MCPAuthError`; 403 → `MCPAuthError` (no retry).
 * Returned responses are never 401/403.
 */
export async function authorizedFetch( input: AuthorizedFetchInput ): Promise<Response>
{
    for( let attempt = 0; ; attempt++ )
    {
        const authHeaders = await applyAuth( input.auth );
        const headers = new Headers( input.headers() );

        for( const [ name, value ] of Object.entries( authHeaders ) )
        {
            headers.set( name, value );
        }

        const response = await input.fetch( input.url, { ...input.init, headers } );

        if( response.status === 403 )
        {
            await response.body?.cancel().catch( () => {} );

            throw new MCPAuthError( 403, safeUrl( input.url ) );
        }

        if( response.status !== 401 )
        {
            return response;
        }

        const challenge = selectChallenge( parseWWWAuthenticate( response.headers.get( 'www-authenticate' ) ) );
        await response.body?.cancel().catch( () => {} );

        const url = safeUrl( input.url );
        const provider = input.auth.authProvider;

        if( attempt === 0 && provider?.onUnauthorized )
        {
            const retry = await provider.onUnauthorized( { 
                status           : 401, 
                url, 
                challenge, 
                resourceMetadata : challenge?.params.resource_metadata 
            } );

            if( retry )
            {
                continue;
            }
        }

        throw new MCPAuthError( 401, url, challenge );
    }
}
