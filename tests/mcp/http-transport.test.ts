import { describe, it, expect, vi } from 'vitest';
import { MCPClient, StreamableHTTPTransport, LATEST_PROTOCOL_VERSION } from '../../src/mcp/index.js';
import type { JSONRPCMessage } from '../../src/mcp/types.js';
import { jsonResponse, sseResponse, chunkedStream, streamResponse } from '../helpers/http.js';

const URL_ = 'https://mcp.example/rpc';

interface Recorded
{
    method  : string
    headers : Headers
    body?   : { id?: number | string, method?: string, params?: Record<string, unknown> } & Record<string, unknown>
    signal? : AbortSignal | null
}

type Handler = ( req: Recorded ) => Response | Promise<Response>;

function fakeFetch( handler: Handler ): { fetch: typeof fetch, calls: Recorded[] }
{
    const calls: Recorded[] = [];
    const impl = async ( _url: unknown, init?: RequestInit ): Promise<Response> => 
    {
        const recorded: Recorded = {
            method  : init?.method ?? 'GET',
            headers : new Headers( init?.headers ),
            body    : typeof init?.body === 'string' ? JSON.parse( init.body ) : undefined,
            signal  : init?.signal
        };
        calls.push( recorded );

        return handler( recorded );
    };

    return { fetch : impl as unknown as typeof fetch, calls };
}

const rpcResult = ( req: Recorded, result: unknown, headers: Record<string, string> = {} ): Response => 
{
    return jsonResponse( { jsonrpc : '2.0', id : req.body!.id, result }, { headers } );
};

const sse = ( ...messages: Array<{ id?: string, event?: string, data: unknown }> ): string[] => 
{
    return messages.map( ( m ) => 
    {
        return `${m.id !== undefined ? `id: ${m.id}\n` : ''}${m.event ? `event: ${m.event}\n` : ''}data: ${typeof m.data === 'string' ? m.data : JSON.stringify( m.data )}\n\n`;
    } );
};

/** Default well-behaved server; `overrides` take precedence per JSON-RPC method (return undefined to fall through). */
function server( 
    overrides: Record<string, Handler> = {}, 
    capabilities: Record<string, unknown> = { tools : {} }, 
    version = '2025-06-18' 
): Handler
{
    return ( req ) => 
    {
        if( req.method === 'POST' )
        {
            const method = req.body?.method ?? '';

            if( overrides[method] )
            {
                return overrides[method]( req );
            }

            if( method === 'initialize' )
            {
                return rpcResult( req, { protocolVersion : version, capabilities, serverInfo : { name : 's', version : '1' } }, { 'Mcp-Session-Id' : 's1' } );
            }

            if( req.body?.id === undefined )
            {
                return new Response( null, { status : 202 } );
            }

            if( method === 'tools/list' )
            {
                return rpcResult( req, { tools : [ { name : 'echo', inputSchema : { type : 'object' } } ] } );
            }

            if( method === 'tools/call' )
            {
                return rpcResult( req, { content : [ { type : 'text', text : 'ok' } ] } );
            }
        }

        if( req.method === 'DELETE' )
        {
            return new Response( null, { status : 204 } );
        }

        return new Response( 'unexpected', { status : 500 } );
    };
}

async function connected( handler: Handler, transportOptions: ConstructorParameters<typeof StreamableHTTPTransport>[1] = {}, clientOptions: ConstructorParameters<typeof MCPClient>[1] = {} )
{
    const { fetch: fetchImpl, calls } = fakeFetch( handler );
    const transport = new StreamableHTTPTransport( URL_, { fetch : fetchImpl, ...transportOptions } );
    const client = new MCPClient( transport, clientOptions );
    await client.connect();

    return { client, transport, calls };
}

const tick = (): Promise<void> => {return new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );};

describe( 'StreamableHTTPTransport JSON responses (R5, R6)', () => 
{
    it( 'AE3: stores the session id and sends it plus the negotiated version on later requests', async () => 
    {
        const { client, transport, calls } = await connected( server() );

        expect( transport.sessionId ).toBe( 's1' );
        expect( client.negotiatedVersion ).toBe( '2025-06-18' );

        await client.listTools();

        const [ init, initialized, list ] = calls;
        expect( init.body?.method ).toBe( 'initialize' );
        expect( init.headers.get( 'mcp-session-id' ) ).toBeNull();
        expect( init.headers.get( 'mcp-protocol-version' ) ).toBeNull();
        expect( init.headers.get( 'accept' ) ).toBe( 'application/json, text/event-stream' );
        expect( init.headers.get( 'content-type' ) ).toBe( 'application/json' );
        expect( init.body?.params?.protocolVersion ).toBe( LATEST_PROTOCOL_VERSION );

        for( const later of [ initialized, list ] )
        {
            expect( later.headers.get( 'mcp-session-id' ) ).toBe( 's1' );
            expect( later.headers.get( 'mcp-protocol-version' ) ).toBe( '2025-06-18' );
        }

        expect( initialized.body?.method ).toBe( 'notifications/initialized' );
    } );

    it( 'works against a stateless server that issues no session id', async () => 
    {
        const { client, transport, calls } = await connected( server( { 
            initialize : ( req ) => {return rpcResult( req, { protocolVersion : '2025-06-18', capabilities : { tools : {} } } );} 
        } ) );

        await client.listTools();

        expect( transport.sessionId ).toBeUndefined();
        expect( calls.every( ( c ) => {return c.headers.get( 'mcp-session-id' ) === null;} ) ).toBe( true );
    } );

    it( 'accepts 202 for notifications but rejects 202 for a request', async () => 
    {
        const { client } = await connected( server( { 'tools/list' : () => {return new Response( null, { status : 202 } );} } ) );

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'delivers each message of a JSON batch response', async () => 
    {
        const { client } = await connected( server( { 
            'tools/list' : ( req ) => 
            {
                return jsonResponse( [
                    { jsonrpc : '2.0', method : 'notifications/message', params : { n : 1 } },
                    { jsonrpc : '2.0', id : req.body!.id, result : { tools : [] } }
                ] );
            }
        } ) );

        const seen: string[] = [];
        client.onNotification( ( n ) => {seen.push( n.method );} );

        await expect( client.listTools() ).resolves.toEqual( [] );
        expect( seen ).toEqual( [ 'notifications/message' ] );
    } );

    it.each( [
        [ 'an unknown content-type', () => {return new Response( 'hi', { status : 200, headers : { 'content-type' : 'text/html' } } );}, /unsupported content-type 'text\/html'/ ],
        [ 'a missing content-type', () => {return new Response( null, { status : 200 } );}, /\(none\)/ ],
        [ 'malformed JSON', () => {return new Response( '{nope', { status : 200, headers : { 'content-type' : 'application/json' } } );}, /malformed JSON/ ],
        [ 'a non JSON-RPC value', () => {return jsonResponse( { hello : 'world' } );}, /not a JSON-RPC 2.0 message/ ],
        [ 'a JSON body without the matching response', () => {return jsonResponse( { jsonrpc : '2.0', id : 9999, result : {} } );}, /did not contain a response/ ]
    ] )( 'rejects %s with MCP_PROTOCOL_ERROR', async ( _label, make, message ) => 
    {
        const { client } = await connected( server( { 'tools/list' : make } ) );

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR', message : expect.stringMatching( message ) } );
    } );
} );

describe( 'StreamableHTTPTransport SSE responses (R5)', () => 
{
    it( 'AE4: delivers a progress notification then the result from an SSE body', async () => 
    {
        const { client } = await connected( server( { 
            'tools/call' : ( req ) => 
            {
                return sseResponse( sse( 
                    { data : { jsonrpc : '2.0', method : 'notifications/progress', params : { progress : 1 } } },
                    { data : { jsonrpc : '2.0', id : req.body!.id, result : { content : [ { type : 'text', text : 'done' } ] } } }
                ) );
            }
        } ) );

        const seen: Array<Record<string, unknown> | undefined> = [];
        client.onNotification( ( n ) => {seen.push( n.params );} );

        const result = await client.callTool( 'echo', {} );

        expect( result.content[0].text ).toBe( 'done' );
        expect( seen ).toEqual( [ { progress : 1 } ] );
    } );

    it( 'handles events split across network chunks and ignores non-message events and empty data', async () => 
    {
        const payload = sse( 
            { id : 'e0', data : '' },
            { event : 'ping', data : 'ignore me' },
            { id : 'e1', event : 'message', data : { jsonrpc : '2.0', id : 2, result : { tools : [] } } }
        ).join( '' );
        const { client } = await connected( server( { 
            'tools/list' : ( req ) => 
            {
                const body = payload.replace( '"id":2', `"id":${req.body!.id}` );

                return streamResponse( chunkedStream( body, [ 7, 40, 90 ] ) );
            }
        } ) );

        await expect( client.listTools() ).resolves.toEqual( [] );
    } );

    it( 'rejects malformed event JSON with MCP_PROTOCOL_ERROR', async () => 
    {
        const { client } = await connected( server( { 'tools/list' : () => {return sseResponse( sse( { data : '{broken' } ) );} } ) );

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'rejects a stream that ends without ever answering and has no event id', async () => 
    {
        const { client, calls } = await connected( server( { 
            'tools/list' : () => {return sseResponse( sse( { data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );} 
        } ) );

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringContaining( 'ended before the response' ) } );
        expect( calls.some( ( c ) => {return c.method === 'GET';} ) ).toBe( false );
    } );

    it( 'resumes a dropped stream once with Last-Event-ID and completes the request', async () => 
    {
        let id = 0;
        const { fetch: fetchImpl, calls } = fakeFetch( ( req ) => 
        {
            if( req.method === 'GET' )
            {
                return sseResponse( sse( { id : 'ev-2', data : { jsonrpc : '2.0', id, result : { tools : [] } } } ) );
            }

            return server( { 
                'tools/list' : ( r ) => 
                {
                    id = r.body!.id as number;

                    return sseResponse( sse( { id : 'ev-1', data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );
                }
            } )( req );
        } );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl } ) );
        await client.connect();

        await expect( client.listTools() ).resolves.toEqual( [] );

        const gets = calls.filter( ( c ) => {return c.method === 'GET';} );
        expect( gets ).toHaveLength( 1 );
        expect( gets[0].headers.get( 'last-event-id' ) ).toBe( 'ev-1' );
        expect( gets[0].headers.get( 'mcp-session-id' ) ).toBe( 's1' );
        expect( gets[0].headers.get( 'accept' ) ).toBe( 'text/event-stream' );
    } );

    it( 'fails after the single resume attempt when the resumed stream drops too', async () => 
    {
        const { fetch: fetchImpl, calls } = fakeFetch( ( req ) => 
        {
            if( req.method === 'GET' )
            {
                return sseResponse( sse( { id : 'ev-2', data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );
            }

            return server( { 
                'tools/list' : () => {return sseResponse( sse( { id : 'ev-1', data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );} 
            } )( req );
        } );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl } ) );
        await client.connect();

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringContaining( 'ended again' ) } );
        expect( calls.filter( ( c ) => {return c.method === 'GET';} ) ).toHaveLength( 1 );
    } );

    it.each( [
        [ 'a non-ok status', () => {return new Response( 'gone', { status : 500 } );}, /status 500/ ],
        [ 'a non-SSE answer', () => {return jsonResponse( {} );}, /was refused/ ]
    ] )( 'fails the request when the resume GET gets %s', async ( _label, resumeAnswer, message ) => 
    {
        const { fetch: fetchImpl } = fakeFetch( ( req ) => 
        {
            if( req.method === 'GET' )
            {
                return resumeAnswer();
            }

            return server( { 
                'tools/list' : () => {return sseResponse( sse( { id : 'ev-1', data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );} 
            } )( req );
        } );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl } ) );
        await client.connect();

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringMatching( message ) } );
    } );

    it( 'treats a stream that errors mid-read like a drop (resume with Last-Event-ID)', async () => 
    {
        let id = 0;
        const { fetch: fetchImpl, calls } = fakeFetch( ( req ) => 
        {
            if( req.method === 'GET' )
            {
                return sseResponse( sse( { id : 'ev-2', data : { jsonrpc : '2.0', id, result : { tools : [] } } } ) );
            }

            return server( { 
                'tools/list' : ( r ) => 
                {
                    id = r.body!.id as number;
                    let sent = false;

                    return streamResponse( new ReadableStream( {
                        pull( controller )
                        {
                            if( sent )
                            {
                                controller.error( new TypeError( 'socket hang up' ) );

                                return;
                            }

                            sent = true;
                            controller.enqueue( new TextEncoder().encode( 'id: ev-1\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n' ) );
                        }
                    } ) );
                }
            } )( req );
        } );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl } ) );
        await client.connect();

        await expect( client.listTools() ).resolves.toEqual( [] );
        expect( calls.find( ( c ) => {return c.method === 'GET';} )?.headers.get( 'last-event-id' ) ).toBe( 'ev-1' );
    } );

    it( 'surfaces a mid-read error as MCP_TRANSPORT_ERROR when there is no event id to resume from', async () => 
    {
        const { client } = await connected( server( { 
            'tools/list' : () => {return streamResponse( new ReadableStream( { start( controller ) {controller.error( new TypeError( 'reset' ) );} } ) );} 
        } ) );

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', details : expect.objectContaining( { cause : 'reset' } ) } );
    } );
} );

describe( 'StreamableHTTPTransport errors (R7)', () => 
{
    it( 'AE5: a 404 after a session id was issued rejects with MCP_SESSION_EXPIRED and clears the session', async () => 
    {
        const { client, transport } = await connected( server( { 'tools/call' : () => {return new Response( 'unknown session', { status : 404 } );} } ) );

        await expect( client.callTool( 'echo' ) ).rejects.toMatchObject( { code : 'MCP_SESSION_EXPIRED', details : { status : 404, sessionId : 's1' } } );
        expect( transport.sessionId ).toBeUndefined();
    } );

    it( 'a 404 without a session is a plain MCP_TRANSPORT_ERROR carrying the status', async () => 
    {
        const { fetch: fetchImpl } = fakeFetch( () => {return new Response( 'nope', { status : 404 } );} );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl } ) );

        await expect( client.connect() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', details : { status : 404, body : 'nope' } } );
    } );

    it( 'truncates long error bodies and never leaks auth headers into the message', async () => 
    {
        const { fetch: fetchImpl } = fakeFetch( () => {return new Response( 'x'.repeat( 5_000 ), { status : 502 } );} );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { 
            fetch        : fetchImpl, 
            headers      : { 'x-api-key' : 'STATIC-SECRET' }, 
            authProvider : { getHeaders : async () => {return { authorization : 'Bearer SECRET-TOKEN' };} } 
        } ) );

        const failure = await client.connect().catch( ( e: unknown ) => {return e as Error;} ) as Error & { details?: unknown };

        expect( failure.message ).toContain( 'status 502' );
        expect( failure.message.length ).toBeLessThan( 300 );
        expect( `${failure.message}${JSON.stringify( failure.details )}` ).not.toMatch( /SECRET/ );
    } );

    it( 'rejects an invalid URL at construction and send() before connect()', async () => 
    {
        expect( () => {return new StreamableHTTPTransport( '/relative' );} ).toThrow( /absolute URL/ );

        const transport = new StreamableHTTPTransport( URL_, { fetch : fakeFetch( server() ).fetch } );

        await expect( transport.send( { jsonrpc : '2.0', method : 'x' } ) ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
    } );

    it( 'falls back to the global fetch when none is injected', async () => 
    {
        const spy = vi.spyOn( globalThis, 'fetch' ).mockResolvedValue( new Response( null, { status : 500 } ) );

        try
        {
            const transport = new StreamableHTTPTransport( URL_ );
            await transport.connect();

            await expect( transport.send( { jsonrpc : '2.0', id : 1, method : 'x' } ) ).rejects.toMatchObject( { details : { status : 500 } } );
            expect( spy ).toHaveBeenCalledTimes( 1 );
        }
        finally
        {
            spy.mockRestore();
        }
    } );
} );

describe( 'StreamableHTTPTransport close and cancellation (R6, R8)', () => 
{
    it( 'close() sends DELETE with the session id and is idempotent', async () => 
    {
        const { client, calls } = await connected( server() );

        await client.close();
        await client.close();

        const deletes = calls.filter( ( c ) => {return c.method === 'DELETE';} );
        expect( deletes ).toHaveLength( 1 );
        expect( deletes[0].headers.get( 'mcp-session-id' ) ).toBe( 's1' );
        expect( deletes[0].headers.get( 'mcp-protocol-version' ) ).toBe( '2025-06-18' );
    } );

    it( 'close() ignores a failing or refused DELETE', async () => 
    {
        for( const answer of [ () => {return new Response( null, { status : 405 } );}, () => {throw new TypeError( 'offline' );} ] )
        {
            const { fetch: fetchImpl } = fakeFetch( ( req ) => {return req.method === 'DELETE' ? answer() : server()( req );} );
            const transport = new StreamableHTTPTransport( URL_, { fetch : fetchImpl } );
            const client = new MCPClient( transport );
            await client.connect();

            await expect( client.close() ).resolves.toBeUndefined();
        }
    } );

    it( 'close() sends no DELETE when no session was issued, and send() afterwards fails', async () => 
    {
        const { fetch: fetchImpl, calls } = fakeFetch( server( { 
            initialize : ( req ) => {return rpcResult( req, { protocolVersion : '2025-06-18', capabilities : {} } );} 
        } ) );
        const transport = new StreamableHTTPTransport( URL_, { fetch : fetchImpl } );
        const client = new MCPClient( transport );
        await client.connect();
        await client.close();

        expect( calls.some( ( c ) => {return c.method === 'DELETE';} ) ).toBe( false );
        await expect( transport.send( { jsonrpc : '2.0', method : 'x' } ) ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
        await expect( transport.connect() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
    } );

    it( 'close() aborts an in-flight request and rejects the pending call', async () => 
    {
        let signal: AbortSignal | null | undefined;
        const { client } = await connected( server( { 
            'tools/call' : ( req ) => 
            {
                signal = req.signal;

                return new Promise<Response>( ( _resolve, reject ) => 
                {
                    req.signal?.addEventListener( 'abort', () => {reject( new DOMException( 'aborted', 'AbortError' ) );} );
                } );
            }
        } ) );

        const pending = client.callTool( 'echo' );
        const assertion = expect( pending ).rejects.toMatchObject( { code : 'MCP_CLIENT_CLOSED' } );
        await tick();
        await client.close();
        await assertion;

        expect( signal?.aborted ).toBe( true );
    } );

    it( 'a cancelled request aborts its own HTTP request and sends notifications/cancelled', async () => 
    {
        const signals: Array<AbortSignal | null | undefined> = [];
        const { client, calls } = await connected( server( { 
            'tools/call' : ( req ) => 
            {
                signals.push( req.signal );

                return new Promise<Response>( ( _resolve, reject ) => 
                {
                    req.signal?.addEventListener( 'abort', () => {reject( new DOMException( 'aborted', 'AbortError' ) );} );
                } );
            }
        } ) );

        const controller = new AbortController();
        const pending = client.callTool( 'echo', {}, { signal : controller.signal } );
        const assertion = expect( pending ).rejects.toMatchObject( { code : 'MCP_REQUEST_ABORTED' } );
        await tick();
        controller.abort();
        await assertion;
        await tick();

        expect( signals[0]?.aborted ).toBe( true );
        expect( calls.some( ( c ) => {return c.body?.method === 'notifications/cancelled';} ) ).toBe( true );
    } );
} );

describe( 'StreamableHTTPTransport listening stream (R8)', () => 
{
    const listenServer = ( getHandler: Handler ): Handler => 
    {
        const base = server();

        return ( req ) => {return req.method === 'GET' ? getHandler( req ) : base( req );};
    };

    it( 'opens a GET stream after initialize and delivers server-initiated messages', async () => 
    {
        const { client, calls } = await connected( 
            listenServer( () => {return sseResponse( sse( { id : 'l1', data : { jsonrpc : '2.0', method : 'notifications/message', params : { hi : 1 } } } ) );} ),
            { listen : true },
            { onError : () => {} }
        );

        await tick();

        const get = calls.find( ( c ) => {return c.method === 'GET';} );
        expect( get?.headers.get( 'accept' ) ).toBe( 'text/event-stream' );
        expect( get?.headers.get( 'mcp-session-id' ) ).toBe( 's1' );
        expect( get?.headers.get( 'mcp-protocol-version' ) ).toBe( '2025-06-18' );
        await client.close();
    } );

    it( 'delivers messages that arrive on the listening stream', async () => 
    {
        let release!: () => void;
        const gate = new Promise<void>( ( resolve ) => {release = resolve;} );

        const { fetch: fetchImpl } = fakeFetch( listenServer( () => 
        {
            return streamResponse( new ReadableStream( {
                async start( controller )
                {
                    await gate;
                    controller.enqueue( new TextEncoder().encode( 'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"hi":1}}\n\n' ) );
                    // Left open, like a real listening stream.
                }
            } ) );
        } ) );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : fetchImpl, listen : true } ), { onError : () => {} } );
        const seen: JSONRPCMessage[] = [];
        client.onNotification( ( n ) => {seen.push( n );} );
        await client.connect();

        release();
        await tick();
        await tick();

        expect( seen ).toHaveLength( 1 );
        await client.close();
    } );

    it( 'a 405 means the server offers no listening stream: no error, no retry', async () => 
    {
        const errors: Error[] = [];
        const { client, calls } = await connected( 
            listenServer( () => {return new Response( null, { status : 405 } );} ), 
            { listen : true }, 
            { onError : ( e ) => {errors.push( e );} } 
        );
        await tick();

        expect( calls.filter( ( c ) => {return c.method === 'GET';} ) ).toHaveLength( 1 );
        expect( errors ).toEqual( [] );
        await client.close();
    } );

    it.each( [
        [ 'a non-ok status', () => {return new Response( 'boom', { status : 500 } );}, 'MCP_TRANSPORT_ERROR' ],
        [ 'a 404 with a live session', () => {return new Response( null, { status : 404 } );}, 'MCP_SESSION_EXPIRED' ],
        [ 'a non-SSE content-type', () => {return jsonResponse( {} );}, 'MCP_PROTOCOL_ERROR' ],
        [ 'malformed event data', () => {return sseResponse( sse( { data : '{x' } ) );}, 'MCP_PROTOCOL_ERROR' ]
    ] )( 'reports %s through onError', async ( _label, answer, code ) => 
    {
        const errors: Error[] = [];
        const { client } = await connected( 
            listenServer( answer ), 
            { listen : true }, 
            { onError : ( e ) => {errors.push( e );} } 
        );
        await tick();
        await tick();

        expect( errors ).toHaveLength( 1 );
        expect( errors[0] ).toMatchObject( { code } );
        await client.close();
    } );

    it( 'resumes a dropped listening stream once with Last-Event-ID, then reports failure', async () => 
    {
        const errors: Error[] = [];
        let gets = 0;
        const { client, calls } = await connected( 
            listenServer( () => 
            {
                gets++;

                return sseResponse( sse( { id : `l${gets}`, data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );
            } ), 
            { listen : true }, 
            { onError : ( e ) => {errors.push( e );} } 
        );

        for( let i = 0; i < 10 && errors.length === 0; i++ )
        {
            await tick();
        }

        const getCalls = calls.filter( ( c ) => {return c.method === 'GET';} );
        expect( getCalls[0].headers.get( 'last-event-id' ) ).toBeNull();
        expect( getCalls[1].headers.get( 'last-event-id' ) ).toBe( 'l1' );
        expect( errors[0] ).toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringContaining( 'could not be resumed' ) } );
        await client.close();
    } );

    it( 'fails immediately when a dropped listening stream never carried an event id', async () => 
    {
        const errors: Error[] = [];
        const { client, calls } = await connected( 
            listenServer( () => {return sseResponse( sse( { data : { jsonrpc : '2.0', method : 'notifications/message' } } ) );} ), 
            { listen : true }, 
            { onError : ( e ) => {errors.push( e );} } 
        );

        for( let i = 0; i < 10 && errors.length === 0; i++ )
        {
            await tick();
        }

        expect( calls.filter( ( c ) => {return c.method === 'GET';} ) ).toHaveLength( 1 );
        expect( errors[0] ).toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
        await client.close();
    } );

    it( 'does not open a listening stream unless asked', async () => 
    {
        const { client, calls } = await connected( server() );
        await tick();

        expect( calls.some( ( c ) => {return c.method === 'GET';} ) ).toBe( false );
        await client.close();
    } );
} );
