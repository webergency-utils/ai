import { AIError } from '../core/error.js';
import { parseSSEStream } from '../core/stream.js';
import { authorizedFetch, type MCPAuthOptions } from './auth.js';
import { readTruncated } from './http-util.js';
import type { JSONRPCMessage, MCPTransport } from './types.js';

export interface SSETransportOptions extends MCPAuthOptions
{
    /** Custom `fetch` (tests, proxies, custom agents). Defaults to the global one. */
    fetch?             : typeof fetch
    /** How long `connect()` waits for the server's `endpoint` event (default 10_000 ms). */
    connectTimeoutMs?  : number
}

function protocolError( message: string, details?: unknown ): AIError
{
    return new AIError( message, 'MCP_PROTOCOL_ERROR', details );
}

/**
 * Legacy MCP HTTP+SSE transport (spec 2024-11-05): a long-lived GET event stream carries server messages,
 * client messages are POSTed to the URL announced by the first `endpoint` event.
 *
 * `connect()` resolves only once that event arrived, so `send` cannot race it.
 */
export class SSETransport implements MCPTransport
{
    readonly #endpointUrl : string;
    readonly #options     : SSETransportOptions;
    readonly #fetch       : typeof fetch;
    #postUrl?             : string;
    #handler?             : ( message: JSONRPCMessage ) => void;
    #closeHandler?        : ( error?: Error ) => void;
    #errorHandler?        : ( error: Error ) => void;
    #abortController?     : AbortController;
    #ready?               : { resolve: () => void, reject: ( error: Error ) => void };
    #terminated = false;

    constructor( endpointUrl: string, options: SSETransportOptions = {} )
    {
        try
        {
            new URL( endpointUrl );
        }
        catch
        {
            throw new AIError( `SSETransport needs an absolute URL, got '${endpointUrl}'`, 'INVALID_INPUT' );
        }

        this.#endpointUrl = endpointUrl;
        this.#options = options;
        this.#fetch = options.fetch ?? ( ( ...args ) => {return fetch( ...args );} );
    }

    public async connect(): Promise<void>
    {
        if( this.#abortController || this.#terminated )
        {
            throw new AIError( 'SSETransport can only be connected once', 'MCP_TRANSPORT_ERROR' );
        }

        const controller = new AbortController();
        this.#abortController = controller;
        const timeoutMs = this.#options.connectTimeoutMs ?? 10_000;

        let response: Response;

        try
        {
            response = await authorizedFetch( {
                fetch   : this.#fetch,
                url     : this.#endpointUrl,
                init    : { method : 'GET', signal : controller.signal },
                headers : () => {return { accept : 'text/event-stream' };},
                auth    : this.#options
            } );
        }
        catch( error: unknown )
        {
            this.#abandon();

            throw error;
        }

        if( !response.ok || !response.body )
        {
            const body = await readTruncated( response );
            this.#abandon();

            throw new AIError( 
                `Failed to connect to MCP SSE endpoint: HTTP ${response.status}${body ? `: ${body}` : ''}`, 
                'MCP_TRANSPORT_ERROR', 
                { status : response.status, body } 
            );
        }

        const contentType = ( response.headers.get( 'content-type' ) ?? '' ).split( ';' )[0].trim().toLowerCase();

        if( contentType !== 'text/event-stream' )
        {
            await response.body.cancel().catch( () => {} );
            this.#abandon();

            throw protocolError( `MCP SSE endpoint answered with content-type '${contentType || '(none)'}'`, { contentType } );
        }

        const ready = new Promise<void>( ( resolve, reject ) => 
        {
            this.#ready = { resolve, reject };
        } );

        const timer = setTimeout( () => 
        {
            this.#terminate( new AIError( 
                `MCP SSE endpoint did not send its 'endpoint' event within ${timeoutMs}ms`, 
                'MCP_TRANSPORT_ERROR', 
                { timeoutMs } 
            ) );
        }, timeoutMs );

        void this.#listen( response.body );

        try
        {
            await ready;
        }
        finally
        {
            clearTimeout( timer );
        }
    }

    #abandon(): void
    {
        this.#terminated = true;
        this.#abortController?.abort();
        this.#abortController = undefined;
    }

    #setEndpoint( data: string ): void
    {
        let url: URL;

        try
        {
            url = new URL( data, this.#endpointUrl );
        }
        catch
        {
            throw protocolError( "MCP SSE 'endpoint' event carried an invalid URL", { data : data.slice( 0, 200 ) } );
        }

        if( url.origin !== new URL( this.#endpointUrl ).origin )
        {
            // Credentials would otherwise be sent to a host the caller never configured.
            throw protocolError( `MCP SSE 'endpoint' event points to another origin (${url.origin}); refusing to send requests there`, { origin : url.origin } );
        }

        this.#postUrl = url.toString();

        const ready = this.#ready;
        this.#ready = undefined;
        ready?.resolve();
    }

    async #listen( body: ReadableStream<Uint8Array> ): Promise<void>
    {
        try
        {
            for await ( const event of parseSSEStream( body ) )
            {
                if( event.event === 'endpoint' )
                {
                    this.#setEndpoint( event.data );
                    continue;
                }

                if( ( event.event !== undefined && event.event !== 'message' ) || event.data === '' )
                {
                    continue;
                }

                if( !this.#postUrl )
                {
                    throw protocolError( "MCP SSE stream sent a message before the 'endpoint' event" );
                }

                let message: JSONRPCMessage;

                try
                {
                    message = JSON.parse( event.data ) as JSONRPCMessage;
                }
                catch( error: unknown )
                {
                    throw protocolError( 
                        `MCP SSE event carried malformed JSON: ${error instanceof Error ? error.message : String( error )}`, 
                        { data : event.data.slice( 0, 200 ) } 
                    );
                }

                if( !message || typeof message !== 'object' || ( message as { jsonrpc?: unknown } ).jsonrpc !== '2.0' )
                {
                    throw protocolError( 'MCP SSE event is not a JSON-RPC 2.0 message', { data : event.data.slice( 0, 200 ) } );
                }

                this.#handler?.( message );
            }

            this.#terminate();
        }
        catch( error: unknown )
        {
            if( this.#terminated )
            {
                return;
            }

            this.#terminate( error instanceof Error ? error : new AIError( String( error ), 'MCP_TRANSPORT_ERROR' ) );
        }
    }

    /** Ends the transport once; the error (if any) reaches `connect()`, `onError` and `onClose`. */
    #terminate( error?: Error ): void
    {
        if( this.#terminated )
        {
            return;
        }

        this.#terminated = true;
        const controller = this.#abortController;
        this.#abortController = undefined;
        controller?.abort();

        const ready = this.#ready;
        this.#ready = undefined;

        if( ready )
        {
            ready.reject( error ?? new AIError( "MCP SSE stream ended before the 'endpoint' event", 'MCP_TRANSPORT_ERROR' ) );

            return;
        }

        // Protocol violations are reported out-of-band too; plain I/O failures only reject pending requests via onClose.
        if( error instanceof AIError && error.code === 'MCP_PROTOCOL_ERROR' )
        {
            this.#errorHandler?.( error );
        }

        this.#closeHandler?.( error );
    }

    public async send( message: JSONRPCMessage ): Promise<void>
    {
        if( !this.#postUrl || !this.#abortController )
        {
            throw new AIError( 'SSETransport is not connected', 'MCP_TRANSPORT_ERROR' );
        }

        const response = await authorizedFetch( {
            fetch   : this.#fetch,
            url     : this.#postUrl,
            init    : { method : 'POST', body : JSON.stringify( message ), signal : this.#abortController.signal },
            headers : () => {return { 'content-type' : 'application/json' };},
            auth    : this.#options
        } );

        if( !response.ok )
        {
            const body = await readTruncated( response );

            throw new AIError( 
                `MCP send failed: HTTP ${response.status}${body ? `: ${body}` : ''}`, 
                'MCP_TRANSPORT_ERROR', 
                { status : response.status, body } 
            );
        }

        await response.body?.cancel().catch( () => {} );
    }

    public async close(): Promise<void>
    {
        if( !this.#abortController || this.#terminated )
        {
            return;
        }

        this.#terminated = true;
        const controller = this.#abortController;
        this.#abortController = undefined;
        controller.abort();
        this.#closeHandler?.();
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
}
