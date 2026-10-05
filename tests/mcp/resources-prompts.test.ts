import { describe, it, expect } from 'vitest';
import 
{
    MCPClient,
    MCPServer,
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION
} from '../../src/mcp/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { compileUriTemplate } from '../../src/mcp/uri-template.js';
import { validateResourceContents } from '../../src/mcp/resource-content.js';
import type { JSONRPCRequest, JSONRPCResponse } from '../../src/mcp/types.js';

async function pair( server: MCPServer ): Promise<MCPClient>
{
    const [ clientT, serverT ] = InMemoryTransport.createPair();
    await server.connect( serverT );
    const client = new MCPClient( clientT );
    await client.connect();

    return client;
}

async function rpc( server: MCPServer, method: string, params?: Record<string, unknown> ): Promise<JSONRPCResponse>
{
    const res = await server.handleMessage( { jsonrpc : '2.0', id : 1, method, params } as JSONRPCRequest );

    return res!;
}

function fullServer(): MCPServer
{
    const server = new MCPServer( { name : 'rp', version : '1' } );

    server.registerResource( 
        { uri : 'file:///readme.md', name : 'readme', description : 'The readme', mimeType : 'text/markdown' }, 
        async () => {return '# hello';} 
    );
    server.registerResourceTemplate( 
        { uriTemplate : 'user://{org}/{id}', name : 'user', mimeType : 'application/json' }, 
        async ( _uri, vars ) => {return JSON.stringify( vars );} 
    );
    server.registerPrompt( 
        { name : 'greet', description : 'Greets', arguments : [ { name : 'who', required : true }, { name : 'tone' } ] }, 
        async ( args ) => 
        {
            return { 
                description : 'greeting', 
                messages    : [ { role : 'user', content : { type : 'text', text : `Hello ${args.who}${args.tone ? ` (${args.tone})` : ''}` } } ] 
            };
        } 
    );

    return server;
}

describe( 'resources and prompts round trip (AE10, R14, R14a)', () => 
{
    it( 'advertises capabilities only for registered kinds', async () => 
    {
        const none = await pair( new MCPServer() );
        expect( none.serverCapabilities ).toEqual( { tools : {} } );

        const onlyResources = new MCPServer();
        onlyResources.registerResource( { uri : 'a://b', name : 'b' }, () => {return 'x';} );
        expect( ( await pair( onlyResources ) ).serverCapabilities ).toEqual( { tools : {}, resources : {} } );

        const onlyTemplates = new MCPServer();
        onlyTemplates.registerResourceTemplate( { uriTemplate : 'a://{b}', name : 'b' }, () => {return 'x';} );
        expect( ( await pair( onlyTemplates ) ).serverCapabilities ).toEqual( { tools : {}, resources : {} } );

        const onlyPrompts = new MCPServer();
        onlyPrompts.registerPrompt( { name : 'p' }, () => {return [];} );
        expect( ( await pair( onlyPrompts ) ).serverCapabilities ).toEqual( { tools : {}, prompts : {} } );

        expect( ( await pair( fullServer() ) ).serverCapabilities ).toEqual( { tools : {}, resources : {}, prompts : {} } );
    } );

    it( 'lists, reads and gets over InMemoryTransport', async () => 
    {
        const client = await pair( fullServer() );

        expect( await client.listResources() ).toEqual( [ 
            { uri : 'file:///readme.md', name : 'readme', description : 'The readme', mimeType : 'text/markdown' } 
        ] );
        expect( await client.listResourceTemplates() ).toEqual( [ 
            { uriTemplate : 'user://{org}/{id}', name : 'user', mimeType : 'application/json' } 
        ] );
        expect( await client.readResource( 'file:///readme.md' ) ).toEqual( [ 
            { uri : 'file:///readme.md', mimeType : 'text/markdown', text : '# hello' } 
        ] );
        expect( await client.listPrompts() ).toEqual( [ 
            { name : 'greet', description : 'Greets', arguments : [ { name : 'who', required : true }, { name : 'tone' } ] } 
        ] );

        const prompt = await client.getPrompt( 'greet', { who : 'Ada', tone : 'warm' } );
        expect( prompt.description ).toBe( 'greeting' );
        expect( prompt.messages ).toEqual( [ { role : 'user', content : { type : 'text', text : 'Hello Ada (warm)' } } ] );
    } );

    it( 'AE10: reading an unknown URI yields -32602 (client sees MCP_CLIENT_ERROR with the code)', async () => 
    {
        const server = fullServer();

        const raw = await rpc( server, 'resources/read', { uri : 'file:///missing' } );
        expect( raw.error ).toMatchObject( { code : -32602, data : { uri : 'file:///missing' } } );

        const client = await pair( server );
        await expect( client.readResource( 'file:///missing' ) ).rejects.toMatchObject( { code : 'MCP_CLIENT_ERROR', details : { code : -32602 } } );
    } );

    it( 'reads through a template, percent-decoding variables, and prefers fixed resources', async () => 
    {
        const server = fullServer();
        server.registerResource( { uri : 'user://acme/special', name : 'special' }, () => {return 'fixed';} );
        const client = await pair( server );

        const [ templated ] = await client.readResource( 'user://acme%20inc/42' );
        expect( templated ).toEqual( { uri : 'user://acme%20inc/42', mimeType : 'application/json', text : '{"org":"acme inc","id":"42"}' } );

        const [ fixed ] = await client.readResource( 'user://acme/special' );
        expect( fixed.text ).toBe( 'fixed' );
    } );

    it.each( [
        [ 'too many segments', 'user://a/b/c' ],
        [ 'a reserved character in a variable', 'user://a/b?x=1' ],
        [ 'invalid UTF-8 escapes', 'user://a/%FF' ],
        [ 'a different scheme', 'other://a/b' ]
    ] )( 'does not match a template for %s', async ( _label, uri ) => 
    {
        const res = await rpc( fullServer(), 'resources/read', { uri } );

        expect( res.error?.code ).toBe( -32602 );
    } );

    it( 'returns multiple and binary contents with per-item overrides', async () => 
    {
        const server = new MCPServer();
        server.registerResource( { uri : 'bin://x', name : 'x', mimeType : 'text/plain' }, () => 
        {
            return [ { text : 'a' }, { blob : 'AAEC', mimeType : 'application/octet-stream', uri : 'bin://x#part2' } ];
        } );
        const client = await pair( server );

        expect( await client.readResource( 'bin://x' ) ).toEqual( [
            { uri : 'bin://x', mimeType : 'text/plain', text : 'a' },
            { uri : 'bin://x#part2', mimeType : 'application/octet-stream', blob : 'AAEC' }
        ] );
    } );

    it( 'omits mimeType when neither the content nor the resource declares one', async () => 
    {
        const server = new MCPServer();
        server.registerResource( { uri : 'n://x', name : 'x' }, () => {return { text : 't' };} );

        expect( ( await rpc( server, 'resources/read', { uri : 'n://x' } ) ).result ).toEqual( { contents : [ { uri : 'n://x', text : 't' } ] } );
    } );

    it( 'rejects resources/read without a string uri with -32602', async () => 
    {
        expect( ( await rpc( fullServer(), 'resources/read', {} ) ).error?.code ).toBe( -32602 );
        expect( ( await rpc( fullServer(), 'resources/read', { uri : 5 } ) ).error?.code ).toBe( -32602 );
    } );

    it( 'follows nextCursor for resource and prompt lists on the client', async () => 
    {
        const [ clientT, serverT ] = InMemoryTransport.createPair();
        await serverT.connect();
        serverT.onMessage( async ( m ) => 
        {
            if( !( 'method' in m ) || !( 'id' in m ) )
            {
                return;
            }

            const req = m as JSONRPCRequest;
            const page2 = req.params?.cursor === 'p2';
            const results: Record<string, unknown> = {
                initialize                 : { protocolVersion : LATEST_PROTOCOL_VERSION, capabilities : { resources : {}, prompts : {} } },
                'resources/list'           : page2 ? { resources : [ { uri : 'b://2', name : '2' } ] } : { resources : [ { uri : 'a://1', name : '1' } ], nextCursor : 'p2' },
                'resources/templates/list' : page2 ? { resourceTemplates : [ { uriTemplate : 'b://{x}', name : 't2' } ] } : { resourceTemplates : [ { uriTemplate : 'a://{x}', name : 't1' } ], nextCursor : 'p2' },
                'prompts/list'             : page2 ? { prompts : [ { name : 'two' } ] } : { prompts : [ { name : 'one' } ], nextCursor : 'p2' }
            };

            await serverT.send( { jsonrpc : '2.0', id : req.id, result : results[req.method] } as JSONRPCResponse );
        } );
        const client = new MCPClient( clientT );
        await client.connect();

        expect( ( await client.listResources() ).map( ( r ) => {return r.name;} ) ).toEqual( [ '1', '2' ] );
        expect( ( await client.listResourceTemplates() ).map( ( r ) => {return r.name;} ) ).toEqual( [ 't1', 't2' ] );
        expect( ( await client.listPrompts() ).map( ( r ) => {return r.name;} ) ).toEqual( [ 'one', 'two' ] );
    } );
} );

describe( 'capability absence (R3, R14)', () => 
{
    it( 'server answers -32601 for resources/* and prompts/* when none are registered', async () => 
    {
        const server = new MCPServer();

        for( const method of [ 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get' ] )
        {
            expect( ( await rpc( server, method, {} ) ).error?.code, method ).toBe( -32601 );
        }
    } );

    it( 'server with only prompts rejects resources/* with -32601 and vice versa', async () => 
    {
        const prompts = new MCPServer();
        prompts.registerPrompt( { name : 'p' }, () => {return [];} );
        expect( ( await rpc( prompts, 'resources/list' ) ).error?.code ).toBe( -32601 );

        const resources = new MCPServer();
        resources.registerResource( { uri : 'a://b', name : 'b' }, () => {return 'x';} );
        expect( ( await rpc( resources, 'prompts/list' ) ).error?.code ).toBe( -32601 );
    } );

    it( 'client throws MCP_CAPABILITY_MISSING against a tools-only MCPServer', async () => 
    {
        const client = await pair( new MCPServer() );

        await expect( client.listResources() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );
        await expect( client.listPrompts() ).rejects.toMatchObject( { code : 'MCP_CAPABILITY_MISSING' } );
    } );

    it( 'unknown resources/ and prompts/ methods still return -32601 on a capable server', async () => 
    {
        expect( ( await rpc( fullServer(), 'resources/subscribe', { uri : 'x' } ) ).error?.code ).toBe( -32601 );
        expect( ( await rpc( fullServer(), 'prompts/other' ) ).error?.code ).toBe( -32601 );
    } );
} );

describe( 'content validation (R14b)', () => 
{
    it( 'server rejects a reader returning both text and blob, or neither, with -32603', async () => 
    {
        const server = new MCPServer();
        server.registerResource( { uri : 'bad://both', name : 'both' }, () => {return { text : 'a', blob : 'b' };} );
        server.registerResource( { uri : 'bad://none', name : 'none' }, () => {return {};} );
        server.registerResource( { uri : 'bad://throws', name : 'throws' }, () => {throw new Error( 'disk gone' );} );

        const both = await rpc( server, 'resources/read', { uri : 'bad://both' } );
        const none = await rpc( server, 'resources/read', { uri : 'bad://none' } );
        const throws = await rpc( server, 'resources/read', { uri : 'bad://throws' } );

        expect( both.error ).toMatchObject( { code : -32603, message : expect.stringContaining( 'both' ) } );
        expect( none.error ).toMatchObject( { code : -32603, message : expect.stringContaining( 'neither' ) } );
        expect( throws.error ).toMatchObject( { code : -32603, message : expect.stringContaining( 'disk gone' ) } );
    } );

    it.each( [
        [ 'not an array', 'nope', /must be an array/ ],
        [ 'a non-object item', [ 5 ], /must be an object/ ],
        [ 'a missing uri', [ { text : 'a' } ], /missing 'uri'/ ],
        [ 'both text and blob', [ { uri : 'a://b', text : 'a', blob : 'b' } ], /both/ ],
        [ 'neither text nor blob', [ { uri : 'a://b' } ], /neither/ ],
        [ 'a non-string text', [ { uri : 'a://b', text : 5 } ], /text must be a string/ ],
        [ 'a non-string blob', [ { uri : 'a://b', blob : 5 } ], /blob must be a base64 string/ ],
        [ 'a non-string mimeType', [ { uri : 'a://b', text : 'a', mimeType : 5 } ], /mimeType must be a string/ ]
    ] )( 'validateResourceContents rejects %s', ( _label, contents, message ) => 
    {
        expect( () => {return validateResourceContents( contents, 'test' );} ).toThrow( message );

        try
        {
            validateResourceContents( contents, 'test' );
        }
        catch( error: unknown )
        {
            expect( ( error as { code: string } ).code ).toBe( 'MCP_INVALID_RESOURCE_CONTENT' );
        }
    } );

    it( 'client rejects invalid contents sent by a misbehaving server', async () => 
    {
        const [ clientT, serverT ] = InMemoryTransport.createPair();
        await serverT.connect();
        serverT.onMessage( async ( m ) => 
        {
            if( !( 'method' in m ) || !( 'id' in m ) )
            {
                return;
            }

            const req = m as JSONRPCRequest;
            const result = req.method === 'initialize'
                ? { protocolVersion : LATEST_PROTOCOL_VERSION, capabilities : { resources : {}, prompts : {} } }
                : req.method === 'resources/read'
                    ? { contents : [ { uri : 'a://b', text : 'x', blob : 'y' } ] }
                    : { description : 'no messages' };

            await serverT.send( { jsonrpc : '2.0', id : req.id, result } as JSONRPCResponse );
        } );
        const client = new MCPClient( clientT );
        await client.connect();

        await expect( client.readResource( 'a://b' ) ).rejects.toMatchObject( { code : 'MCP_INVALID_RESOURCE_CONTENT' } );
        await expect( client.getPrompt( 'p' ) ).rejects.toMatchObject( { code : 'MCP_PROTOCOL_ERROR' } );
    } );

    it( 'round-trips resource_link content and structuredContent from a tool', async () => 
    {
        const server = new MCPServer();
        server.registerTool( { name : 'find', description : 'd', parameters : { type : 'object', properties : {} } }, async () => 
        {
            return { 
                content : [ 
                    { type : 'resource_link', uri : 'file:///a.txt', name : 'a', mimeType : 'text/plain', annotations : { priority : 1 } },
                    { type : 'resource', resource : { uri : 'file:///b.txt', text : 'b' } }
                ], 
                structuredContent : { count : 2 } 
            };
        } );
        const client = await pair( server );

        const result = await client.callTool( 'find' );

        expect( result.structuredContent ).toEqual( { count : 2 } );
        expect( result.content[0] ).toEqual( { type : 'resource_link', uri : 'file:///a.txt', name : 'a', mimeType : 'text/plain', annotations : { priority : 1 } } );
        expect( result.content[1].resource ).toEqual( { uri : 'file:///b.txt', text : 'b' } );
    } );

    it( 'does not invent structuredContent for plain tool results', async () => 
    {
        const server = new MCPServer();
        server.registerTool( { name : 'plain', description : 'd', parameters : { type : 'object', properties : {} } }, async () => {return 'x';} );

        const client = await pair( server );
        expect( ( await client.callTool( 'plain' ) ).structuredContent ).toBeUndefined();
    } );
} );

describe( 'prompt handling (R14)', () => 
{
    it( 'rejects a missing required argument with -32602 naming it', async () => 
    {
        const res = await rpc( fullServer(), 'prompts/get', { name : 'greet', arguments : {} } );

        expect( res.error ).toMatchObject( { code : -32602, message : expect.stringContaining( 'who' ), data : { missing : [ 'who' ] } } );
    } );

    it( 'treats omitted arguments as empty (and still enforces required ones)', async () => 
    {
        expect( ( await rpc( fullServer(), 'prompts/get', { name : 'greet' } ) ).error?.code ).toBe( -32602 );

        const server = new MCPServer();
        server.registerPrompt( { name : 'static' }, () => {return [ { role : 'assistant', content : { type : 'text', text : 'hi' } } ];} );
        expect( ( await rpc( server, 'prompts/get', { name : 'static' } ) ).result ).toEqual( { messages : [ { role : 'assistant', content : { type : 'text', text : 'hi' } } ] } );
    } );

    it.each( [
        [ 'an unknown prompt', { name : 'nope' } ],
        [ 'a missing name', {} ],
        [ 'an undeclared argument', { name : 'greet', arguments : { who : 'a', extra : 'b' } } ],
        [ 'a non-string argument', { name : 'greet', arguments : { who : 5 } } ],
        [ 'array arguments', { name : 'greet', arguments : [ 'who' ] } ]
    ] )( 'rejects %s with -32602', async ( _label, params ) => 
    {
        expect( ( await rpc( fullServer(), 'prompts/get', params ) ).error?.code ).toBe( -32602 );
    } );

    it.each( [
        [ 'a non-message result', () => {return 'text' as never;} ],
        [ 'a bad role', () => {return [ { role : 'system', content : { type : 'text', text : 'x' } } ] as never;} ],
        [ 'a missing content', () => {return [ { role : 'user' } ] as never;} ],
        [ 'a throwing handler', () => {throw new Error( 'template broke' );} ]
    ] )( 'turns %s into a -32603 error, not a bogus success', async ( _label, handler ) => 
    {
        const server = new MCPServer();
        server.registerPrompt( { name : 'bad' }, handler );

        expect( ( await rpc( server, 'prompts/get', { name : 'bad' } ) ).error?.code ).toBe( -32603 );
    } );

    it( 'passes a tracker-backed context to resource and prompt handlers only when the server has a tracker', async () => 
    {
        for( const withTracker of [ false, true ] )
        {
            const seen: unknown[] = [];
            const server = new MCPServer( withTracker ? { tracker : new SpendTracker() } : {} );
            server.registerPrompt( { name : 'ctx' }, ( _args, context ) => 
            {
                seen.push( context );

                return [];
            } );
            server.registerResource( { uri : 'a://b', name : 'b' }, ( _uri, context ) => 
            {
                seen.push( context );

                return 'x';
            } );
            server.registerResourceTemplate( { uriTemplate : 'c://{x}', name : 't' }, ( _uri, _vars, context ) => 
            {
                seen.push( context );

                return 'x';
            } );

            await rpc( server, 'prompts/get', { name : 'ctx' } );
            await rpc( server, 'resources/read', { uri : 'a://b' } );
            await rpc( server, 'resources/read', { uri : 'c://1' } );

            expect( seen ).toHaveLength( 3 );
            expect( seen.every( ( c ) => {return withTracker ? c !== undefined : c === undefined;} ) ).toBe( true );
        }
    } );
} );

describe( 'registration validation (R14)', () => 
{
    it( 'rejects duplicates and malformed registrations loudly', () => 
    {
        const server = new MCPServer();
        server.registerResource( { uri : 'a://b', name : 'b' }, () => {return 'x';} );
        server.registerResourceTemplate( { uriTemplate : 'a://{x}', name : 't' }, () => {return 'x';} );
        server.registerPrompt( { name : 'p', arguments : [ { name : 'a' } ] }, () => {return [];} );

        expect( () => {server.registerResource( { uri : 'a://b', name : 'again' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'MCP_DUPLICATE_RESOURCE' } ) );
        expect( () => {server.registerResourceTemplate( { uriTemplate : 'a://{x}', name : 'again' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'MCP_DUPLICATE_RESOURCE' } ) );
        expect( () => {server.registerPrompt( { name : 'p' }, () => {return [];} );} ).toThrow( expect.objectContaining( { code : 'MCP_DUPLICATE_PROMPT' } ) );
        expect( () => {server.registerPrompt( { name : 'q', arguments : [ { name : 'a' }, { name : 'a' } ] }, () => {return [];} );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
        expect( () => {server.registerPrompt( { name : '' }, () => {return [];} );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
        expect( () => {server.registerResource( { uri : '', name : 'n' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
        expect( () => {server.registerResource( { uri : 'a://c', name : '' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
        expect( () => {server.registerResourceTemplate( { uriTemplate : 'a://{y}', name : '' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'INVALID_INPUT' } ) );
    } );

    it.each( [
        [ 'reserved expansion', 'file://{+path}' ],
        [ 'fragment expansion', 'x://a{#frag}' ],
        [ 'label expansion', 'x://a{.ext}' ],
        [ 'path expansion', 'x://a{/seg}' ],
        [ 'path-style expansion', 'x://a{;p}' ],
        [ 'query expansion', 'x://a{?q}' ],
        [ 'query continuation', 'x://a{&q}' ],
        [ 'explode modifier', 'x://a/{list*}' ],
        [ 'prefix modifier', 'x://a/{name:3}' ],
        [ 'variable lists', 'x://a/{a,b}' ],
        [ 'an empty expression', 'x://a/{}' ],
        [ 'an unterminated brace', 'x://a/{id' ],
        [ 'an unmatched closing brace', 'x://a/id}' ],
        [ 'adjacent variables', 'x://{a}{b}' ],
        [ 'a repeated variable', 'x://{a}/{a}' ],
        [ 'no variables', 'x://plain' ],
        [ 'an empty template', '' ]
    ] )( 'rejects %s in a template at registration', ( _label, template ) => 
    {
        const server = new MCPServer();

        expect( () => {server.registerResourceTemplate( { uriTemplate : template, name : 't' }, () => {return 'x';} );} ).toThrow( expect.objectContaining( { code : 'MCP_INVALID_URI_TEMPLATE' } ) );
        expect( () => {compileUriTemplate( template );} ).toThrow( expect.objectContaining( { code : 'MCP_INVALID_URI_TEMPLATE' } ) );
    } );

    it( 'rejects non-string templates', () => 
    {
        expect( () => {compileUriTemplate( undefined as unknown as string );} ).toThrow( expect.objectContaining( { code : 'MCP_INVALID_URI_TEMPLATE' } ) );
    } );

    it( 'compiles level-1 templates with literal regex metacharacters escaped', () => 
    {
        const compiled = compileUriTemplate( 'db://host.example/(a+b)/{id}/rows[{row}]' );

        expect( compiled.variables ).toEqual( [ 'id', 'row' ] );
        expect( compiled.match( 'db://host.example/(a+b)/7/rows[3]' ) ).toEqual( { id : '7', row : '3' } );
        expect( compiled.match( 'db://hostXexample/(a+b)/7/rows[3]' ) ).toBeUndefined();
        expect( compiled.match( 'db://host.example/aab/7/rows[3]' ) ).toBeUndefined();
    } );

    it( 'matching a hostile long input stays fast', () => 
    {
        const compiled = compileUriTemplate( 'x://{a}/{b}/{c}' );
        const started = Date.now();

        expect( compiled.match( `x://${'a'.repeat( 50_000 )}/${'b'.repeat( 50_000 )}` ) ).toBeUndefined();
        expect( Date.now() - started ).toBeLessThan( 1_000 );
    } );
} );
