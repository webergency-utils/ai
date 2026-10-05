import { describe, it, expect, vi } from 'vitest';
import 
{
    MCPClient,
    MCPServer,
    SSETransport,
    StreamableHTTPTransport,
    connectMCPClient
} from '../../src/mcp/index.js';
import type { JSONRPCMessage, JSONRPCRequest } from '../../src/mcp/types.js';
import { jsonResponse, streamResponse } from '../helpers/http.js';

const STREAM_URL = 'https://mcp.example/sse';

interface Live
{
    stream : ReadableStream<Uint8Array>
    push( text: string ): void
    end(): void
    fail( error: Error ): void
}

function liveStream(): Live
{
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>( { start( c ) {controller = c;} } );
    const encoder = new TextEncoder();

    return {
        stream,
        push : ( text ) => {controller.enqueue( encoder.encode( text ) );},
        end  : () => {controller.close();},
        fail : ( error ) => {controller.error( error );}
    };
}

const event = ( name: string | undefined, data: unknown ): string => 
{
    return `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify( data )}\n\n`;
};

interface Call
{
    url     : string
    method  : string
    headers : Headers
    body?   : JSONRPCMessage
    signal? : AbortSignal | null
}

interface Rig
{
    fetch : typeof fetch
    calls : Call[]
    live  : Live
}

/** Legacy SSE server: GET serves `live`, POSTs go to `onPost` (which usually pushes replies into the stream). */
function rig( onPost: ( call: Call, live: Live ) => Response | Promise<Response> = () => {return new Response( null, { status : 202 } );}, getResponse?: () => Response ): Rig
{
    const live = liveStream();
    const calls: Call[] = [];
    const impl = async ( url: unknown, init?: RequestInit ): Promise<Response> => 
    {
        const call: Call = {
            url     : String( url ),
            method  : init?.method ?? 'GET',
            headers : new Headers( init?.headers ),
            body    : typeof init?.body === 'string' ? JSON.parse( init.body ) as JSONRPCMessage : undefined,
            signal  : init?.signal
        };
        calls.push( call );

        if( call.method === 'GET' )
        {
            return getResponse ? getResponse() : streamResponse( live.stream );
        }

        return onPost( call, live );
    };

    return { fetch : impl as unknown as typeof fetch, calls, live };
}

/** Full legacy server backed by a real MCPServer. */
function mcpRig(): Rig
{
    const server = new MCPServer( { name : 'legacy', version : '1' } );
    server.registerTool( { name : 'echo', description : 'e', parameters : { type : 'object', properties : {} } }, async () => {return 'pong';} );
    const connection = server.createConnection();

    const r: Rig = rig( async ( call, live ) => 
    {
        void server.handleMessage( call.body!, undefined, connection ).then( ( response ) => 
        {
            if( response )
            {
                live.push( event( 'message', response ) );
            }
        } );

        return new Response( null, { status : 202 } );
    } );
    r.live.push( event( 'endpoint', '/messages?sessionId=abc' ) );

    return r;
}

const tick = (): Promise<void> => {return new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );};

describe( 'SSETransport endpoint handshake (R13)', () => 
{
    it( 'AE9: connect() resolves only after the endpoint event and the first POST goes to that URL', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        let resolved = false;

        const connecting = transport.connect().then( () => {resolved = true;} );
        await new Promise( ( resolve ) => {return setTimeout( resolve, 50 );} );
        expect( resolved ).toBe( false );
        await expect( transport.send( { jsonrpc : '2.0', method : 'x' } ) ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );

        r.live.push( event( 'endpoint', '/messages?sessionId=abc' ) );
        await connecting;
        expect( resolved ).toBe( true );

        await transport.send( { jsonrpc : '2.0', method : 'notifications/initialized' } );

        const post = r.calls.find( ( c ) => {return c.method === 'POST';} );
        expect( post?.url ).toBe( 'https://mcp.example/messages?sessionId=abc' );
        expect( post?.headers.get( 'content-type' ) ).toBe( 'application/json' );
        expect( r.calls.filter( ( c ) => {return c.url === STREAM_URL && c.method === 'POST';} ) ).toHaveLength( 0 );
        await transport.close();
    } );

    it( 'AE9: rejects after connectTimeoutMs without an endpoint event and tears the stream down', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch, connectTimeoutMs : 30 } );

        await expect( transport.connect() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringContaining( "'endpoint' event within 30ms" ) } );
        expect( r.calls[0].signal?.aborted ).toBe( true );
        await expect( transport.send( { jsonrpc : '2.0', method : 'x' } ) ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
    } );

    it( 'rejects when the stream ends before the endpoint event', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        const connecting = transport.connect();
        r.live.end();

        await expect( connecting ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR', message : expect.stringContaining( 'ended before' ) } );
    } );

    it( 'rejects a stream error before the endpoint event with that error', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        const connecting = transport.connect();
        r.live.fail( new TypeError( 'reset by peer' ) );

        await expect( connecting ).rejects.toThrow( 'reset by peer' );
    } );

    it.each( [
        [ 'a cross-origin endpoint', 'https://evil.example/post', /another origin/ ],
        [ 'an unparseable endpoint', 'http://[bad', /invalid URL/ ]
    ] )( 'rejects %s with MCP_PROTOCOL_ERROR', async ( _label, endpoint, message ) => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        const connecting = transport.connect();
        r.live.push( event( 'endpoint', endpoint ) );

        await expect( connecting ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR', message : expect.stringMatching( message ) } );
    } );

    it( 'rejects a message that arrives before the endpoint event', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        const connecting = transport.connect();
        r.live.push( event( 'message', { jsonrpc : '2.0', method : 'x' } ) );

        await expect( connecting ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR', message : expect.stringContaining( "before the 'endpoint'" ) } );
    } );

    it.each( [
        [ 'a non-ok status', () => {return new Response( 'down', { status : 503 } );}, 'MCP_TRANSPORT_ERROR' ],
        [ 'a non-SSE content-type', () => {return jsonResponse( {} );}, 'MCP_PROTOCOL_ERROR' ]
    ] )( 'rejects %s from the GET', async ( _label, answer, code ) => 
    {
        const r = rig( undefined, answer );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );

        await expect( transport.connect() ).rejects.toMatchObject( { code } );
    } );

    it( 'surfaces auth failures of the GET as MCPAuthError', async () => 
    {
        const r = rig( undefined, () => {return new Response( null, { status : 401, headers : { 'www-authenticate' : 'Bearer' } } );} );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );

        await expect( transport.connect() ).rejects.toMatchObject( { code : 'MCP_UNAUTHORIZED' } );
    } );

    it( 'connects only once and validates its URL', async () => 
    {
        expect( () => {return new SSETransport( 'nope' );} ).toThrow( /absolute URL/ );

        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        r.live.push( event( 'endpoint', '/m' ) );
        await transport.connect();

        await expect( transport.connect() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
        await transport.close();
    } );

    it( 'falls back to the global fetch when none is injected', async () => 
    {
        const spy = vi.spyOn( globalThis, 'fetch' ).mockResolvedValue( new Response( null, { status : 500 } ) );

        try
        {
            await expect( new SSETransport( STREAM_URL ).connect() ).rejects.toMatchObject( { details : { status : 500 } } );
            expect( spy ).toHaveBeenCalledTimes( 1 );
        }
        finally
        {
            spy.mockRestore();
        }
    } );
} );

describe( 'SSETransport auth and sending (R13, R15)', () => 
{
    it( 'sends custom and provider headers on the stream GET and every POST', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { 
            fetch        : r.fetch, 
            headers      : { 'x-tenant' : 't1' }, 
            authProvider : { getHeaders : async () => {return { authorization : 'Bearer tok' };} } 
        } );
        r.live.push( event( 'endpoint', '/m' ) );
        await transport.connect();
        await transport.send( { jsonrpc : '2.0', method : 'a' } );

        for( const call of r.calls )
        {
            expect( call.headers.get( 'authorization' ) ).toBe( 'Bearer tok' );
            expect( call.headers.get( 'x-tenant' ) ).toBe( 't1' );
        }

        expect( r.calls[0].headers.get( 'accept' ) ).toBe( 'text/event-stream' );
        await transport.close();
    } );

    it( 'retries a POST once after onUnauthorized refreshed the token', async () => 
    {
        let token = 'old';
        let attempts = 0;
        const r = rig( () => 
        {
            attempts++;

            return attempts === 1 ? new Response( null, { status : 401 } ) : new Response( null, { status : 202 } );
        } );
        const transport = new SSETransport( STREAM_URL, { 
            fetch        : r.fetch, 
            authProvider : { getHeaders : async () => {return { authorization : `Bearer ${token}` };}, onUnauthorized : async () => {token = 'new'; return true;} } 
        } );
        r.live.push( event( 'endpoint', '/m' ) );
        await transport.connect();
        await transport.send( { jsonrpc : '2.0', method : 'a' } );

        const posts = r.calls.filter( ( c ) => {return c.method === 'POST';} );
        expect( posts.map( ( p ) => {return p.headers.get( 'authorization' );} ) ).toEqual( [ 'Bearer old', 'Bearer new' ] );
        await transport.close();
    } );

    it( 'rejects a failing POST with its status and a truncated body', async () => 
    {
        const r = rig( () => {return new Response( 'y'.repeat( 4_000 ), { status : 500 } );} );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        r.live.push( event( 'endpoint', '/m' ) );
        await transport.connect();

        const failure = await transport.send( { jsonrpc : '2.0', method : 'a' } ).catch( ( e: unknown ) => {return e as Error;} ) as Error;

        expect( failure ).toMatchObject( { code : 'MCP_TRANSPORT_ERROR', details : { status : 500 } } );
        expect( failure.message.length ).toBeLessThan( 300 );
        await transport.close();
    } );
} );

describe( 'SSETransport stream failures (R13)', () => 
{
    async function connectedClient( onError?: ( e: Error ) => void )
    {
        const r = mcpRig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        const client = new MCPClient( transport, { onError } );
        await client.connect();

        return { r, client, transport };
    }

    it( 'round-trips a real MCPClient against a legacy SSE MCPServer', async () => 
    {
        const { client } = await connectedClient();

        expect( client.serverInfo?.name ).toBe( 'legacy' );
        expect( ( await client.listTools() ).map( ( t ) => {return t.name;} ) ).toEqual( [ 'echo' ] );
        expect( ( await client.callTool( 'echo' ) ).content[0].text ).toBe( 'pong' );
        await client.close();
    } );

    it( 'malformed event JSON is not swallowed: the client onError fires and the connection is dead afterwards', async () => 
    {
        const errors: Error[] = [];
        const { r, client } = await connectedClient( ( e ) => {errors.push( e );} );

        r.live.push( 'data: {not json\n\n' );
        await tick();
        await tick();

        expect( errors ).toHaveLength( 1 );
        expect( errors[0] ).toMatchObject( { code : 'MCP_PROTOCOL_ERROR', message : expect.stringContaining( 'malformed JSON' ) } );
        await expect( client.ping() ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
    } );

    it( 'closes the transport with the protocol error and rejects what was pending', async () => 
    {
        const r = rig();
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        r.live.push( event( 'endpoint', '/m' ) );
        await transport.connect();

        const onClose = vi.fn();
        const onError = vi.fn();
        transport.onClose( onClose );
        transport.onError( onError );

        r.live.push( 'data: {not json\n\n' );
        await tick();
        await tick();

        expect( onError ).toHaveBeenCalledTimes( 1 );
        expect( onClose ).toHaveBeenCalledWith( expect.objectContaining( { code : 'MCP_PROTOCOL_ERROR' } ) );
        expect( r.calls[0].signal?.aborted ).toBe( true );
        await expect( transport.send( { jsonrpc : '2.0', method : 'x' } ) ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_ERROR' } );
    } );

    it( 'rejects a pending client request with MCP_PROTOCOL_ERROR when the stream turns bad', async () => 
    {
        const r = rig( async ( call, live ) => 
        {
            const message = call.body as JSONRPCRequest;

            if( message.method === 'initialize' )
            {
                live.push( event( 'message', { jsonrpc : '2.0', id : message.id, result : { protocolVersion : '2025-06-18', capabilities : { tools : {} } } } ) );
            }
            else if( message.method === 'tools/list' )
            {
                live.push( 'data: [oops\n\n' );
            }

            return new Response( null, { status : 202 } );
        } );
        r.live.push( event( 'endpoint', '/m' ) );
        const client = new MCPClient( new SSETransport( STREAM_URL, { fetch : r.fetch } ), { onError : () => {} } );
        await client.connect();

        await expect( client.listTools() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'rejects a non JSON-RPC payload as a protocol error', async () => 
    {
        const r = rig();
        r.live.push( event( 'endpoint', '/m' ) );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        await transport.connect();
        const onClose = vi.fn();
        transport.onClose( onClose );

        r.live.push( event( 'message', { hello : 'world' } ) );
        await tick();
        await tick();

        expect( onClose ).toHaveBeenCalledWith( expect.objectContaining( { code : 'MCP_PROTOCOL_ERROR' } ) );
    } );

    it( 'ignores unknown event types and empty data', async () => 
    {
        const r = rig();
        r.live.push( event( 'endpoint', '/m' ) );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        await transport.connect();
        const received: JSONRPCMessage[] = [];
        transport.onMessage( ( m ) => {received.push( m );} );

        r.live.push( event( 'ping', 'keepalive' ) + 'data:\n\n' + event( undefined, { jsonrpc : '2.0', method : 'notifications/x' } ) );
        await tick();
        await tick();

        expect( received ).toEqual( [ { jsonrpc : '2.0', method : 'notifications/x' } ] );
        await transport.close();
    } );

    it( 'a clean stream end closes without an error', async () => 
    {
        const r = rig();
        r.live.push( event( 'endpoint', '/m' ) );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        await transport.connect();
        const onClose = vi.fn();
        const onError = vi.fn();
        transport.onClose( onClose );
        transport.onError( onError );

        r.live.end();
        await tick();
        await tick();

        expect( onClose ).toHaveBeenCalledTimes( 1 );
        expect( onClose.mock.calls[0] ).toEqual( [ undefined ] );
        expect( onError ).not.toHaveBeenCalled();
    } );

    it( 'an I/O error closes with that error and does not hit onError', async () => 
    {
        const r = rig();
        r.live.push( event( 'endpoint', '/m' ) );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        await transport.connect();
        const onClose = vi.fn();
        const onError = vi.fn();
        transport.onClose( onClose );
        transport.onError( onError );

        r.live.fail( new TypeError( 'reset' ) );
        await tick();
        await tick();

        expect( onClose ).toHaveBeenCalledWith( expect.objectContaining( { message : 'reset' } ) );
        expect( onError ).not.toHaveBeenCalled();
    } );

    it( 'close() aborts the stream, notifies once, and is idempotent', async () => 
    {
        const r = rig();
        r.live.push( event( 'endpoint', '/m' ) );
        const transport = new SSETransport( STREAM_URL, { fetch : r.fetch } );
        await transport.connect();
        const onClose = vi.fn();
        transport.onClose( onClose );

        await transport.close();
        await transport.close();

        expect( onClose ).toHaveBeenCalledTimes( 1 );
        expect( onClose.mock.calls[0] ).toEqual( [] );
        expect( r.calls[0].signal?.aborted ).toBe( true );
    } );
} );

describe( 'connectMCPClient fallback (R8)', () => 
{
    const initResult = { protocolVersion : '2025-06-18', capabilities : { tools : {} }, serverInfo : { name : 'x', version : '1' } };

    /** Streamable server stub answering initialize with 200 and notifications with 202. */
    function streamableOk( calls: Call[] ): typeof fetch
    {
        return ( async ( url: unknown, init?: RequestInit ) => 
        {
            const body = typeof init?.body === 'string' ? JSON.parse( init.body ) as { id?: number } : undefined;
            calls.push( { url : String( url ), method : init?.method ?? 'GET', headers : new Headers( init?.headers ), body : body as JSONRPCMessage } );

            return body?.id === undefined
                ? new Response( null, { status : 202 } )
                : jsonResponse( { jsonrpc : '2.0', id : body.id, result : initResult } );
        } ) as unknown as typeof fetch;
    }

    it( 'uses Streamable HTTP when the server accepts the POST', async () => 
    {
        const calls: Call[] = [];
        const client = await connectMCPClient( 'https://mcp.example/mcp', { fetch : streamableOk( calls ) } );

        expect( calls.every( ( c ) => {return c.method === 'POST';} ) ).toBe( true );
        expect( client.negotiatedVersion ).toBe( '2025-06-18' );
        await client.close();
    } );

    it.each( [ 400, 404, 405 ] )( 'falls back to legacy SSE when the POST gets %i', async ( status ) => 
    {
        const r = mcpRig();
        const fetchImpl = ( async ( url: unknown, init?: RequestInit ) => 
        {
            if( init?.method === 'POST' && String( url ) === 'https://mcp.example/mcp' )
            {
                return new Response( 'no post here', { status } );
            }

            return r.fetch( url as string, init );
        } ) as unknown as typeof fetch;

        const client = await connectMCPClient( 'https://mcp.example/mcp', { fetch : fetchImpl } );

        expect( client.serverInfo?.name ).toBe( 'legacy' );
        expect( ( await client.listTools() ).map( ( t ) => {return t.name;} ) ).toEqual( [ 'echo' ] );
        expect( r.calls.some( ( c ) => {return c.method === 'POST' && c.url.includes( '/messages?sessionId=abc' );} ) ).toBe( true );
        await client.close();
    } );

    it.each( [
        [ 500, 'MCP_TRANSPORT_ERROR' ],
        [ 401, 'MCP_UNAUTHORIZED' ],
        [ 403, 'MCP_FORBIDDEN' ]
    ] )( 'does not fall back on HTTP %i', async ( status, code ) => 
    {
        const r = mcpRig();
        const fetchImpl = ( async ( url: unknown, init?: RequestInit ) => 
        {
            return init?.method === 'POST' ? new Response( null, { status } ) : r.fetch( url as string, init );
        } ) as unknown as typeof fetch;

        await expect( connectMCPClient( 'https://mcp.example/mcp', { fetch : fetchImpl } ) ).rejects.toMatchObject( { code } );
        expect( r.calls.filter( ( c ) => {return c.method === 'GET';} ) ).toHaveLength( 0 );
    } );

    it( 'does not fall back on a protocol version mismatch', async () => 
    {
        const fetchImpl = ( async ( _url: unknown, init?: RequestInit ) => 
        {
            const body = JSON.parse( init!.body as string ) as { id: number };

            return jsonResponse( { jsonrpc : '2.0', id : body.id, result : { ...initResult, protocolVersion : '1999-01-01' } } );
        } ) as unknown as typeof fetch;

        await expect( connectMCPClient( 'https://mcp.example/mcp', { fetch : fetchImpl } ) ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_VERSION_UNSUPPORTED' } );
    } );

    it( 'reports both failures when the fallback fails too', async () => 
    {
        const fetchImpl = ( async () => {return new Response( 'gone', { status : 404 } );} ) as unknown as typeof fetch;

        await expect( connectMCPClient( 'https://mcp.example/mcp', { fetch : fetchImpl } ) ).rejects.toMatchObject( { 
            code    : 'MCP_CONNECT_FAILED', 
            message : expect.stringContaining( 'Streamable HTTP failed' ),
            details : { streamable : expect.objectContaining( { status : 404 } ), legacyCode : 'MCP_TRANSPORT_ERROR' }
        } );
    } );

    it( 'passes auth and client options through', async () => 
    {
        const calls: Call[] = [];
        const client = await connectMCPClient( 'https://mcp.example/mcp', { 
            fetch   : streamableOk( calls ), 
            headers : { authorization : 'Bearer abc' }, 
            client  : { maxPages : 2 }, 
            connect : { strictCapabilities : false } 
        } );

        expect( calls.every( ( c ) => {return c.headers.get( 'authorization' ) === 'Bearer abc';} ) ).toBe( true );
        await client.close();
    } );

    it( 'exports the transports it composes', () => 
    {
        expect( StreamableHTTPTransport ).toBeTypeOf( 'function' );
    } );
} );
