import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MCPClient, InMemoryTransport } from '../../src/mcp/client.js';
import { MCPServer } from '../../src/mcp/server.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import { computeSpanRollup } from '../../src/trace/rollup.js';

describe( 'Cross-Boundary MCP Wire Propagation (U4)', () => 
{
    it( 'injects _meta on client, extracts on server, and grafts child spans (Acceptance Example AE2)', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();

        const server = new MCPServer( { name : 'test-analytics-server', version : '1.0.0' } );

        server.registerTool( 
            {
                name        : 'analyze',
                description : 'Performs analytics with subcall database and LLM queries',
                parameters  : z.object( {
                    query : z.string()
                } )
            },
            async ( args, ctx ) => 
            {
                // Verify server received an execution context
                expect( ctx ).toBeDefined();
                expect( ctx?.activeSpan ).toBeDefined();

                // Subcall 1: database query
                let dbResult = '';
                if( ctx?.withSpan )
                {
                    dbResult = await ctx.withSpan( 'storage:db_query', async ( dbSpan, dbCtx ) => 
                    {
                        dbSpan.setAttribute( 'db.query', args.query as string );
                        dbCtx.reportSpend( { category : 'storage', costUSD : 0.0002 } );
                        return 'db_rows';
                    }, { kind : 'storage' } );
                }

                // Subcall 2: secondary LLM summary
                let llmResult = '';
                if( ctx?.withSpan )
                {
                    llmResult = await ctx.withSpan( 'model:subcall_llm', async ( llmSpan, llmCtx ) => 
                    {
                        llmSpan.recordMetric( 'promptTokens', 150 );
                        llmSpan.recordMetric( 'completionTokens', 50 );
                        llmCtx.reportSpend( { category : 'model', costUSD : 0.004 } );
                        return 'summary_text';
                    }, { kind : 'model' } );
                }

                return {
                    db  : dbResult,
                    llm : llmResult
                };
            }
        );

        await server.connect( serverTransport );

        const client = new MCPClient( clientTransport );
        await client.connect();

        const rootCtx = new SimpleExecutionContext();

        await rootCtx.withSpan( 'agent:root', async ( rootSpan, ctx ) => 
        {
            const result = await client.callTool( 'analyze', { query : 'SELECT * FROM users' }, { context : ctx } );

            expect( result.isError ).toBe( false );
            expect( result._meta ).toBeDefined();
            expect( result._meta?.spans ).toBeDefined();
            expect( Array.isArray( result._meta?.spans ) ).toBe( true );

            // Client should have 1 child under root: mcp:call:analyze
            expect( rootSpan.children ).toHaveLength( 1 );
            const mcpSpan = rootSpan.children[0]!;
            expect( mcpSpan.name ).toBe( 'mcp:call:analyze' );
            expect( mcpSpan.kind ).toBe( 'mcp' );
            expect( mcpSpan.traceId ).toBe( rootSpan.traceId );

            // Under mcp:call:analyze, we should have the server's tool handler span
            expect( mcpSpan.children ).toHaveLength( 1 );
            const serverToolSpan = mcpSpan.children[0]!;
            expect( serverToolSpan.name ).toBe( 'tool:analyze' );
            expect( serverToolSpan.traceId ).toBe( rootSpan.traceId );
            expect( serverToolSpan.parentSpanId ).toBe( mcpSpan.id );

            // Under serverToolSpan, we should have the 2 subcalls: db_query and subcall_llm
            expect( serverToolSpan.children ).toHaveLength( 2 );
            const dbSpan = serverToolSpan.children.find( ( s ) => {return s.name === 'storage:db_query';} );
            const llmSpan = serverToolSpan.children.find( ( s ) => {return s.name === 'model:subcall_llm';} );

            expect( dbSpan ).toBeDefined();
            expect( dbSpan?.kind ).toBe( 'storage' );
            expect( dbSpan?.spendUSD ).toBe( 0.0002 );

            expect( llmSpan ).toBeDefined();
            expect( llmSpan?.kind ).toBe( 'model' );
            expect( llmSpan?.spendUSD ).toBe( 0.004 );
            expect( llmSpan?.metrics.promptTokens ).toBe( 150 );

            // Compute rollup across root
            const rollup = computeSpanRollup( rootSpan );
            expect( rollup.totalSpendUSD ).toBeCloseTo( 0.0042, 4 );
            expect( rollup.categorySpend.storage ).toBeCloseTo( 0.0002, 4 );
            expect( rollup.categorySpend.model ).toBeCloseTo( 0.004, 4 );
            expect( rollup.metrics.subcallCount ).toBe( 4 ); // mcp:call, tool:analyze, db_query, subcall_llm
        } );

        await client.close();
    } );

    it( 'remains backwards compatible with third-party servers that do not support _meta', async () => 
    {
        const [ clientTransport, thirdPartyTransport ] = InMemoryTransport.createPair();

        thirdPartyTransport.onMessage( async ( msg ) => 
        {
            if( 'id' in msg && msg.id !== undefined && 'method' in msg )
            {
                if( msg.method === 'initialize' )
                {
                    await thirdPartyTransport.send( {
                        jsonrpc : '2.0',
                        id      : msg.id,
                        result  : {
                            protocolVersion : '2024-11-05',
                            capabilities    : { tools : {} },
                            serverInfo      : { name : 'third-party-server', version : '1.0.0' }
                        }
                    } );
                }
                else if( msg.method === 'tools/call' )
                {
                    // Third-party server ignores _meta and does not return _meta in result
                    await thirdPartyTransport.send( {
                        jsonrpc : '2.0',
                        id      : msg.id,
                        result  : {
                            content : [ { type : 'text', text : '{"double":10}' } ],
                            isError : false
                        }
                    } );
                }
            }
        } );

        await thirdPartyTransport.connect();

        const client = new MCPClient( clientTransport );
        await client.connect();

        const ctx = new SimpleExecutionContext();

        await ctx.withSpan( 'parent', async ( parentSpan, callCtx ) => 
        {
            const res = await client.callTool( 'simple_tool', { x : 5 }, { context : callCtx } );
            expect( res.isError ).toBe( false );

            // mcp:call:simple_tool span exists and completed normally as a leaf span
            expect( parentSpan.children ).toHaveLength( 1 );
            const mcpSpan = parentSpan.children[0]!;
            expect( mcpSpan.name ).toBe( 'mcp:call:simple_tool' );
            expect( mcpSpan.status ).toBe( 'ok' );
            expect( mcpSpan.children ).toHaveLength( 0 );
        } );

        await client.close();
    } );
} );
