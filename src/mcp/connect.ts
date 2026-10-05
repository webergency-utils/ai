import { AIError } from '../core/error.js';
import type { MCPAuthOptions } from './auth.js';
import { MCPClient, type MCPClientOptions, type MCPConnectOptions } from './client.js';
import { StreamableHTTPTransport } from './http-transport.js';
import { SSETransport } from './sse-transport.js';

export interface ConnectMCPClientOptions extends MCPAuthOptions
{
    fetch?             : typeof fetch
    client?            : MCPClientOptions
    connect?           : MCPConnectOptions
    /** Open the Streamable HTTP GET listening stream (ignored for the legacy fallback). */
    listen?            : boolean
    /** `endpoint` event timeout for the legacy fallback (default 10_000 ms). */
    connectTimeoutMs?  : number
}

/** Status codes on which the spec says to retry against the legacy HTTP+SSE transport. */
const FALLBACK_STATUSES = [ 400, 404, 405 ];

function shouldFallBack( error: unknown ): boolean
{
    if( !( error instanceof AIError ) || error.code !== 'MCP_TRANSPORT_ERROR' )
    {
        return false;
    }

    const status = ( error.details as { status?: number } | undefined )?.status;

    return status !== undefined && FALLBACK_STATUSES.includes( status );
}

/**
 * Connects to an MCP server over HTTP: tries Streamable HTTP first (POST `initialize`); when the server answers
 * 400/404/405 it falls back to the legacy SSE transport per the spec's backwards-compatibility rule.
 * Any other failure (auth, version mismatch, network) is thrown as-is, never masked by the fallback.
 */
export async function connectMCPClient( url: string, options: ConnectMCPClientOptions = {} ): Promise<MCPClient>
{
    const streamable = new MCPClient( 
        new StreamableHTTPTransport( url, { 
            fetch        : options.fetch, 
            headers      : options.headers, 
            authProvider : options.authProvider, 
            listen       : options.listen 
        } ), 
        options.client 
    );

    try
    {
        await streamable.connect( options.connect );

        return streamable;
    }
    catch( error: unknown )
    {
        if( !shouldFallBack( error ) )
        {
            throw error;
        }

        const legacy = new MCPClient( 
            new SSETransport( url, { 
                fetch            : options.fetch, 
                headers          : options.headers, 
                authProvider     : options.authProvider, 
                connectTimeoutMs : options.connectTimeoutMs 
            } ), 
            options.client 
        );

        try
        {
            await legacy.connect( options.connect );

            return legacy;
        }
        catch( legacyError: unknown )
        {
            throw new AIError( 
                `Could not connect to MCP server: Streamable HTTP failed (${( error as Error ).message}); legacy SSE fallback failed (${legacyError instanceof Error ? legacyError.message : String( legacyError )})`, 
                'MCP_CONNECT_FAILED', 
                { streamable : ( error as AIError ).details, legacyCode : legacyError instanceof AIError ? legacyError.code : undefined } 
            );
        }
    }
}
