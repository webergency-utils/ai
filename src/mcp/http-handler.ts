import { AIError } from '../core/error.js';
import type { ExecutionContext } from '../agent/context.js';
import { formatBearerChallenge } from './auth.js';
import { 
    JSONRPC_INTERNAL_ERROR, 
    JSONRPC_INVALID_REQUEST, 
    JSONRPC_PARSE_ERROR, 
    isSupportedProtocolVersion 
} from './protocol.js';
import type { MCPServer, MCPServerConnection } from './server.js';
import type { JSONRPCMessage, JSONRPCResponse } from './types.js';

/** Outcome of `authenticate`. Anything that is not `{ ok: true }` is treated as a denial (fail closed). */
export type MCPHttpAuthResult =
    | { ok: true, context?: ExecutionContext }
    | { ok: false, error?: string, errorDescription?: string, scope?: string };

export interface MCPHttpHandlerOptions
{
    /** Issue `Mcp-Session-Id` on `initialize` and require it afterwards (default false: stateless). */
    sessions?             : boolean
    /**
     * Origins allowed to call the endpoint (DNS-rebinding guard). Default: only same-origin requests (an `Origin`
     * header, when present, must equal the request URL's origin). Requests without `Origin` are always allowed.
     * `'*'` allows any origin; use it only behind other protections.
     */
    allowedOrigins?       : string[]
    /** Runs before the body is read. Return `{ ok: false }` for a `401` with `WWW-Authenticate: Bearer`. */
    authenticate?         : ( req: Request ) => Promise<MCPHttpAuthResult>
    /** Advertised as `resource_metadata` in the `WWW-Authenticate` challenge (RFC 9728). */
    resourceMetadataUrl?  : string
    /** Request body cap in bytes (default 4 MiB); larger bodies get `413`. */
    maxBodyBytes?         : number
    /** Idle lifetime of a session (default 30 minutes). */
    sessionTtlMs?         : number
    /** Maximum concurrent sessions (default 1000); beyond that `initialize` gets `503`. */
    maxSessions?          : number
    /** Session id factory (default `crypto.randomUUID`). */
    generateSessionId?    : () => string
    /** Receives unexpected failures (an `authenticate` that throws, an internal error) alongside the `500` response. */
    onError?              : ( error: Error ) => void
}

interface Session
{
    connection : MCPServerConnection
    lastSeen   : number
}

function rpcErrorResponse( status: number, code: number, message: string, headers: Record<string, string> = {} ): Response
{
    const body: JSONRPCResponse = { jsonrpc : '2.0', id : null as unknown as number, error : { code, message } };

    return new Response( JSON.stringify( body ), { status, headers : { 'content-type' : 'application/json', ...headers } } );
}

async function readBody( req: Request, maxBytes: number ): Promise<string | undefined>
{
    const declared = Number( req.headers.get( 'content-length' ) );

    if( Number.isFinite( declared ) && declared > maxBytes )
    {
        await req.body?.cancel().catch( () => {} );

        return undefined;
    }

    if( !req.body )
    {
        return '';
    }

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while( true )
    {
        const { done, value } = await reader.read();

        if( done )
        {
            break;
        }

        total += value.byteLength;

        if( total > maxBytes )
        {
            await reader.cancel().catch( () => {} );

            return undefined;
        }

        chunks.push( value );
    }

    const merged = new Uint8Array( total );
    let offset = 0;

    for( const chunk of chunks )
    {
        merged.set( chunk, offset );
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode( merged );
}

function isValidMessage( value: unknown ): value is JSONRPCMessage
{
    if( !value || typeof value !== 'object' || Array.isArray( value ) )
    {
        return false;
    }

    const message = value as Record<string, unknown>;

    if( message.jsonrpc !== '2.0' )
    {
        return false;
    }

    if( typeof message.method === 'string' )
    {
        return message.id === undefined || typeof message.id === 'string' || typeof message.id === 'number';
    }

    return ( 'result' in message || 'error' in message ) && ( typeof message.id === 'string' || typeof message.id === 'number' );
}

/**
 * Mounts an `MCPServer` as a Streamable HTTP endpoint: a web-standard `( Request ) => Promise<Response>`
 * usable from Node 20+ (via an adapter), Bun, Deno and edge runtimes.
 *
 * POST handles single or batched JSON-RPC (JSON response, or `202` when nothing needs an answer);
 * GET is `405` (no server-initiated stream); DELETE ends a session when `sessions` is on.
 * Origin and authentication checks run before the body is read.
 */
export function createMCPHttpHandler( server: MCPServer, options: MCPHttpHandlerOptions = {} ): ( req: Request ) => Promise<Response>
{
    const sessionsEnabled = options.sessions === true;
    const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
    const sessionTtlMs = options.sessionTtlMs ?? 30 * 60 * 1000;
    const maxSessions = options.maxSessions ?? 1000;
    const generateSessionId = options.generateSessionId ?? ( () => {return crypto.randomUUID();} );
    const sessions = new Map<string, Session>();

    for( const [ name, value ] of [ [ 'maxBodyBytes', maxBodyBytes ], [ 'sessionTtlMs', sessionTtlMs ], [ 'maxSessions', maxSessions ] ] as const )
    {
        if( !Number.isFinite( value ) || value <= 0 )
        {
            throw new AIError( `createMCPHttpHandler ${name} must be a positive number, got ${String( value )}`, 'INVALID_INPUT' );
        }
    }

    const reportError = ( error: unknown ): void => 
    {
        options.onError?.( error instanceof Error ? error : new AIError( String( error ), 'MCP_SERVER_ERROR' ) );
    };

    const purgeExpired = (): void => 
    {
        const now = Date.now();

        for( const [ id, session ] of sessions )
        {
            if( now - session.lastSeen > sessionTtlMs )
            {
                sessions.delete( id );
            }
        }
    };

    const originAllowed = ( req: Request ): boolean => 
    {
        const origin = req.headers.get( 'origin' );

        if( origin === null )
        {
            return true;
        }

        if( options.allowedOrigins )
        {
            return options.allowedOrigins.includes( '*' ) || options.allowedOrigins.includes( origin );
        }

        try
        {
            return origin === new URL( req.url ).origin;
        }
        catch
        {
            return false;
        }
    };

    const lookupSession = ( req: Request ): Session | Response => 
    {
        const id = req.headers.get( 'mcp-session-id' );

        if( !id )
        {
            return rpcErrorResponse( 400, JSONRPC_INVALID_REQUEST, 'Missing Mcp-Session-Id header' );
        }

        const session = sessions.get( id );

        if( !session )
        {
            return rpcErrorResponse( 404, JSONRPC_INVALID_REQUEST, 'Unknown or expired session' );
        }

        return session;
    };

    const handlePost = async ( req: Request, context?: ExecutionContext ): Promise<Response> => 
    {
        const text = await readBody( req, maxBodyBytes );

        if( text === undefined )
        {
            return rpcErrorResponse( 413, JSONRPC_INVALID_REQUEST, `Request body exceeds ${maxBodyBytes} bytes` );
        }

        let parsed: unknown;

        try
        {
            parsed = JSON.parse( text );
        }
        catch
        {
            return rpcErrorResponse( 400, JSONRPC_PARSE_ERROR, 'Parse error' );
        }

        const batched = Array.isArray( parsed );
        const items: unknown[] = Array.isArray( parsed ) ? parsed : [ parsed ];

        if( items.length === 0 || !items.every( isValidMessage ) )
        {
            return rpcErrorResponse( 400, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC message' );
        }

        const messages = items as JSONRPCMessage[];
        const isInitialize = messages.some( ( m ) => {return 'method' in m && m.method === 'initialize';} );

        if( isInitialize && messages.length > 1 )
        {
            return rpcErrorResponse( 400, JSONRPC_INVALID_REQUEST, 'initialize must not be batched' );
        }

        if( !isInitialize )
        {
            const version = req.headers.get( 'mcp-protocol-version' );

            if( version !== null && !isSupportedProtocolVersion( version ) )
            {
                return rpcErrorResponse( 400, JSONRPC_INVALID_REQUEST, `Unsupported MCP-Protocol-Version '${String( version ).slice( 0, 40 )}'` );
            }
        }

        let connection: MCPServerConnection | undefined;

        if( sessionsEnabled )
        {
            purgeExpired();

            if( isInitialize )
            {
                if( sessions.size >= maxSessions )
                {
                    return rpcErrorResponse( 503, JSONRPC_INTERNAL_ERROR, 'Too many active sessions' );
                }

                connection = server.createConnection();
            }
            else
            {
                const session = lookupSession( req );

                if( session instanceof Response )
                {
                    return session;
                }

                session.lastSeen = Date.now();
                connection = session.connection;
            }
        }

        const responses = ( await Promise.all( messages.map( ( m ) => {return server.handleMessage( m, context, connection );} ) ) )
            .filter( ( r ): r is JSONRPCResponse => {return r !== null;} );

        const headers: Record<string, string> = { 'content-type' : 'application/json' };

        if( sessionsEnabled && isInitialize && connection && responses[0] && !responses[0].error )
        {
            const id = generateSessionId();
            sessions.set( id, { connection, lastSeen : Date.now() } );
            headers['mcp-session-id'] = id;
        }

        if( responses.length === 0 )
        {
            return new Response( null, { status : 202 } );
        }

        return new Response( JSON.stringify( batched ? responses : responses[0] ), { status : 200, headers } );
    };

    return async ( req: Request ): Promise<Response> => 
    {
        if( !originAllowed( req ) )
        {
            return rpcErrorResponse( 403, JSONRPC_INVALID_REQUEST, 'Origin not allowed' );
        }

        let context: ExecutionContext | undefined;

        if( options.authenticate )
        {
            let result: MCPHttpAuthResult;

            try
            {
                result = await options.authenticate( req );
            }
            catch( error: unknown )
            {
                reportError( error );

                return rpcErrorResponse( 500, JSONRPC_INTERNAL_ERROR, 'Authentication failed unexpectedly' );
            }

            if( !result || result.ok !== true )
            {
                const denied = result && result.ok === false ? result : { ok : false as const };

                return rpcErrorResponse( 401, JSONRPC_INVALID_REQUEST, 'Unauthorized', { 
                    'www-authenticate' : formatBearerChallenge( { 
                        resourceMetadata : options.resourceMetadataUrl, 
                        error            : denied.error, 
                        errorDescription : denied.errorDescription, 
                        scope            : denied.scope 
                    } ) 
                } );
            }

            context = result.context;
        }

        try
        {
            switch ( req.method )
            {
                case 'POST':
                    return await handlePost( req, context );

                case 'DELETE':
                {
                    if( !sessionsEnabled )
                    {
                        return rpcErrorResponse( 405, JSONRPC_INVALID_REQUEST, 'Method not allowed', { allow : 'POST' } );
                    }

                    purgeExpired();
                    const session = lookupSession( req );

                    if( session instanceof Response )
                    {
                        return session;
                    }

                    sessions.delete( req.headers.get( 'mcp-session-id' )! );

                    return new Response( null, { status : 204 } );
                }

                default:
                    return rpcErrorResponse( 405, JSONRPC_INVALID_REQUEST, 'Method not allowed', { allow : sessionsEnabled ? 'POST, DELETE' : 'POST' } );
            }
        }
        catch( error: unknown )
        {
            reportError( error );

            return rpcErrorResponse( 500, JSONRPC_INTERNAL_ERROR, 'Internal server error' );
        }
    };
}
