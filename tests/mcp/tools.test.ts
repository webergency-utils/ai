import { describe, it, expect } from 'vitest';
import { MCPClient, InMemoryTransport } from '../../src/mcp/client.js';
import { MCPServer } from '../../src/mcp/server.js';
import { createMCPTools, mcpResultToText } from '../../src/mcp/tools.js';
import { Agent } from '../../src/agent/index.js';
import { AIError } from '../../src/core/error.js';
import { schema } from '../../src/core/index.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelRequest, ModelResponse } from '../../src/core/types.js';
import type { Span } from '../../src/trace/types.js';

async function connect( configure: ( server: MCPServer ) => void ): Promise<MCPClient>
{
    const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
    const server = new MCPServer( { name : 'test', version : '1.0.0' } );

    configure( server );

    await server.connect( serverTransport );

    const client = new MCPClient( clientTransport );
    await client.connect();

    return client;
}

function registerAdd( server: MCPServer ): void
{
    server.registerTool( 
        {
            name        : 'add',
            description : 'Adds two numbers',
            parameters  : schema.object( { a : schema.number(), b : schema.number() } )
        },
        async ( args ) => {return String( ( args.a as number ) + ( args.b as number ) );}
    );
}

function registerEcho( server: MCPServer, name: string ): void
{
    server.registerTool( 
        { name, description : name, parameters : schema.object( {} ) },
        async () => {return name;}
    );
}

function findSpan( span: Span, name: string ): Span | undefined
{
    if( span.name === name )
    {
        return span;
    }

    for( const child of span.children )
    {
        const found = findSpan( child, name );

        if( found )
        {
            return found;
        }
    }

    return undefined;
}

describe( 'createMCPTools (U5)', () => 
{
    it( 'binds server tools as executable agent tools (AE8, R19)', async () => 
    {
        const client = await connect( registerAdd );
        const tools = await createMCPTools( client );

        expect( tools ).toHaveLength( 1 );
        expect( tools[ 0 ]!.name ).toBe( 'add' );
        expect( tools[ 0 ]!.description ).toBe( 'Adds two numbers' );
        expect( await tools[ 0 ]!.run( { a : 2, b : 3 } ) ).toBe( '5' );

        await client.close();
    } );

    it( 'applies prefix while calling the server-side name (R20)', async () => 
    {
        const client = await connect( registerAdd );
        const [ tool ] = await createMCPTools( client, { prefix : 'math_' } );

        expect( tool!.name ).toBe( 'math_add' );
        expect( await tool!.run( { a : 1, b : 1 } ) ).toBe( '2' );

        await client.close();
    } );

    it( 'filters with include / exclude arrays and RegExps (R20)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            registerEcho( server, 'read_file' );
            registerEcho( server, 'write_file' );
            registerEcho( server, 'delete_file' );
        } );

        const included = await createMCPTools( client, { include : [ 'read_file', 'write_file' ] } );
        expect( included.map( ( t ) => {return t.name;} ) ).toEqual( [ 'read_file', 'write_file' ] );

        const regex = await createMCPTools( client, { include : /_file$/, exclude : /^delete_/ } );
        expect( regex.map( ( t ) => {return t.name;} ) ).toEqual( [ 'read_file', 'write_file' ] );

        const excluded = await createMCPTools( client, { exclude : [ 'delete_file' ] } );
        expect( excluded ).toHaveLength( 2 );

        const global = await createMCPTools( client, { include : /file/g } );
        expect( global ).toHaveLength( 3 );

        await client.close();
    } );

    it( 'throws on duplicate resulting names before returning (R20)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            registerEcho( server, 'a_b' );
            registerEcho( server, 'b' );
        } );

        // Both map to the same name only when prefix collides: force with a duplicated listing.
        const original = client.listTools.bind( client );
        client.listTools = async () => 
        {
            const tools = await original();

            return [ ...tools, tools[ 0 ]! ];
        };

        await expect( createMCPTools( client ) ).rejects.toMatchObject( { code : 'MCP_DUPLICATE_TOOL' } );

        await client.close();
    } );

    it( 'throws at bind time for schemas the validator cannot compile (R22)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            server.registerTool( 
                { 
                    name        : 'weird', 
                    description : 'bad schema', 
                    parameters  : { type : 'object', properties : { a : { type : 'weird' } } } 
                },
                async () => {return 'x';}
            );
        } );

        await expect( createMCPTools( client ) ).rejects.toMatchObject( { code : 'MCP_UNSUPPORTED_SCHEMA' } );
        await expect( createMCPTools( client ) ).rejects.toThrow( /weird/ );

        await client.close();
    } );

    it( 'uses the server input schema verbatim (R22)', async () => 
    {
        const client = await connect( registerAdd );
        const listed = await client.listTools();
        const [ tool ] = await createMCPTools( client );

        expect( tool!.parameters ).toEqual( listed[ 0 ]!.inputSchema );

        await client.close();
    } );

    it( 'validates arguments before calling the server', async () => 
    {
        const client = await connect( registerAdd );
        const [ tool ] = await createMCPTools( client );

        await expect( tool!.run( { a : 'x', b : 1 } ) ).rejects.toThrow( /Invalid arguments/ );

        await client.close();
    } );

    it( 'throws when the server reports isError (R21)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            server.registerTool( 
                { name : 'boom', description : 'fails', parameters : schema.object( {} ) },
                async () => {throw new Error( 'kaput' );}
            );
        } );

        const [ tool ] = await createMCPTools( client );

        await expect( tool!.run( {} ) ).rejects.toMatchObject( { code : 'MCP_TOOL_ERROR' } );
        await expect( tool!.run( {} ) ).rejects.toThrow( /kaput/ );

        await client.close();
    } );

    it( 'joins multiple text items with newlines (R21)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            server.registerTool( 
                { name : 'multi', description : 'multi', parameters : schema.object( {} ) },
                async () => {return { content : [ { type : 'text', text : 'one' }, { type : 'text', text : 'two' } ] };}
            );
        } );

        const [ tool ] = await createMCPTools( client );

        expect( await tool!.run( {} ) ).toBe( 'one\ntwo' );

        await client.close();
    } );

    it( 'throws MCP_UNSUPPORTED_CONTENT naming non-text types instead of dropping them (AE8, R21)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            server.registerTool( 
                { name : 'shot', description : 'screenshot', parameters : schema.object( {} ) },
                async () => {return { content : [ { type : 'text', text : 'caption' }, { type : 'image', data : 'AAAA', mimeType : 'image/png' } ] };}
            );
        } );

        const [ tool ] = await createMCPTools( client );
        const error = await tool!.run( {} ).catch( ( err: unknown ) => {return err;} );

        expect( error ).toBeInstanceOf( AIError );
        expect( ( error as AIError ).code ).toBe( 'MCP_UNSUPPORTED_CONTENT' );
        expect( ( error as AIError ).message ).toContain( 'image' );

        await client.close();
    } );

    it( 'rejects malformed text items and returns empty text for empty content', () => 
    {
        expect( () => {return mcpResultToText( 't', { content : [ { type : 'text' } ] } );} )
            .toThrow( /without text/ );
        expect( mcpResultToText( 't', { content : [] } ) ).toBe( '' );
        expect( () => {return mcpResultToText( 't', { content : [], isError : true } );} )
            .toThrow( /no error detail/ );
    } );

    it( 'runs end-to-end inside an agent and nests MCP spans under the tool span (AE8)', async () => 
    {
        const client = await connect( registerAdd );
        const tools = await createMCPTools( client );
        const requests: ModelRequest[] = [];
        let calls = 0;

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate( request: ModelRequest ): Promise<ModelResponse>
            {
                requests.push( { ...request, messages : [ ...request.messages ] } );
                calls++;

                if( calls === 1 )
                {
                    return {
                        role         : 'assistant',
                        content      : '',
                        finishReason : 'tool_calls',
                        toolCalls    : [ { id : 'c1', name : 'add', arguments : { a : 40, b : 2 } } ],
                        raw          : {}
                    };
                }

                return { role : 'assistant', content : 'done', finishReason : 'stop', raw : {} };
            },
            async* stream(){ yield* []; }
        };

        const agent = new Agent( { model, tools } );
        const result = await agent.run( 'add' );

        const toolMessage = requests[ 1 ]!.messages.find( ( m ) => {return m.role === 'tool';} );
        expect( toolMessage?.content ).toBe( '42' );

        const toolSpan = findSpan( result.span!, 'tool:run:add' );
        expect( toolSpan ).toBeDefined();
        expect( toolSpan!.children.map( ( c ) => {return c.name;} ) ).toContain( 'mcp:call:add' );

        await client.close();
    } );

    it( 'surfaces MCP tool errors to the model as Error strings through the agent (R21)', async () => 
    {
        const client = await connect( ( server ) => 
        {
            server.registerTool( 
                { name : 'boom', description : 'fails', parameters : schema.object( {} ) },
                async () => {throw new Error( 'kaput' );}
            );
        } );
        const tools = await createMCPTools( client );
        const seen: string[] = [];
        let calls = 0;

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate( request: ModelRequest ): Promise<ModelResponse>
            {
                calls++;

                if( calls === 1 )
                {
                    return {
                        role         : 'assistant',
                        content      : '',
                        finishReason : 'tool_calls',
                        toolCalls    : [ { id : 'c1', name : 'boom', arguments : {} } ],
                        raw          : {}
                    };
                }

                seen.push( ...request.messages.filter( ( m ) => {return m.role === 'tool';} ).map( ( m ) => {return m.content as string;} ) );

                return { role : 'assistant', content : 'ok', finishReason : 'stop', raw : {} };
            },
            async* stream(){ yield* []; }
        };

        await new Agent( { model, tools } ).run( 'go' );

        expect( seen[ 0 ] ).toMatch( /^Error: AIError: MCP tool 'boom' failed: .*kaput/ );

        await client.close();
    } );
} );
