import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { 
    MCPServer, 
    MCPClient, 
    InMemoryTransport 
} from '../../src/mcp/index.js';
import type { ToolDefinition } from '../../src/core/types.js';

describe( 'Model Context Protocol (MCP) Client & Server', () => 
{
    it( 'should complete handshake, discover tools, and call tools over transport', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();

        const server = new MCPServer( { name : 'test-server', version : '1.0.0' } );
        const client = new MCPClient( clientTransport );

        const addTool: ToolDefinition = 
            {
                name        : 'add',
                description : 'Add two numbers',
                parameters  : z.object( 
                    {
                        a : z.number().describe( 'First number' ),
                        b : z.number().describe( 'Second number' )
                    } )
            };

        server.registerTool( addTool, async ( args ) => 
        {
            const a = args.a as number;
            const b = args.b as number;

            return a + b;
        } );

        await server.connect( serverTransport );
        await client.connect();

        // Discover tools
        const tools = await client.listTools();
        expect( tools ).toHaveLength( 1 );
        expect( tools[0].name ).toBe( 'add' );
        expect( tools[0].description ).toBe( 'Add two numbers' );
        expect( tools[0].inputSchema ).toEqual( expect.objectContaining( {
            type       : 'object',
            properties : expect.objectContaining( {
                a : { type : 'number', description : 'First number' },
                b : { type : 'number', description : 'Second number' }
            } )
        } ) );

        // Convert to ToolDefinition
        const toolDefs = await client.toToolDefinitions();
        expect( toolDefs ).toHaveLength( 1 );
        expect( toolDefs[0].name ).toBe( 'add' );

        // Call tool
        const result = await client.callTool( 'add', { a : 15, b : 27 } );
        expect( result.isError ).toBe( false );
        expect( result.content ).toEqual( [ { type : 'text', text : '42' } ] );

        await client.close();
    } );

    it( 'should handle tool errors gracefully and return isError true', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const server = new MCPServer();
        const client = new MCPClient( clientTransport );

        server.registerTool( 
            {
                name        : 'failing_tool',
                description : 'A tool that throws',
                parameters  : { type : 'object', properties : {} }
            }, 
            async () => 
            {
                throw new Error( 'Database connection failed' );
            } );

        await server.connect( serverTransport );
        await client.connect();

        const res = await client.callTool( 'failing_tool', {} );
        expect( res.isError ).toBe( true );
        expect( res.content[0].text ).toContain( 'Database connection failed' );

        await client.close();
    } );

    it( 'should reject when calling non-existent tool', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const server = new MCPServer();
        const client = new MCPClient( clientTransport );

        await server.connect( serverTransport );
        await client.connect();

        await expect( client.callTool( 'ghost_tool', {} ) )
            .rejects
            .toThrow( /Tool 'ghost_tool' not found/ );

        await client.close();
    } );
} );
