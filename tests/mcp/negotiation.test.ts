import { describe, it, expect, vi } from 'vitest';
import 
{
    MCPClient,
    MCPServer,
    InMemoryTransport,
    SUPPORTED_PROTOCOL_VERSIONS,
    LATEST_PROTOCOL_VERSION
} from '../../src/mcp/index.js';
import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse } from '../../src/mcp/types.js';

type Reply = ( request: JSONRPCRequest ) => Record<string, unknown> | undefined;

interface FakeServer
{
    received : JSONRPCMessage[]
    client   : MCPClient
    clientT  : InMemoryTransport
    serverT  : InMemoryTransport
}

/** A scripted peer: `replies[method]` returns the response fields (`result` / `error`), or undefined for silence. */
async function fakeServer( 
    replies: Record<string, Reply>, 
    clientOptions: ConstructorParameters<typeof MCPClient>[1] = {} 
): Promise<FakeServer>
{
    const [ clientT, serverT ] = InMemoryTransport.createPair();
    const received: JSONRPCMessage[] = [];

    await serverT.connect();
    serverT.onMessage( async ( message ) => 
    {
        received.push( message );

        if( !( 'method' in message ) || !( 'id' in message ) || message.id === undefined )
        {
            return;
        }

        const reply = replies[message.method]?.( message as JSONRPCRequest );

        if( reply )
        {
            await serverT.send( { jsonrpc : '2.0', id : message.id, ...reply } as JSONRPCResponse );
        }
    } );

    return { received, client : new MCPClient( clientT, clientOptions ), clientT, serverT };
}

const initOk = ( overrides: Record<string, unknown> = {} ): Reply => 
{
    return () => 
    {
        return {
            result : {
                protocolVersion : '2025-06-18',
                capabilities    : { tools : {} },
                serverInfo      : { name : 'fake', version : '9.9' },
                ...overrides
            }
        };
    };
};

describe( 'protocol constants (R1)', () => 
{
    it( 'lists supported versions newest first including the required baseline', () => 
    {
        expect( SUPPORTED_PROTOCOL_VERSIONS[0] ).toBe( LATEST_PROTOCOL_VERSION );
        expect( SUPPORTED_PROTOCOL_VERSIONS ).toEqual( expect.arrayContaining( [ '2025-06-18', '2025-03-26', '2024-11-05' ] ) );

        const sorted = [ ...SUPPORTED_PROTOCOL_VERSIONS ].sort().reverse();
        expect( [ ...SUPPORTED_PROTOCOL_VERSIONS ] ).toEqual( sorted );
    } );
} );

describe( 'MCPClient negotiation (R2, R3)', () => 
{
    it( 'offers the latest version and stores the negotiated result', async () => 
    {
        const peer = await fakeServer( { initialize : initOk( { instructions : 'be nice' } ) } );

        expect( peer.client.negotiatedVersion ).toBeUndefined();
        await peer.client.connect();

        const init = peer.received[0] as JSONRPCRequest;
        expect( init.method ).toBe( 'initialize' );
        expect( init.params?.protocolVersion ).toBe( LATEST_PROTOCOL_VERSION );

        expect( peer.client.negotiatedVersion ).toBe( '2025-06-18' );
        expect( peer.client.serverCapabilities ).toEqual( { tools : {} } );
        expect( peer.client.serverInfo ).toEqual( { name : 'fake', version : '9.9' } );
        expect( peer.client.instructions ).toBe( 'be nice' );

        expect( peer.received.some( ( m ) => {return 'method' in m && m.method === 'notifications/initialized';} ) ).toBe( true );
    } );

    it( 'AE1: rejects an unsupported server version, closes the transport and never sends initialized', async () => 
    {
        const peer = await fakeServer( { initialize : initOk( { protocolVersion : '1999-01-01' } ) } );
        const closed = vi.spyOn( peer.clientT, 'close' );

        await expect( peer.client.connect() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_VERSION_UNSUPPORTED' } );

        expect( closed ).toHaveBeenCalled();
        expect( peer.received.some( ( m ) => {return 'method' in m && m.method === 'notifications/initialized';} ) ).toBe( false );
        expect( peer.client.negotiatedVersion ).toBeUndefined();
    } );

    it( 'accepts an older supported revision', async () => 
    {
        const peer = await fakeServer( { initialize : initOk( { protocolVersion : '2024-11-05' } ) } );
        await peer.client.connect();

        expect( peer.client.negotiatedVersion ).toBe( '2024-11-05' );
    } );

    it( 'surfaces a JSON-RPC error answering initialize and closes the transport', async () => 
    {
        const peer = await fakeServer( { initialize : () => {return { error : { code : -32603, message : 'boom' } };} } );
        const closed = vi.spyOn( peer.clientT, 'close' );

        await expect( peer.client.connect() ).rejects.toMatchObject( { code : 'MCP_CLIENT_ERROR', message : expect.stringContaining( 'boom' ) } );
        expect( closed ).toHaveBeenCalled();
    } );

    it.each( [
        [ 'a missing capabilities object', { capabilities : undefined } ],
        [ 'a malformed serverInfo', { serverInfo : 'nope' } ],
        [ 'non-string instructions', { instructions : 5 } ]
    ] )( 'rejects %s with MCP_PROTOCOL_ERROR', async ( _label, overrides ) => 
    {
        const peer = await fakeServer( { initialize : initOk( overrides ) } );

        await expect( peer.client.connect() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'rejects a missing protocolVersion', async () => 
    {
        const peer = await fakeServer( { initialize : initOk( { protocolVersion : undefined } ) } );

        await expect( peer.client.connect() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_VERSION_UNSUPPORTED' } );
    } );

    it( 'rejects a non-object initialize result', async () => 
    {
        const peer = await fakeServer( { initialize : () => {return { result : [] };} } );

        await expect( peer.client.connect() ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'AE2: throws MCP_CAPABILITY_MISSING without sending when the capability was not advertised', async () => 
    {
        const peer = await fakeServer( { initialize : initOk() } );
        await peer.client.connect();
        const before = peer.received.length;

        await expect( peer.client.listResources() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING', details : { capability : 'resources' } } );
        await expect( peer.client.listResourceTemplates() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );
        await expect( peer.client.readResource( 'file:///x' ) ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );
        await expect( peer.client.listPrompts() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING', details : { capability : 'prompts' } } );
        await expect( peer.client.getPrompt( 'p' ) ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );

        expect( peer.received.length ).toBe( before );
    } );

    it( 'gates tools too, and strictCapabilities:false opts out', async () => 
    {
        const strict = await fakeServer( { initialize : initOk( { capabilities : {} } ) } );
        await strict.client.connect();
        await expect( strict.client.listTools() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING', details : { capability : 'tools' } } );
        await expect( strict.client.callTool( 'x' ) ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );

        const lax = await fakeServer( 
            { initialize : initOk( { capabilities : {} } ), 'resources/list' : () => {return { result : { resources : [ { uri : 'a://b', name : 'b' } ] } };} } 
        );
        await lax.client.connect( { strictCapabilities : false } );
        await expect( lax.client.listResources() ).resolves.toEqual( [ { uri : 'a://b', name : 'b' } ] );
    } );

    it( 'refuses list calls before connect() completed', async () => 
    {
        const peer = await fakeServer( { initialize : initOk() } );

        await expect( peer.client.listTools() ).rejects.toMatchObject( { code : 'MCP_NOT_CONNECTED' } );
        await expect( peer.client.ping() ).rejects.toMatchObject( { code : 'MCP_NOT_CONNECTED' } );
    } );

    it( 'rejects an invalid maxPages', () => 
    {
        const [ t ] = InMemoryTransport.createPair();

        expect( () => {return new MCPClient( t, { maxPages : 0 } );} ).toThrow( /maxPages/ );
    } );
} );

describe( 'server-initiated traffic (R4)', () => 
{
    it( 'answers ping and unknown server requests, and routes notifications to listeners', async () => 
    {
        const peer = await fakeServer( { initialize : initOk() } );
        await peer.client.connect();

        const seen: string[] = [];
        const off = peer.client.onNotification( ( n ) => {seen.push( n.method );} );

        await peer.serverT.send( { jsonrpc : '2.0', id : 'p1', method : 'ping' } );
        await peer.serverT.send( { jsonrpc : '2.0', id : 'r1', method : 'roots/list' } );
        await peer.serverT.send( { jsonrpc : '2.0', method : 'notifications/message', params : { level : 'info' } } );
        await new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );

        const replies = peer.received.filter( ( m ) => {return !( 'method' in m );} ) as JSONRPCResponse[];
        expect( replies.find( ( r ) => {return r.id === 'p1';} )?.result ).toEqual( {} );
        expect( replies.find( ( r ) => {return r.id === 'r1';} )?.error?.code ).toBe( -32601 );
        expect( seen ).toEqual( [ 'notifications/message' ] );

        off();
        await peer.serverT.send( { jsonrpc : '2.0', method : 'notifications/later' } );
        await new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );
        expect( seen ).toEqual( [ 'notifications/message' ] );
    } );

    it( 'reports a throwing notification handler through onError and keeps dispatching', async () => 
    {
        const errors: Error[] = [];
        const peer = await fakeServer( { initialize : initOk() }, { onError : ( e ) => {errors.push( e );} } );
        await peer.client.connect();

        const seen: string[] = [];
        peer.client.onNotification( () => {throw new Error( 'handler bug' );} );
        peer.client.onNotification( ( n ) => {seen.push( n.method );} );

        await peer.serverT.send( { jsonrpc : '2.0', method : 'notifications/x' } );
        await new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );

        expect( errors.map( ( e ) => {return e.message;} ) ).toEqual( [ 'handler bug' ] );
        expect( seen ).toEqual( [ 'notifications/x' ] );
    } );

    it( 'does not swallow handler errors when no onError is set (async rethrow)', async () => 
    {
        const peer = await fakeServer( { initialize : initOk() } );
        await peer.client.connect();
        peer.client.onNotification( () => {throw new Error( 'loud' );} );

        const deferred: Array<() => void> = [];
        const spy = vi.spyOn( globalThis, 'queueMicrotask' ).mockImplementation( ( cb ) => {deferred.push( cb );} );

        try
        {
            await peer.serverT.send( { jsonrpc : '2.0', method : 'notifications/x' } );
        }
        finally
        {
            spy.mockRestore();
        }

        expect( deferred ).toHaveLength( 1 );
        expect( deferred[0] ).toThrow( 'loud' );
    } );

    it( 'client.ping() resolves on {} and rejects on error', async () => 
    {
        let fail = false;
        const peer = await fakeServer( { 
            initialize : initOk(), 
            ping       : () => {return fail ? { error : { code : -32603, message : 'nope' } } : { result : {} };} 
        } );
        await peer.client.connect();

        await expect( peer.client.ping() ).resolves.toBeUndefined();
        fail = true;
        await expect( peer.client.ping() ).rejects.toMatchObject( { code : 'MCP_CLIENT_ERROR' } );
    } );
} );

describe( 'pagination (R14a)', () => 
{
    it( 'follows nextCursor across pages', async () => 
    {
        const calls: unknown[] = [];
        const peer = await fakeServer( { 
            initialize   : initOk(),
            'tools/list' : ( req ) => 
            {
                calls.push( req.params );
                const tool = ( name: string ) => {return { name, inputSchema : { type : 'object' } };};

                return req.params?.cursor === 'c2'
                    ? { result : { tools : [ tool( 'b' ) ] } }
                    : { result : { tools : [ tool( 'a' ) ], nextCursor : 'c2' } };
            }
        } );
        await peer.client.connect();

        const tools = await peer.client.listTools();

        expect( tools.map( ( t ) => {return t.name;} ) ).toEqual( [ 'a', 'b' ] );
        expect( calls ).toEqual( [ {}, { cursor : 'c2' } ] );
    } );

    it( 'throws MCP_PAGINATION_LIMIT past maxPages', async () => 
    {
        let n = 0;
        const peer = await fakeServer( { 
            initialize   : initOk(),
            'tools/list' : () => {return { result : { tools : [], nextCursor : `c${++n}` } };}
        }, { maxPages : 3 } );
        await peer.client.connect();

        await expect( peer.client.listTools() ).rejects.toMatchObject( { code : 'MCP_PAGINATION_LIMIT' } );
        expect( n ).toBe( 3 );
    } );

    it( 'throws on a repeated cursor instead of looping', async () => 
    {
        const peer = await fakeServer( { 
            initialize   : initOk(),
            'tools/list' : () => {return { result : { tools : [], nextCursor : 'same' } };}
        } );
        await peer.client.connect();

        await expect( peer.client.listTools() ).rejects.toMatchObject( { code : 'MCP_PAGINATION_LOOP' } );
    } );

    it.each( [
        [ 'a non-string nextCursor', { tools : [], nextCursor : 5 }, 'MCP_PROTOCOL_ERROR' ],
        [ 'an empty nextCursor', { tools : [], nextCursor : '' }, 'MCP_PROTOCOL_ERROR' ],
        [ 'a missing tools array', {}, 'MCP_PROTOCOL_ERROR' ]
    ] )( 'rejects %s', async ( _label, result, code ) => 
    {
        const peer = await fakeServer( { initialize : initOk(), 'tools/list' : () => {return { result };} } );
        await peer.client.connect();

        await expect( peer.client.listTools() ).rejects.toMatchObject( { code } );
    } );

    it( 'surfaces a JSON-RPC error on a page', async () => 
    {
        const peer = await fakeServer( { initialize : initOk(), 'tools/list' : () => {return { error : { code : -32603, message : 'down' } };} } );
        await peer.client.connect();

        await expect( peer.client.listTools() ).rejects.toMatchObject( { code : 'MCP_CLIENT_ERROR', message : expect.stringContaining( 'down' ) } );
    } );
} );

describe( 'MCPServer negotiation and lifecycle (R4a)', () => 
{
    const init = ( id: number, version: unknown ): JSONRPCRequest => 
    {
        return { jsonrpc : '2.0', id, method : 'initialize', params : { protocolVersion : version, capabilities : {}, clientInfo : { name : 'c', version : '1' } } as Record<string, unknown> };
    };

    it( 'echoes a supported client version', async () => 
    {
        const server = new MCPServer();
        const res = await server.handleMessage( init( 1, '2025-03-26' ) );

        expect( ( res?.result as { protocolVersion: string } ).protocolVersion ).toBe( '2025-03-26' );
    } );

    it( 'answers an unknown client version with the latest supported', async () => 
    {
        const server = new MCPServer();
        const res = await server.handleMessage( init( 1, '1999-01-01' ) );

        expect( ( res?.result as { protocolVersion: string } ).protocolVersion ).toBe( LATEST_PROTOCOL_VERSION );
    } );

    it( 'rejects initialize without a string protocolVersion with -32602', async () => 
    {
        const server = new MCPServer();
        const res = await server.handleMessage( init( 1, undefined ) );

        expect( res?.error?.code ).toBe( -32602 );
    } );

    it( 'answers ping with {} with and without a connection', async () => 
    {
        const server = new MCPServer();
        const connection = server.createConnection();

        expect( ( await server.handleMessage( { jsonrpc : '2.0', id : 1, method : 'ping' } ) )?.result ).toEqual( {} );
        expect( ( await server.handleMessage( { jsonrpc : '2.0', id : 2, method : 'ping' }, undefined, connection ) )?.result ).toEqual( {} );
    } );

    it( 'rejects every method but ping/initialize with -32002 before initialize, per connection', async () => 
    {
        const server = new MCPServer();
        const connection = server.createConnection();

        const early = await server.handleMessage( { jsonrpc : '2.0', id : 1, method : 'tools/list' }, undefined, connection );
        expect( early?.error?.code ).toBe( -32002 );

        await server.handleMessage( init( 2, '2025-06-18' ), undefined, connection );
        expect( connection ).toEqual( { initialized : true, protocolVersion : '2025-06-18' } );

        const later = await server.handleMessage( { jsonrpc : '2.0', id : 3, method : 'tools/list' }, undefined, connection );
        expect( later?.error ).toBeUndefined();

        // A second connection is still uninitialized.
        const other = await server.handleMessage( { jsonrpc : '2.0', id : 4, method : 'tools/list' }, undefined, server.createConnection() );
        expect( other?.error?.code ).toBe( -32002 );
    } );

    it( 'gates requests arriving over connect() before initialize', async () => 
    {
        const server = new MCPServer();
        const [ clientT, serverT ] = InMemoryTransport.createPair();
        await server.connect( serverT );
        await clientT.connect();

        const responses: JSONRPCResponse[] = [];
        clientT.onMessage( ( m ) => {responses.push( m as JSONRPCResponse );} );

        await clientT.send( { jsonrpc : '2.0', id : 1, method : 'tools/list' } );
        await new Promise( ( resolve ) => {return setTimeout( resolve, 0 );} );

        expect( responses[0].error?.code ).toBe( -32002 );
    } );

    it( 'still handles messages without a connection (session-agnostic)', async () => 
    {
        const server = new MCPServer();
        const res = await server.handleMessage( { jsonrpc : '2.0', id : 1, method : 'tools/list' } );

        expect( res?.result ).toEqual( { tools : [] } );
    } );

    it( 'round-trips a real client against the server and exposes version info', async () => 
    {
        const server = new MCPServer( { name : 'srv', version : '3.0.0' } );
        const [ clientT, serverT ] = InMemoryTransport.createPair();
        await server.connect( serverT );

        const client = new MCPClient( clientT );
        await client.connect();

        expect( client.negotiatedVersion ).toBe( LATEST_PROTOCOL_VERSION );
        expect( client.serverInfo ).toEqual( { name : 'srv', version : '3.0.0' } );
        await expect( client.ping() ).resolves.toBeUndefined();
    } );
} );
