import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import 
{
    MCPClient,
    MCPServer,
    InMemoryTransport
} from '../../src/mcp/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';

describe( 'Metered MCP Client & Server', () => 
{
    it( 'should report network transport and mcp invocation spend via ExecutionContext (R5, R6)', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const server = new MCPServer();

        server.registerTool( {
            name        : 'fetch_weather',
            description : 'Fetch current weather',
            parameters  : z.object( {
                city : z.string()
            } )
        }, async ( args ) => 
        {
            return {
                temperature : 22,
                city        : args.city
            };
        } );

        const client = new MCPClient( clientTransport );
        await server.connect( serverTransport );
        await client.connect();

        const tracker = new SpendTracker();
        const context = new SimpleExecutionContext( {
            tracker,
            threadId : 'test-thread-mcp'
        } );

        const result = await client.callTool( 'fetch_weather', { city : 'Prague' }, { context } );

        expect( result.isError ).toBe( false );
        expect( result.content[ 0 ].text ).toContain( 'Prague' );

        // Should have recorded both network transport bytes and mcp call
        expect( tracker.getCategorySpend( 'network' ) ).toBeGreaterThan( 0 );
        expect( tracker.getCategorySpend( 'mcp' ) ).toBeGreaterThan( 0 );
        expect( tracker.categoryRecords ).toHaveLength( 2 );

        const netRecord = tracker.categoryRecords.find( ( r ) => {return r.category === 'network';} );
        const mcpRecord = tracker.categoryRecords.find( ( r ) => {return r.category === 'mcp';} );

        expect( netRecord ).toBeDefined();
        expect( netRecord!.subcategory ).toBe( 'mcp_transport' );
        expect( netRecord!.units ).toBeGreaterThan( 0 );
        expect( netRecord!.threadId ).toBe( 'test-thread-mcp' );

        expect( mcpRecord ).toBeDefined();
        expect( mcpRecord!.subcategory ).toBe( 'fetch_weather' );
        expect( mcpRecord!.units ).toBe( 1 );
        expect( mcpRecord!.threadId ).toBe( 'test-thread-mcp' );

        await client.close();
        await serverTransport.close();
    } );

    it( 'should meter automatically when client has default SpendTracker configured', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const server = new MCPServer();

        server.registerTool( {
            name        : 'ping',
            description : 'Ping tool',
            parameters  : z.object( {} )
        }, async () => 
        {
            return 'pong';
        } );

        const tracker = new SpendTracker();
        const client = new MCPClient( clientTransport, { tracker } );

        await server.connect( serverTransport );
        await client.connect();

        const result = await client.callTool( 'ping', {} );

        expect( result.content[ 0 ].text ).toBe( 'pong' );
        expect( tracker.getCategorySpend( 'mcp' ) ).toBeGreaterThan( 0 );
        expect( tracker.getCategorySpend( 'network' ) ).toBeGreaterThan( 0 );

        await client.close();
        await serverTransport.close();
    } );

    it( 'should allow MCPServer tool handler to receive ExecutionContext', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const server = new MCPServer();
        const tracker = new SpendTracker();

        server.registerTool( {
            name        : 'compute_task',
            description : 'Heavy compute task',
            parameters  : z.object( { n : z.number() } )
        }, async ( args, ctx ) => 
        {
            if( ctx )
            {
                ctx.reportSpend( {
                    category    : 'compute',
                    subcategory : 'sandbox_sec',
                    units       : 2,
                    unitType    : 'seconds'
                } );
            }

            return Number( args.n ) * 2;
        } );

        const context = new SimpleExecutionContext( { tracker } );

        // Direct call to handleMessage with context
        const response = await server.handleMessage( {
            jsonrpc : '2.0',
            id      : 1,
            method  : 'tools/call',
            params  : {
                name      : 'compute_task',
                arguments : { n : 21 }
            }
        }, context );

        expect( response?.result ).toBeDefined();
        expect( tracker.getCategorySpend( 'compute' ) ).toBeGreaterThan( 0 );
    } );
} );
