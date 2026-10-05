import { describe, it, expect, vi, afterEach } from 'vitest';
import 
{
    MCPClient,
    MCPServer,
    StreamableHTTPTransport,
    createMCPHttpHandler,
    createMCPTools,
    parseWWWAuthenticate,
    LATEST_PROTOCOL_VERSION,
    type MCPHttpHandlerOptions
} from '../../src/mcp/index.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import type { JSONRPCMessage } from '../../src/mcp/types.js';

const URL_ = 'https://srv.example/mcp';

afterEach( () => 
{
    vi.useRealTimers();
} );

function makeServer(): { server: MCPServer, invocations: unknown[] }
{
    const invocations: unknown[] = [];
    const server = new MCPServer( { name : 'http-srv', version : '1.2.3' } );

    server.registerTool( 
        { name : 'echo', description : 'echoes', parameters : { type : 'object', properties : { text : { type : 'string' } } } }, 
        async ( args, context ) => 
        {
            invocations.push( { args, context } );

            return `echo:${String( args.text )}`;
        } 
    );

    return { server, invocations };
}

const init = ( id: number | string = 1, extra: Record<string, unknown> = {} ): JSONRPCMessage => 
{
    return { jsonrpc : '2.0', id, method : 'initialize', params : { protocolVersion : LATEST_PROTOCOL_VERSION, capabilities : {}, clientInfo : { name : 'c', version : '1' }, ...extra } };
};

function post( 
    handler: ( req: Request ) => Promise<Response>, 
    body: unknown, 
    headers: Record<string, string> = {} 
): Promise<Response>
{
    return handler( new Request( URL_, { 
        method  : 'POST', 
        headers : { 'content-type' : 'application/json', accept : 'application/json, text/event-stream', ...headers }, 
        body    : typeof body === 'string' ? body : JSON.stringify( body ) 
    } ) );
}

async function startSession( handler: ( req: Request ) => Promise<Response> ): Promise<string>
{
    const res = await post( handler, init() );
    const id = res.headers.get( 'mcp-session-id' );

    expect( id ).toBeTruthy();

    return id!;
}

const asFetch = ( handler: ( req: Request ) => Promise<Response> ): typeof fetch => 
{
    return ( async ( url: unknown, init2?: RequestInit ) => {return handler( new Request( String( url ), init2 ) );} ) as unknown as typeof fetch;
};

describe( 'createMCPHttpHandler round trip (R9, R10, AE6)', () => 
{
    it( 'AE6: serves initialize, tools/list and tools/call to a StreamableHTTPTransport with sessions on', async () => 
    {
        const { server } = makeServer();
        const handler = createMCPHttpHandler( server, { sessions : true } );
        const transport = new StreamableHTTPTransport( URL_, { fetch : asFetch( handler ) } );
        const client = new MCPClient( transport );

        await client.connect();

        expect( transport.sessionId ).toBeTruthy();
        expect( client.serverInfo ).toEqual( { name : 'http-srv', version : '1.2.3' } );
        expect( ( await client.listTools() ).map( ( t ) => {return t.name;} ) ).toEqual( [ 'echo' ] );
        expect( ( await client.callTool( 'echo', { text : 'hi' } ) ).content[0].text ).toBe( 'echo:hi' );

        const sessionId = transport.sessionId!;
        await client.close();

        const after = await post( handler, { jsonrpc : '2.0', id : 9, method : 'tools/list' }, { 'mcp-session-id' : sessionId } );
        expect( after.status ).toBe( 404 );
    } );

    it( 'AE6: a later request without a session id gets 400, with an unknown id 404', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );
        await startSession( handler );

        const missing = await post( handler, { jsonrpc : '2.0', id : 2, method : 'tools/list' } );
        expect( missing.status ).toBe( 400 );
        expect( ( await missing.json() ).error.message ).toContain( 'Mcp-Session-Id' );

        const unknown = await post( handler, { jsonrpc : '2.0', id : 2, method : 'tools/list' }, { 'mcp-session-id' : 'nope' } );
        expect( unknown.status ).toBe( 404 );
    } );

    it( 'works statelessly: no session id issued or required, and no initialize needed', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );
        const transport = new StreamableHTTPTransport( URL_, { fetch : asFetch( handler ) } );
        const client = new MCPClient( transport );
        await client.connect();

        expect( transport.sessionId ).toBeUndefined();
        expect( ( await client.callTool( 'echo', { text : 'x' } ) ).content[0].text ).toBe( 'echo:x' );

        const direct = await post( handler, { jsonrpc : '2.0', id : 5, method : 'tools/list' } );
        expect( direct.status ).toBe( 200 );
        expect( ( await direct.json() ).result.tools ).toHaveLength( 1 );
    } );

    it( 'binds remote tools as agent tools over Streamable HTTP (createMCPTools)', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );
        const client = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : asFetch( handler ) } ) );
        await client.connect();

        const [ tool ] = await createMCPTools( client, { prefix : 'remote_' } );

        expect( tool.name ).toBe( 'remote_echo' );
        await expect( tool.run( { text : 'yo' } ) ).resolves.toBe( 'echo:yo' );
        await client.close();
    } );

    it( 'keeps sessions independent', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true, generateSessionId : ( () => {let n = 0; return () => {return `sid-${++n}`;};} )() } );

        expect( await startSession( handler ) ).toBe( 'sid-1' );
        expect( await startSession( handler ) ).toBe( 'sid-2' );

        const res = await post( handler, { jsonrpc : '2.0', id : 2, method : 'tools/list' }, { 'mcp-session-id' : 'sid-2' } );
        expect( res.status ).toBe( 200 );
    } );

    it( 'does not issue a session for a failed initialize', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );
        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'initialize', params : {} } );

        expect( res.status ).toBe( 200 );
        expect( ( await res.json() ).error.code ).toBe( -32602 );
        expect( res.headers.get( 'mcp-session-id' ) ).toBeNull();
    } );

    it( 'enforces the initialize lifecycle through the session connection', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );
        const id = await startSession( handler );
        const res = await post( handler, { jsonrpc : '2.0', id : 2, method : 'ping' }, { 'mcp-session-id' : id } );

        expect( ( await res.json() ).result ).toEqual( {} );
    } );
} );

describe( 'POST body handling (R9)', () => 
{
    it.each( [
        [ 'invalid JSON', '{nope', -32700 ],
        [ 'an empty body', '', -32700 ]
    ] )( 'answers %s with 400 and JSON-RPC -32700', async ( _label, body, code ) => 
    {
        const res = await post( createMCPHttpHandler( makeServer().server ), body );

        expect( res.status ).toBe( 400 );
        expect( ( await res.json() ).error.code ).toBe( code );
    } );

    it.each( [
        [ 'a non-object', '5' ],
        [ 'null', 'null' ],
        [ 'a wrong jsonrpc version', JSON.stringify( { jsonrpc : '1.0', id : 1, method : 'ping' } ) ],
        [ 'a message with neither method nor result', JSON.stringify( { jsonrpc : '2.0', id : 1 } ) ],
        [ 'a response without an id', JSON.stringify( { jsonrpc : '2.0', result : {} } ) ],
        [ 'a bad request id type', JSON.stringify( { jsonrpc : '2.0', id : { a : 1 }, method : 'ping' } ) ],
        [ 'an empty batch', '[]' ],
        [ 'a batch containing garbage', JSON.stringify( [ { jsonrpc : '2.0', id : 1, method : 'ping' }, 7 ] ) ]
    ] )( 'answers %s with 400 and -32600', async ( _label, body ) => 
    {
        const res = await post( createMCPHttpHandler( makeServer().server ), body );

        expect( res.status ).toBe( 400 );
        expect( ( await res.json() ).error.code ).toBe( -32600 );
    } );

    it( 'handles a batch of a request and a notification with one response array entry', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );
        const res = await post( handler, [ 
            { jsonrpc : '2.0', method : 'notifications/initialized' },
            { jsonrpc : '2.0', id : 7, method : 'ping' }
        ] );

        expect( res.status ).toBe( 200 );
        expect( res.headers.get( 'content-type' ) ).toBe( 'application/json' );
        expect( await res.json() ).toEqual( [ { jsonrpc : '2.0', id : 7, result : {} } ] );
    } );

    it( 'answers every request in a batch, in order', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );
        const res = await post( handler, [ 
            { jsonrpc : '2.0', id : 'a', method : 'ping' },
            { jsonrpc : '2.0', id : 'b', method : 'tools/call', params : { name : 'echo', arguments : { text : 'z' } } },
            { jsonrpc : '2.0', id : 'c', method : 'nope' }
        ] );
        const body = await res.json() as Array<{ id: string, result?: unknown, error?: { code: number } }>;

        expect( body.map( ( r ) => {return r.id;} ) ).toEqual( [ 'a', 'b', 'c' ] );
        expect( body[2].error?.code ).toBe( -32601 );
    } );

    it( 'returns 202 with no body for notifications-only and response-only posts', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );

        for( const body of [ 
            { jsonrpc : '2.0', method : 'notifications/initialized' }, 
            [ { jsonrpc : '2.0', method : 'notifications/a' }, { jsonrpc : '2.0', method : 'notifications/b' } ],
            { jsonrpc : '2.0', id : 3, result : {} }
        ] )
        {
            const res = await post( handler, body );

            expect( res.status ).toBe( 202 );
            expect( await res.text() ).toBe( '' );
        }
    } );

    it( 'rejects initialize inside a batch', async () => 
    {
        const res = await post( createMCPHttpHandler( makeServer().server ), [ init(), { jsonrpc : '2.0', id : 2, method : 'ping' } ] );

        expect( res.status ).toBe( 400 );
        expect( ( await res.json() ).error.message ).toContain( 'batched' );
    } );

    it( 'validates the MCP-Protocol-Version header on non-initialize requests', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );
        const ping = { jsonrpc : '2.0', id : 1, method : 'ping' };

        expect( ( await post( handler, ping, { 'mcp-protocol-version' : '1999-01-01' } ) ).status ).toBe( 400 );
        expect( ( await post( handler, ping, { 'mcp-protocol-version' : LATEST_PROTOCOL_VERSION } ) ).status ).toBe( 200 );
        expect( ( await post( handler, ping ) ).status ).toBe( 200 );
        expect( ( await post( handler, init(), { 'mcp-protocol-version' : '1999-01-01' } ) ).status ).toBe( 200 );
    } );
} );

describe( 'body size cap (R9)', () => 
{
    it( 'rejects a declared content-length over the cap with 413 before reading', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { maxBodyBytes : 100 } );
        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'ping', params : { pad : 'x'.repeat( 500 ) } }, { 'content-length' : '600' } );

        expect( res.status ).toBe( 413 );
    } );

    it( 'rejects a streamed body that exceeds the cap without a content-length', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { maxBodyBytes : 100 } );
        const chunk = new TextEncoder().encode( 'x'.repeat( 60 ) );
        const body = new ReadableStream<Uint8Array>( { 
            pull( controller ) 
            {
                controller.enqueue( chunk );
            } 
        } );

        const res = await handler( new Request( URL_, { method : 'POST', body, duplex : 'half' } as RequestInit ) );

        expect( res.status ).toBe( 413 );
    } );

    it( 'accepts a body exactly at the cap and reads multi-chunk bodies', async () => 
    {
        const message = JSON.stringify( { jsonrpc : '2.0', id : 1, method : 'ping' } );
        const bytes = new TextEncoder().encode( message );
        const handler = createMCPHttpHandler( makeServer().server, { maxBodyBytes : bytes.byteLength } );
        const half = Math.floor( bytes.byteLength / 2 );
        const body = new ReadableStream<Uint8Array>( { 
            start( controller ) 
            {
                controller.enqueue( bytes.subarray( 0, half ) );
                controller.enqueue( bytes.subarray( half ) );
                controller.close();
            } 
        } );

        const res = await handler( new Request( URL_, { method : 'POST', body, duplex : 'half' } as RequestInit ) );

        expect( res.status ).toBe( 200 );
        expect( ( await res.json() ).result ).toEqual( {} );
    } );

    it( 'validates numeric options', () => 
    {
        const { server } = makeServer();

        for( const bad of [ { maxBodyBytes : 0 }, { sessionTtlMs : -1 }, { maxSessions : Number.NaN } ] as MCPHttpHandlerOptions[] )
        {
            expect( () => {return createMCPHttpHandler( server, bad );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
        }
    } );
} );

describe( 'other methods and sessions lifecycle (R9, R10)', () => 
{
    it( 'GET is 405 with an Allow header, other verbs too', async () => 
    {
        const stateless = createMCPHttpHandler( makeServer().server );
        const stateful = createMCPHttpHandler( makeServer().server, { sessions : true } );

        const get = await stateless( new Request( URL_, { method : 'GET' } ) );
        expect( get.status ).toBe( 405 );
        expect( get.headers.get( 'allow' ) ).toBe( 'POST' );

        expect( ( await stateful( new Request( URL_, { method : 'GET' } ) ) ).headers.get( 'allow' ) ).toBe( 'POST, DELETE' );
        expect( ( await stateless( new Request( URL_, { method : 'PUT', body : '{}' } ) ) ).status ).toBe( 405 );
    } );

    it( 'DELETE is 405 when sessions are off', async () => 
    {
        const res = await createMCPHttpHandler( makeServer().server )( new Request( URL_, { method : 'DELETE', headers : { 'mcp-session-id' : 'x' } } ) );

        expect( res.status ).toBe( 405 );
    } );

    it( 'DELETE terminates a session; missing or unknown ids are 400 / 404', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );
        const id = await startSession( handler );
        const del = ( sid?: string ) => {return handler( new Request( URL_, { method : 'DELETE', headers : sid ? { 'mcp-session-id' : sid } : {} } ) );};

        expect( ( await del() ).status ).toBe( 400 );
        expect( ( await del( 'unknown' ) ).status ).toBe( 404 );
        expect( ( await del( id ) ).status ).toBe( 204 );
        expect( ( await del( id ) ).status ).toBe( 404 );

        const after = await post( handler, { jsonrpc : '2.0', id : 2, method : 'ping' }, { 'mcp-session-id' : id } );
        expect( after.status ).toBe( 404 );
    } );

    it( 'expires idle sessions after sessionTtlMs and refreshes the clock on use', async () => 
    {
        vi.useFakeTimers();
        vi.setSystemTime( new Date( '2026-01-01T00:00:00Z' ) );

        const handler = createMCPHttpHandler( makeServer().server, { sessions : true, sessionTtlMs : 1_000 } );
        const id = await startSession( handler );
        const ping = () => {return post( handler, { jsonrpc : '2.0', id : 2, method : 'ping' }, { 'mcp-session-id' : id } );};

        vi.setSystemTime( Date.now() + 800 );
        expect( ( await ping() ).status ).toBe( 200 );
        vi.setSystemTime( Date.now() + 800 );
        expect( ( await ping() ).status ).toBe( 200 );
        vi.setSystemTime( Date.now() + 1_001 );
        expect( ( await ping() ).status ).toBe( 404 );
    } );

    it( 'caps concurrent sessions with 503, purging expired ones first', async () => 
    {
        vi.useFakeTimers();
        vi.setSystemTime( new Date( '2026-01-01T00:00:00Z' ) );

        const handler = createMCPHttpHandler( makeServer().server, { sessions : true, maxSessions : 2, sessionTtlMs : 1_000 } );
        const first = await startSession( handler );
        await startSession( handler );

        const refused = await post( handler, init() );
        expect( refused.status ).toBe( 503 );
        expect( refused.headers.get( 'mcp-session-id' ) ).toBeNull();

        // Ending one frees a slot.
        await handler( new Request( URL_, { method : 'DELETE', headers : { 'mcp-session-id' : first } } ) );
        expect( ( await post( handler, init() ) ).status ).toBe( 200 );

        // Expiry frees slots too.
        vi.setSystemTime( Date.now() + 2_000 );
        expect( ( await post( handler, init() ) ).status ).toBe( 200 );
    } );
} );

describe( 'Origin validation (R11, AE7)', () => 
{
    it( 'AE7: a cross-origin request gets 403 and never reaches a tool', async () => 
    {
        const { server, invocations } = makeServer();
        const handler = createMCPHttpHandler( server );

        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'tools/call', params : { name : 'echo', arguments : { text : 'x' } } }, { origin : 'https://evil.example' } );

        expect( res.status ).toBe( 403 );
        expect( invocations ).toEqual( [] );
    } );

    it( 'allows same-origin and Origin-less requests by default', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server );
        const ping = { jsonrpc : '2.0', id : 1, method : 'ping' };

        expect( ( await post( handler, ping, { origin : 'https://srv.example' } ) ).status ).toBe( 200 );
        expect( ( await post( handler, ping ) ).status ).toBe( 200 );
        expect( ( await post( handler, ping, { origin : 'http://srv.example' } ) ).status ).toBe( 403 );
    } );

    it( 'honours allowedOrigins, including the wildcard', async () => 
    {
        const ping = { jsonrpc : '2.0', id : 1, method : 'ping' };
        const listed = createMCPHttpHandler( makeServer().server, { allowedOrigins : [ 'https://app.example' ] } );

        expect( ( await post( listed, ping, { origin : 'https://app.example' } ) ).status ).toBe( 200 );
        // An explicit list replaces the same-origin default.
        expect( ( await post( listed, ping, { origin : 'https://srv.example' } ) ).status ).toBe( 403 );

        const open = createMCPHttpHandler( makeServer().server, { allowedOrigins : [ '*' ] } );
        expect( ( await post( open, ping, { origin : 'https://anything.example' } ) ).status ).toBe( 200 );
    } );

    it( 'checks Origin before authentication and before reading the body', async () => 
    {
        const authenticate = vi.fn( async () => {return { ok : true as const };} );
        const handler = createMCPHttpHandler( makeServer().server, { authenticate } );

        const res = await post( handler, '{garbage', { origin : 'https://evil.example' } );

        expect( res.status ).toBe( 403 );
        expect( authenticate ).not.toHaveBeenCalled();
    } );

    it( 'applies to DELETE and GET as well', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { sessions : true } );

        for( const method of [ 'GET', 'DELETE' ] )
        {
            expect( ( await handler( new Request( URL_, { method, headers : { origin : 'https://evil.example' } } ) ) ).status ).toBe( 403 );
        }
    } );
} );

describe( 'authentication (R12)', () => 
{
    it( 'denial is 401 with a Bearer challenge carrying error, scope and resource_metadata', async () => 
    {
        const { server, invocations } = makeServer();
        const handler = createMCPHttpHandler( server, { 
            authenticate        : async () => {return { ok : false as const, error : 'invalid_token', errorDescription : 'expired "token"', scope : 'mcp:tools' };},
            resourceMetadataUrl : 'https://srv.example/.well-known/oauth-protected-resource'
        } );

        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'tools/call', params : { name : 'echo', arguments : {} } } );
        const [ challenge ] = parseWWWAuthenticate( res.headers.get( 'www-authenticate' ) );

        expect( res.status ).toBe( 401 );
        expect( challenge ).toEqual( { 
            scheme : 'Bearer', 
            params : { 
                error             : 'invalid_token', 
                error_description : 'expired "token"', 
                scope             : 'mcp:tools', 
                resource_metadata : 'https://srv.example/.well-known/oauth-protected-resource' 
            } 
        } );
        expect( invocations ).toEqual( [] );
    } );

    it( 'a bare denial is a plain Bearer challenge; malformed results fail closed', async () => 
    {
        for( const result of [ { ok : false as const }, undefined, null, { ok : 'yes' } ] )
        {
            const handler = createMCPHttpHandler( makeServer().server, { authenticate : async () => {return result as never;} } );
            const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'ping' } );

            expect( res.status ).toBe( 401 );
            expect( res.headers.get( 'www-authenticate' ) ).toBe( 'Bearer' );
        }
    } );

    it( 'runs before the body is parsed', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { authenticate : async () => {return { ok : false as const };} } );

        expect( ( await post( handler, '{garbage' ) ).status ).toBe( 401 );
        expect( ( await handler( new Request( URL_, { method : 'GET' } ) ) ).status ).toBe( 401 );
    } );

    it( 'passes the request to authenticate and its context to tool handlers', async () => 
    {
        const { server, invocations } = makeServer();
        const context = new SimpleExecutionContext( {} );
        const seen: string[] = [];
        const handler = createMCPHttpHandler( server, { 
            authenticate : async ( req ) => 
            {
                seen.push( req.headers.get( 'authorization' ) ?? '' );

                return { ok : true as const, context };
            } 
        } );

        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'tools/call', params : { name : 'echo', arguments : { text : 'a' } } }, { authorization : 'Bearer good' } );

        expect( res.status ).toBe( 200 );
        expect( seen ).toEqual( [ 'Bearer good' ] );
        expect( ( invocations[0] as { context: unknown } ).context ).toBe( context );
    } );

    it( 'an authenticate that throws is a 500 reported through onError, never a pass', async () => 
    {
        const { server, invocations } = makeServer();
        const errors: Error[] = [];
        const handler = createMCPHttpHandler( server, { 
            authenticate : async () => {throw new Error( 'jwks unreachable' );}, 
            onError      : ( e ) => {errors.push( e );} 
        } );

        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'tools/call', params : { name : 'echo', arguments : {} } } );

        expect( res.status ).toBe( 500 );
        expect( errors.map( ( e ) => {return e.message;} ) ).toEqual( [ 'jwks unreachable' ] );
        expect( invocations ).toEqual( [] );
        expect( await res.text() ).not.toContain( 'jwks' );
    } );

    it( 'wraps non-Error throws for onError', async () => 
    {
        const errors: Error[] = [];
        const handler = createMCPHttpHandler( makeServer().server, { authenticate : async () => {throw 'plain string';}, onError : ( e ) => {errors.push( e );} } );

        await post( handler, { jsonrpc : '2.0', id : 1, method : 'ping' } );

        expect( errors[0] ).toMatchObject( { code : 'MCP_SERVER_ERROR', message : 'plain string' } );
    } );

    it( 'a 401 from the handler surfaces as MCPAuthError to a client with the challenge', async () => 
    {
        const handler = createMCPHttpHandler( makeServer().server, { 
            authenticate        : async ( req ) => {return req.headers.get( 'authorization' ) === 'Bearer ok' ? { ok : true as const } : { ok : false as const, error : 'invalid_token' };}, 
            resourceMetadataUrl : 'https://srv.example/meta' 
        } );

        const bad = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : asFetch( handler ), headers : { authorization : 'Bearer nope' } } ) );
        await expect( bad.connect() ).rejects.toMatchObject( { code : 'MCP_UNAUTHORIZED', resourceMetadata : 'https://srv.example/meta' } );

        const good = new MCPClient( new StreamableHTTPTransport( URL_, { fetch : asFetch( handler ), headers : { authorization : 'Bearer ok' } } ) );
        await good.connect();
        expect( good.serverInfo?.name ).toBe( 'http-srv' );
    } );
} );

describe( 'internal failures (R9)', () => 
{
    it( 'a throwing server answers 500 without leaking the message and reports through onError', async () => 
    {
        const { server } = makeServer();
        vi.spyOn( server, 'handleMessage' ).mockRejectedValue( new Error( 'secret internals' ) );
        const errors: Error[] = [];
        const handler = createMCPHttpHandler( server, { onError : ( e ) => {errors.push( e );} } );

        const res = await post( handler, { jsonrpc : '2.0', id : 1, method : 'ping' } );

        expect( res.status ).toBe( 500 );
        expect( await res.text() ).not.toContain( 'secret' );
        expect( errors[0].message ).toBe( 'secret internals' );
    } );

    it( 'does not need an onError hook', async () => 
    {
        const { server } = makeServer();
        vi.spyOn( server, 'handleMessage' ).mockRejectedValue( new Error( 'x' ) );

        expect( ( await post( createMCPHttpHandler( server ), { jsonrpc : '2.0', id : 1, method : 'ping' } ) ).status ).toBe( 500 );
    } );
} );
