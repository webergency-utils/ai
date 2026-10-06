import { describe, it, expect, vi } from 'vitest';
import { schema } from '../../src/core/index.js';
import { Agent, createTool } from '../../src/agent/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { SpendTracker, UnitCostRegistry } from '../../src/spend/index.js';
import { MCPClient, MCPServer, InMemoryTransport } from '../../src/mcp/index.js';
import 
{
    TraceCollector,
    exportTraceToJSON,
    exportTraceToOTLP,
    type TraceEvent
} from '../../src/trace/index.js';
import type { ModelProtocol, ModelResponse } from '../../src/core/index.js';

describe( 'Hierarchical Tracing E2E Dashboard Flow (U7)', () => 
{
    it( 'executes complete multi-tier agent, tool, mcp, storage and llm waterfall (F1, F2, F3)', async () => 
    {
        // 1. Setup collector & real-time event listener (F2)
        const collector = new TraceCollector();
        const events: TraceEvent[] = [];
        const unsubscribe = collector.subscribe( ( event ) => 
        {
            events.push( event );
        } );

        // 2. Setup storage driver with pricing
        const pricing = new UnitCostRegistry();
        pricing.register( 'storage:doc_read', 0.0005 );
        pricing.register( 'storage:doc_write', 0.001 );

        const docStore = new MemoryDocStore( { storagePricing : pricing } );
        await docStore.set( 'intel', 'report_42', { title : 'Project Orion', status : 'classified' } );

        // 3. Setup MCP Server hosting a multi-step tool
        const server = new MCPServer( {
            name    : 'intel-server',
            version : '1.0.0'
        } );

        server.registerTool( 
            {
                name        : 'fetch_intel', 
                description : 'Fetches classified intel and executes secondary analysis', 
                parameters  : schema.object( { reportId : schema.string() } )
            }, 
            async ( args, context ) => 
            {
                const reportId = String( args.reportId );
                // Internal storage query with context
                const doc = await docStore.get( 'intel', reportId, { context } );

                // Secondary internal analysis span
                let analysis = '';
                if( context?.withSpan )
                {
                    analysis = await context.withSpan( 
                        'intel:secondary_analysis', 
                        async ( span ) => 
                        {
                            span.setAttribute( 'analysis.type', 'deep_scan' );
                            span.addMetrics( { promptTokens : 40, completionTokens : 10, totalTokens : 50 } );
                            span.recordSpend( {
                                category : 'model',
                                costUSD  : 0.002,
                                units    : 50,
                                unitType : 'tokens'
                            } );
                            span.recordSpend( {
                                category : 'compute',
                                costUSD  : 0.0008,
                                units    : 1,
                                unitType : 'operations'
                            } );
                            return `Analyzed report ${reportId}: ${JSON.stringify( doc )}`;
                        }, 
                        { kind : 'model' } 
                    );
                }

                return {
                    doc,
                    analysis
                };
            } 
        );

        // 4. Setup MCP Client connected via in-memory transport
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        await server.connect( serverTransport );

        const client = new MCPClient( clientTransport );
        await client.connect();

        // 5. Wrap MCP client in an Agent tool
        const intelTool = createTool( 
            {
                name        : 'get_intel_report',
                description : 'Calls remote MCP intel service',
                parameters  : schema.object( { reportId : schema.string() } ),
                execute     : async ( args, context ) => 
                {
                    const result = await client.callTool( 'fetch_intel', args, { context } );
                    return result;
                }
            } 
        );

        // 6. Setup SpendTracker and Agent with Mock Model
        const spendTracker = new SpendTracker();

        let turn = 0;
        const mockModel: ModelProtocol = 
            {
                provider : 'openai',
                model    : 'gpt-4o',
                generate : vi.fn( async (): Promise<ModelResponse> => 
                {
                    turn++;

                    if( turn === 1 )
                    {
                        return {
                            role         : 'assistant',
                            content      : 'Fetching intel report 42...',
                            finishReason : 'tool_calls',
                            toolCalls : 
                            [
                                {
                                    id        : 'call_1',
                                    name      : 'get_intel_report',
                                    arguments : { reportId : 'report_42' }
                                }
                            ],
                            usage : { promptTokens : 100, completionTokens : 25, totalTokens : 125 },
                            raw   : {}
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : 'Project Orion is classified and validated.',
                        finishReason : 'stop',
                        usage        : { promptTokens : 150, completionTokens : 30, totalTokens : 180 },
                        raw          : {}
                    };
                } ),
                stream : vi.fn()
            };

        const agent = new Agent( 
            {
                model        : mockModel,
                instructions : 'You are an intel analyst.',
                tools        : [ intelTool ],
                spendTracker,
                collector
            } 
        );

        // 7. Execute agent run (Flow F1)
        const result = await agent.run( 'Retrieve intel for report 42', {
            threadId : 'th-e2e-42',
            agentId  : 'agent-orion'
        } );

        expect( result.text ).toBe( 'Project Orion is classified and validated.' );
        expect( result.steps ).toBe( 2 );
        expect( result.traceId ).toBeDefined();

        // 8. Retrieve complete completed trace from collector
        const trace = collector.getTrace( result.traceId! );
        expect( trace ).toBeDefined();
        if( !trace )
        {
            throw new Error( 'Trace not found in collector' );
        }

        // Verify root span
        const root = trace.rootSpan;
        expect( root.name ).toBe( 'agent:run' );
        expect( root.kind ).toBe( 'agent' );
        expect( root.attributes[ 'agent.id' ] ).toBe( 'agent-orion' );
        expect( root.attributes[ 'agent.threadId' ] ).toBe( 'th-e2e-42' );

        // Verify multi-tier hierarchy:
        // agent:run -> [ agent:step:0, agent:step:1 ]
        expect( root.children.length ).toBe( 2 );

        const step0 = root.children[ 0 ];
        expect( step0.name ).toBe( 'agent:step:0' );

        // step0 -> [ model:generate, tool:run:get_intel_report ]
        expect( step0.children.length ).toBe( 2 );
        const model0 = step0.children[ 0 ];
        const tool0 = step0.children[ 1 ];

        expect( model0.name ).toBe( 'model:generate' );
        expect( tool0.name ).toBe( 'tool:run:get_intel_report' );

        // tool0 -> [ mcp:call:fetch_intel ]
        expect( tool0.children.length ).toBe( 1 );
        const mcpCall = tool0.children[ 0 ];
        expect( mcpCall.name ).toBe( 'mcp:call:fetch_intel' );
        expect( mcpCall.kind ).toBe( 'mcp' );

        // mcpCall -> [ tool:fetch_intel ] (grafted from server)
        expect( mcpCall.children.length ).toBe( 1 );
        const serverTool = mcpCall.children[ 0 ];
        expect( serverTool.name ).toBe( 'tool:fetch_intel' );

        // serverTool -> [ storage:doc:get, intel:secondary_analysis ]
        expect( serverTool.children.length ).toBe( 2 );
        const storageGet = serverTool.children[ 0 ];
        const secondaryAnalysis = serverTool.children[ 1 ];

        expect( storageGet.name ).toBe( 'storage:doc:get' );
        expect( storageGet.kind ).toBe( 'storage' );
        expect( storageGet.attributes[ 'storage.collection' ] ).toBe( 'intel' );
        expect( storageGet.attributes[ 'storage.id' ] ).toBe( 'report_42' );

        expect( secondaryAnalysis.name ).toBe( 'intel:secondary_analysis' );
        expect( secondaryAnalysis.kind ).toBe( 'model' );

        // step1 -> [ model:generate ]
        const step1 = root.children[ 1 ];
        expect( step1.name ).toBe( 'agent:step:1' );
        expect( step1.children.length ).toBe( 1 );
        expect( step1.children[ 0 ].name ).toBe( 'model:generate' );

        // 9. Verify Recursive Rollup (AE1, R11, R12)
        expect( root.rollup ).toBeDefined();
        const rollup = root.rollup!;

        expect( rollup.totalDurationMs ).toBeGreaterThan( 0 );
        expect( rollup.totalSpendUSD ).toBeGreaterThan( 0 );

        // Category breakdown should contain spend across multiple layers:
        // - model spend from step0 LLM, step1 LLM, and secondary_analysis ($0.002)
        // - storage spend from docStore.get ($0.0005)
        // - compute spend from secondary_analysis ($0.0008)
        expect( rollup.categorySpend.model ).toBeGreaterThan( 0.002 );
        expect( rollup.categorySpend.storage ).toBeCloseTo( 0.0005, 4 );
        expect( rollup.categorySpend.compute ).toBeCloseTo( 0.0008, 4 );

        // Metrics should aggregate token counts and subcalls
        expect( rollup.metrics.totalTokens ).toBeGreaterThanOrEqual( 125 + 180 + 50 );
        expect( rollup.metrics.subcallCount ).toBe( 9 ); // total descendant spans

        // 10. Verify Real-time Event Streaming (Flow F2, R13, R14)
        expect( events.length ).toBeGreaterThan( 10 );
        const startEvents = events.filter( ( e ) => e.type === 'span:start' );
        const endEvents = events.filter( ( e ) => e.type === 'span:end' );
        const traceEndEvents = events.filter( ( e ) => e.type === 'trace:end' );

        expect( startEvents.length ).toBeGreaterThanOrEqual( 6 );
        expect( endEvents.length ).toBeGreaterThanOrEqual( 6 );
        expect( traceEndEvents.length ).toBe( 1 );

        // First event should be root span start
        expect( startEvents[ 0 ].span.name ).toBe( 'agent:run' );

        // 11. Verify Exporters (Flow F3, AE3, R15)
        const jsonExport = exportTraceToJSON( trace, { pretty : true } );
        expect( jsonExport ).toContain( '"name": "agent:run"' );
        expect( jsonExport ).toContain( '"name": "intel:secondary_analysis"' );
        expect( jsonExport ).toContain( '"totalSpendUSD":' );

        const otlpExport = exportTraceToOTLP( trace, {
            serviceName    : 'ai-intel-dashboard',
            serviceVersion : '2.0.0'
        } );

        expect( otlpExport.resourceSpans ).toBeDefined();
        expect( otlpExport.resourceSpans ).toHaveLength( 1 );

        const resSpan = otlpExport.resourceSpans[ 0 ];
        expect( resSpan.resource.attributes ).toContainEqual( {
            key   : 'service.name',
            value : { stringValue : 'ai-intel-dashboard' }
        } );

        const scopeSpans = resSpan.scopeSpans[ 0 ];
        expect( scopeSpans.spans.length ).toBe( 10 ); // all 10 spans in flattened tree

        // All spans in OTLP must have matching 32-hex traceId
        for( const s of scopeSpans.spans )
        {
            expect( s.traceId ).toBe( trace.traceId );
            expect( s.spanId ).toMatch( /^[0-9a-f]{16}$/ );
            expect( typeof s.startTimeUnixNano ).toBe( 'string' );
            expect( typeof s.endTimeUnixNano ).toBe( 'string' );
        }

        // Verify root span has no parentSpanId, child spans have parentSpanId
        const otlpRoot = scopeSpans.spans.find( ( s ) => s.name === 'agent:run' );
        expect( otlpRoot ).toBeDefined();
        expect( otlpRoot?.parentSpanId ).toBeUndefined();

        const otlpStorage = scopeSpans.spans.find( ( s ) => s.name === 'storage:doc:get' );
        expect( otlpStorage ).toBeDefined();
        expect( otlpStorage?.parentSpanId ).toBe( serverTool.id );

        // Cleanup
        unsubscribe();
        await clientTransport.close();
        await serverTransport.close();
    } );

    it( 'captures tool execution error in span hierarchy while completing agent loop', async () => 
    {
        const collector = new TraceCollector();

        const failingTool = createTool( 
            {
                name        : 'failing_tool',
                description : 'A tool that fails',
                parameters  : schema.object( { reason : schema.string() } ),
                execute     : async () => 
                {
                    throw new Error( 'Remote database connection timeout' );
                }
            } 
        );

        let callCount = 0;
        const mockModel: ModelProtocol = 
            {
                provider : 'openai',
                model    : 'gpt-4o',
                generate : vi.fn( async (): Promise<ModelResponse> => 
                {
                    callCount++;

                    if( callCount === 1 )
                    {
                        return {
                            role         : 'assistant',
                            content      : 'Calling failing tool',
                            finishReason : 'tool_calls',
                            toolCalls : 
                            [
                                {
                                    id        : 'c_fail',
                                    name      : 'failing_tool',
                                    arguments : { reason : 'test' }
                                }
                            ],
                            usage : { promptTokens : 20, completionTokens : 10, totalTokens : 30 },
                            raw   : {}
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : 'I handled the tool error gracefully.',
                        finishReason : 'stop',
                        usage        : { promptTokens : 40, completionTokens : 10, totalTokens : 50 },
                        raw          : {}
                    };
                } ),
                stream : vi.fn()
            };

        const agent = new Agent( 
            {
                model : mockModel,
                tools : [ failingTool ],
                collector
            } 
        );

        const result = await agent.run( 'trigger failure' );
        expect( result.text ).toBe( 'I handled the tool error gracefully.' );

        const trace = collector.getTrace( result.traceId! );
        expect( trace ).toBeDefined();

        const step0 = trace!.rootSpan.children[ 0 ];
        const toolSpan = step0.children.find( ( c ) => c.name === 'tool:run:failing_tool' );

        expect( toolSpan ).toBeDefined();
        expect( toolSpan?.status ).toBe( 'error' );
        expect( toolSpan?.errorDetails?.message ).toContain( 'Remote database connection timeout' );
    } );

    it( 'instruments standalone MemoryDocStore operations under custom trace span', async () => 
    {
        const collector = new TraceCollector();
        const docStore = new MemoryDocStore();

        const { trace, context } = collector.startTrace( { name : 'manual:workflow' } );

        await context.withSpan( 'batch:write', async ( _span, batchCtx ) => 
        {
            await docStore.set( 'users', 'u1', { name : 'Alice' }, { context : batchCtx } );
            await docStore.set( 'users', 'u2', { name : 'Bob' }, { context : batchCtx } );
            await docStore.list( 'users', undefined, { context : batchCtx } );
            await docStore.delete( 'users', 'u1', { context : batchCtx } );
        } );

        collector.endTrace( trace.traceId );

        const completedTrace = collector.getTrace( trace.traceId );
        expect( completedTrace ).toBeDefined();

        const batchSpan = completedTrace!.rootSpan.children[ 0 ];
        expect( batchSpan.name ).toBe( 'batch:write' );
        expect( batchSpan.children ).toHaveLength( 4 );
        expect( batchSpan.children[ 0 ].name ).toBe( 'storage:doc:set' );
        expect( batchSpan.children[ 0 ].kind ).toBe( 'storage' );
        expect( batchSpan.children[ 0 ].attributes[ 'storage.collection' ] ).toBe( 'users' );
        expect( batchSpan.children[ 1 ].name ).toBe( 'storage:doc:set' );
        expect( batchSpan.children[ 2 ].name ).toBe( 'storage:doc:list' );
        expect( batchSpan.children[ 3 ].name ).toBe( 'storage:doc:delete' );
    } );
} );
