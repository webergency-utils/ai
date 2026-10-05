import { AIError } from '../core/error.js';
import { parseSSEStream } from '../core/stream.js';
import { authorizedFetch, type MCPAuthOptions } from './auth.js';
import type { JSONRPCMessage, JSONRPCResponse, MCPTransport } from './types.js';

export interface StreamableHTTPTransportOptions extends MCPAuthOptions
{
    /** Custom `fetch` (tests, proxies, custom agents). Defaults to the global one. */
    fetch?          : typeof fetch
    /** Open a GET stream for server-initiated messages once the session is initialized (default false). */
    listen?         : boolean
    /** Upper bound for the best-effort session `DELETE` sent by `close()` (default 5000 ms). */
    closeTimeoutMs? : number
}

const MAX_ERROR_BODY_CHARS = 200;

function protocolError( message: string, details?: unknown ): AIError
{
    return new AIError( message, 'MCP_PROTOCOL_ERROR', details );
}

function isResponseFor( message: JSONRPCMessage, id: string | number ): message is JSONRPCResponse
{
    return !( 'method' in message ) && 'id' in message && message.id === id;
}

async function readTruncated( response: Response, maxChars: number ): Promise<string>
{
    if( !response.body )
    {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';

    try
    {
        while( text.length < maxChars )
        {
            const { done, value } = await reader.read();

            if( done )
            {
                break;
            }

            text += decoder.decode( value, { stream : true } );
        }
    }
    catch
    {
        // A broken body must not hide the HTTP status we are about to report.
    }
    finally
    {
        await reader.cancel().catch( () => {} );
    }

    return text.length > maxChars ? `${text.slice( 0, maxChars )}…` : text;
}

/**
 * MCP Streamable HTTP client transport (spec 2025-03-26+): every JSON-RPC message is its own POST; the
 * response is one JSON message, an SSE stream, or `202` for notifications/responses.
 */
export class StreamableHTTPTransport implements MCPTransport
{
    readonly #url           : string;
    readonly #options       : StreamableHTTPTransportOptions;
    readonly #fetch         : typeof fetch;
    readonly #inflight      = new Set<AbortController>();
    readonly #byRequestId   = new Map<string | number, AbortController>();
    #handler?               : ( message: JSONRPCMessage ) => void;
    #closeHandler?          : ( error?: Error ) => void;
    #errorHandler?          : ( error: Error ) => void;
    #sessionId?             : string;
    #protocolVersion?       : string;
    #listenerAbort?         : AbortController;
    #connected = false;
    #closed = false;

    constructor( url: string, options: StreamableHTTPTransportOptions = {} )
    {
        try
        {
            new URL( url );
        }
        catch
        {
            throw new AIError( `StreamableHTTPTransport needs an absolute URL, got '${url}'`, 'INVALID_INPUT' );
        }

        this.#url = url;
        this.#options = options;
        this.#fetch = options.fetch ?? ( ( ...args ) => {return fetch( ...args );} );
    }

    /** Session id issued by the server's initialize response, if any. */
    public get sessionId(): string | undefined
    {
        return this.#sessionId;
    }

    public async connect(): Promise<void>
    {
        if( this.#closed )
        {
            throw new AIError( 'StreamableHTTPTransport was closed and cannot reconnect', 'MCP_TRANSPORT_ERROR' );
        }

        this.#connected = true;
    }

    public setProtocolVersion( version: string ): void
    {
        this.#protocolVersion = version;
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;
    }

    public onClose( handler: ( error?: Error ) => void ): void
    {
        this.#closeHandler = handler;
    }

    public onError( handler: ( error: Error ) => void ): void
    {
        this.#errorHandler = handler;
    }

    /** Protocol headers for every request. `traceparent` injection will hook in here (Area 7); nothing yet. */
    #headers( extra: Record<string, string> = {} ): Record<string, string>
    {
        const headers: Record<string, string> = { ...extra };

        if( this.#sessionId )
        {
            headers['mcp-session-id'] = this.#sessionId;
        }

        if( this.#protocolVersion )
        {
            headers['mcp-protocol-version'] = this.#protocolVersion;
        }

        return headers;
    }

    #fetchAuthorized( init: Omit<RequestInit, 'headers'>, extra: Record<string, string> ): Promise<Response>
    {
        return authorizedFetch( {
            fetch   : this.#fetch,
            url     : this.#url,
            init,
            headers : () => {return this.#headers( extra );},
            auth    : this.#options
        } );
    }

    async #throwHttpError( response: Response ): Promise<never>
    {
        if( response.status === 404 && this.#sessionId )
        {
            const sessionId = this.#sessionId;
            this.#sessionId = undefined;
            await response.body?.cancel().catch( () => {} );

            throw new AIError( 
                'MCP session expired (HTTP 404); re-initialize with a new connection', 
                'MCP_SESSION_EXPIRED', 
                { status : 404, sessionId } 
            );
        }

        const body = await readTruncated( response, MAX_ERROR_BODY_CHARS );

        throw new AIError( 
            `MCP HTTP request failed with status ${response.status}${body ? `: ${body}` : ''}`, 
            'MCP_TRANSPORT_ERROR', 
            { status : response.status, body } 
        );
    }

    #decode( data: string ): JSONRPCMessage
    {
        let parsed: unknown;

        try
        {
            parsed = JSON.parse( data );
        }
        catch( error: unknown )
        {
            throw protocolError( `MCP server sent malformed JSON: ${error instanceof Error ? error.message : String( error )}`, { data : data.slice( 0, MAX_ERROR_BODY_CHARS ) } );
        }

        if( !parsed || typeof parsed !== 'object' || Array.isArray( parsed ) || ( parsed as { jsonrpc?: unknown } ).jsonrpc !== '2.0' )
        {
            throw protocolError( 'MCP server sent a value that is not a JSON-RPC 2.0 message', { data : data.slice( 0, MAX_ERROR_BODY_CHARS ) } );
        }

        return parsed as JSONRPCMessage;
    }

    /** Reads SSE events, delivering messages. Resolves true as soon as the response to `requestId` was delivered. */
    async #pump( body: ReadableStream<Uint8Array>, requestId: string | number | undefined, state: { lastEventId?: string } ): Promise<boolean>
    {
        for await ( const event of parseSSEStream( body ) )
        {
            if( event.id !== undefined )
            {
                state.lastEventId = event.id;
            }

            if( ( event.event !== undefined && event.event !== 'message' ) || event.data === '' )
            {
                continue;
            }

            const message = this.#decode( event.data );
            this.#handler?.( message );

            if( requestId !== undefined && isResponseFor( message, requestId ) )
            {
                return true;
            }
        }

        return false;
    }

    public async send( message: JSONRPCMessage ): Promise<void>
    {
        if( !this.#connected || this.#closed )
        {
            throw new AIError( 'StreamableHTTPTransport is not connected', 'MCP_TRANSPORT_ERROR' );
        }

        const controller = new AbortController();
        this.#inflight.add( controller );

        const requestId = 'method' in message && 'id' in message ? message.id : undefined;

        if( requestId !== undefined )
        {
            this.#byRequestId.set( requestId, controller );
        }

        if( 'method' in message && message.method === 'notifications/cancelled' )
        {
            // The caller gave up on that request: stop waiting on its (possibly long-lived) response stream.
            const cancelledId = message.params?.requestId;

            if( typeof cancelledId === 'string' || typeof cancelledId === 'number' )
            {
                this.#byRequestId.get( cancelledId )?.abort();
            }
        }

        try
        {
            await this.#post( message, controller.signal );
        }
        catch( error: unknown )
        {
            if( this.#closed && controller.signal.aborted )
            {
                throw new AIError( 'MCP transport closed', 'MCP_TRANSPORT_CLOSED' );
            }

            throw error;
        }
        finally
        {
            this.#inflight.delete( controller );

            if( requestId !== undefined )
            {
                this.#byRequestId.delete( requestId );
            }
        }

        if( this.#options.listen && 'method' in message && message.method === 'notifications/initialized' )
        {
            this.#startListener();
        }
    }

    async #post( message: JSONRPCMessage, signal: AbortSignal ): Promise<void>
    {
        const isRequest = 'method' in message && 'id' in message && message.id !== undefined;

        const response = await this.#fetchAuthorized( 
            { method : 'POST', body : JSON.stringify( message ), signal }, 
            { 'content-type' : 'application/json', accept : 'application/json, text/event-stream' } 
        );

        if( !response.ok )
        {
            await this.#throwHttpError( response );
        }

        if( 'method' in message && message.method === 'initialize' )
        {
            const sessionId = response.headers.get( 'mcp-session-id' );

            if( sessionId )
            {
                this.#sessionId = sessionId;
            }
        }

        if( !isRequest )
        {
            // Notifications and responses are accepted (spec: 202); nothing to deliver.
            await response.body?.cancel().catch( () => {} );

            return;
        }

        const id = ( message as { id: string | number } ).id;

        if( response.status === 202 )
        {
            await response.body?.cancel().catch( () => {} );

            throw protocolError( `MCP server answered request '${( message as { method: string } ).method}' with 202 and no response`, { id } );
        }

        const contentType = ( response.headers.get( 'content-type' ) ?? '' ).split( ';' )[0].trim().toLowerCase();

        if( contentType === 'application/json' )
        {
            const messages = this.#decodeJsonBody( await response.text() );
            let answered = false;

            for( const incoming of messages )
            {
                this.#handler?.( incoming );
                answered ||= isResponseFor( incoming, id );
            }

            if( !answered )
            {
                throw protocolError( `MCP server's JSON response did not contain a response to request ${String( id )}`, { id } );
            }

            return;
        }

        if( contentType === 'text/event-stream' && response.body )
        {
            await this.#consumeRequestStream( response.body, id, signal );

            return;
        }

        await response.body?.cancel().catch( () => {} );

        throw protocolError( `MCP server answered with unsupported content-type '${contentType || '(none)'}'`, { contentType } );
    }

    #decodeJsonBody( text: string ): JSONRPCMessage[]
    {
        let parsed: unknown;

        try
        {
            parsed = JSON.parse( text );
        }
        catch( error: unknown )
        {
            throw protocolError( `MCP server sent malformed JSON: ${error instanceof Error ? error.message : String( error )}`, { data : text.slice( 0, MAX_ERROR_BODY_CHARS ) } );
        }

        const items = Array.isArray( parsed ) ? parsed : [ parsed ];

        return items.map( ( item ) => {return this.#decode( JSON.stringify( item ) );} );
    }

    async #consumeRequestStream( body: ReadableStream<Uint8Array>, id: string | number, signal: AbortSignal ): Promise<void>
    {
        const state: { lastEventId?: string } = {};
        let cause: unknown;

        try
        {
            if( await this.#pump( body, id, state ) )
            {
                return;
            }
        }
        catch( error: unknown )
        {
            if( error instanceof AIError && error.code === 'MCP_PROTOCOL_ERROR' )
            {
                throw error;
            }

            if( signal.aborted )
            {
                throw error;
            }

            cause = error;
        }

        if( state.lastEventId === undefined )
        {
            throw new AIError( 
                `MCP SSE response ended before the response to request ${String( id )} arrived`, 
                'MCP_TRANSPORT_ERROR', 
                { id, cause : cause instanceof Error ? cause.message : undefined } 
            );
        }

        // One resume attempt with Last-Event-ID, then fail.
        const response = await this.#fetchAuthorized( 
            { method : 'GET', signal }, 
            { accept : 'text/event-stream', 'last-event-id' : state.lastEventId } 
        );

        if( !response.ok )
        {
            await this.#throwHttpError( response );
        }

        const contentType = ( response.headers.get( 'content-type' ) ?? '' ).split( ';' )[0].trim().toLowerCase();

        if( contentType !== 'text/event-stream' || !response.body )
        {
            await response.body?.cancel().catch( () => {} );

            throw new AIError( `MCP SSE resume for request ${String( id )} was refused (content-type '${contentType || '(none)'}')`, 'MCP_TRANSPORT_ERROR', { id } );
        }

        let answered: boolean;

        try
        {
            answered = await this.#pump( response.body, id, state );
        }
        catch( error: unknown )
        {
            if( error instanceof AIError || signal.aborted )
            {
                throw error;
            }

            throw new AIError( 
                `MCP SSE stream dropped again while resuming request ${String( id )}`, 
                'MCP_TRANSPORT_ERROR', 
                { id, cause : error instanceof Error ? error.message : String( error ) } 
            );
        }

        if( !answered )
        {
            throw new AIError( `MCP SSE stream ended again before the response to request ${String( id )}`, 'MCP_TRANSPORT_ERROR', { id } );
        }
    }

    #startListener(): void
    {
        if( this.#listenerAbort || this.#closed )
        {
            return;
        }

        const controller = new AbortController();
        this.#listenerAbort = controller;

        this.#listen( controller.signal ).catch( ( error: unknown ) => 
        {
            if( this.#closed )
            {
                return;
            }

            this.#errorHandler?.( error instanceof Error ? error : new AIError( String( error ), 'MCP_TRANSPORT_ERROR' ) );
        } );
    }

    async #listen( signal: AbortSignal ): Promise<void>
    {
        const state: { lastEventId?: string } = {};
        let resumes = 0;

        while( true )
        {
            const extra: Record<string, string> = { accept : 'text/event-stream' };

            if( state.lastEventId !== undefined )
            {
                extra['last-event-id'] = state.lastEventId;
            }

            const response = await this.#fetchAuthorized( { method : 'GET', signal }, extra );

            if( response.status === 405 )
            {
                // Spec: the server may not offer a listening stream.
                await response.body?.cancel().catch( () => {} );

                return;
            }

            if( !response.ok )
            {
                await this.#throwHttpError( response );
            }

            const contentType = ( response.headers.get( 'content-type' ) ?? '' ).split( ';' )[0].trim().toLowerCase();

            if( contentType !== 'text/event-stream' || !response.body )
            {
                await response.body?.cancel().catch( () => {} );

                throw protocolError( `MCP listening stream answered with content-type '${contentType || '(none)'}'`, { contentType } );
            }

            try
            {
                await this.#pump( response.body, undefined, state );
            }
            catch( error: unknown )
            {
                if( signal.aborted )
                {
                    return;
                }

                if( error instanceof AIError )
                {
                    throw error;
                }
            }

            if( signal.aborted || this.#closed )
            {
                return;
            }

            // One resume attempt per listener (plan R8); after that the caller is told and decides.
            if( state.lastEventId !== undefined && resumes < 1 )
            {
                resumes++;
                continue;
            }

            throw new AIError( 'MCP listening stream dropped and could not be resumed', 'MCP_TRANSPORT_ERROR', { lastEventId : state.lastEventId } );
        }
    }

    public async close(): Promise<void>
    {
        if( this.#closed )
        {
            return;
        }

        this.#closed = true;
        this.#connected = false;

        for( const controller of this.#inflight )
        {
            controller.abort();
        }

        this.#listenerAbort?.abort();

        const sessionId = this.#sessionId;
        this.#sessionId = undefined;

        if( sessionId )
        {
            try
            {
                const response = await authorizedFetch( {
                    fetch   : this.#fetch,
                    url     : this.#url,
                    init    : { method : 'DELETE', signal : AbortSignal.timeout( this.#options.closeTimeoutMs ?? 5_000 ) },
                    headers : () => 
                    {
                        const headers: Record<string, string> = { 'mcp-session-id' : sessionId };

                        if( this.#protocolVersion )
                        {
                            headers['mcp-protocol-version'] = this.#protocolVersion;
                        }

                        return headers;
                    },
                    auth : this.#options
                } );

                await response.body?.cancel().catch( () => {} );
            }
            catch
            {
                // Best effort per spec: the server may already have dropped the session (or answer 405).
            }
        }

        this.#closeHandler?.();
    }
}
