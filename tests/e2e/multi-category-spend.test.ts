import { describe, it, expect, vi } from 'vitest';
import 
{
    schema,
    createTool,
    Agent,
    MemoryVectorStore,
    SpendTracker,
    UnitCostRegistry,
    type ModelProtocol,
    type ModelResponse,
    type SpendWarningEvent
} from '../../src/index.js';
import { BudgetExceededError } from '../../src/core/error.js';

describe( 'E2E Multi-Category Spend & Telemetry Pipeline', () => 
{
    it( 'should track model inference, storage queries, and tool spend in tandem', async () => 
    {
        const tracker = new SpendTracker( {
            maxBudgetUSD     : 0.10,
            warningThreshold : 0.75
        } );

        const warnings: SpendWarningEvent[] = [];

        tracker.on( 'warning', ( event ) => 
        {
            warnings.push( event );
        } );

        // Setup metered vector store
        const vectorPricing = new UnitCostRegistry();
        vectorPricing.register( 'storage:vector_query', 0.0005 );

        const vectorStore = new MemoryVectorStore( {
            storagePricing : vectorPricing
        } );

        await vectorStore.upsert( [
            { id : 'doc1', values : [ 1, 0, 0 ], content : 'Antigravity AI is powerful.' },
            { id : 'doc2', values : [ 0, 1, 0 ], content : 'TypeScript toolkit with zero deps.' }
        ] );

        // Define tool that uses vector store with context and reports custom tool spend
        const knowledgeSearchTool = createTool( {
            name        : 'search_knowledge',
            description : 'Search the knowledge base',
            parameters  : schema.object( {
                query : schema.string()
            } ),
            execute : async ( args, context ) => 
            {
                // Ambient storage query
                const results = await vectorStore.query( [ 1, 0, 0 ], { topK : 1, context } );

                // Ambient direct third-party search cost
                if( context )
                {
                    context.reportSpend( {
                        category    : 'tools',
                        subcategory : 'external_search_api',
                        costUSD     : 0.005
                    } );
                }

                return results.map( ( r ) => {return r.content;} ).join( '\n' );
            }
        } );

        // Mock 2-turn model: 1. tool call -> 2. final answer
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
                            content      : 'Searching knowledge...',
                            finishReason : 'tool_calls',
                            toolCalls : 
                            [
                                {
                                    id        : 'call_search_1',
                                    name      : 'search_knowledge',
                                    arguments : { query : 'Antigravity' }
                                }
                            ],
                            usage : 
                            {
                                promptTokens     : 800,
                                completionTokens : 200,
                                totalTokens      : 1_000
                            }
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : 'Based on search, Antigravity AI is powerful.',
                        finishReason : 'stop',
                        usage : 
                        {
                            promptTokens     : 1_200,
                            completionTokens : 100,
                            totalTokens      : 1_300
                        }
                    };
                } )
            };

        const agent = new Agent( {
            model        : mockModel,
            tools        : [ knowledgeSearchTool ],
            spendTracker : tracker
        } );

        const result = await agent.run( 'Tell me about Antigravity', {
            threadId : 'e2e-multi-cat-session'
        } );

        expect( result.text ).toBe( 'Based on search, Antigravity AI is powerful.' );
        expect( result.steps ).toBe( 2 );

        // Verify multi-category spend aggregation
        expect( tracker.getCategorySpend( 'model' ) ).toBeGreaterThan( 0 );
        expect( tracker.getCategorySpend( 'tools' ) ).toBe( 0.005 );
        expect( tracker.getCategorySpend( 'storage' ) ).toBe( 0.0005 );

        const breakdown = tracker.categorySpend;

        expect( breakdown.model ).toBeGreaterThan( 0 );
        expect( breakdown.tools ).toBe( 0.005 );
        expect( breakdown.storage ).toBe( 0.0005 );
        expect( breakdown.network ).toBe( 0 );

        // Total spend includes model + tools + storage
        const expectedTotal = breakdown.model + 0.005 + 0.0005;

        expect( tracker.totalSpendUSD ).toBeCloseTo( expectedTotal, 6 );
        expect( result.spendUSD ).toBeCloseTo( expectedTotal, 6 );
        expect( result.categorySpend ).toBeDefined();
        expect( result.categorySpend?.tools ).toBe( 0.005 );
    } );

    it( 'should enforce category budget ceilings during agent execution', async () => 
    {
        // Category ceiling of $0.003 for tools
        const tracker = new SpendTracker( {
            maxBudgetUSD    : 10.00,
            categoryBudgets : {
                tools : 0.003
            }
        } );

        const paidApiTool = createTool( {
            name        : 'paid_api',
            description : 'Expensive API',
            parameters  : schema.object( {} ),
            execute     : async ( _args, context ) => 
            {
                if( context )
                {
                    // Attempting to spend $0.005, which breaches the $0.003 category limit
                    context.reportSpend( {
                        category : 'tools',
                        costUSD  : 0.005
                    } );
                }

                return 'success';
            }
        } );

        const mockModel: ModelProtocol = 
            {
                provider : 'openai',
                model    : 'gpt-4o',
                generate : vi.fn( async (): Promise<ModelResponse> => 
                {
                    return {
                        role         : 'assistant',
                        content      : 'Calling paid API...',
                        finishReason : 'tool_calls',
                        toolCalls : 
                        [
                            {
                                id        : 'call_paid_1',
                                name      : 'paid_api',
                                arguments : {}
                            }
                        ]
                    };
                } )
            };

        const agent = new Agent( {
            model        : mockModel,
            tools        : [ paidApiTool ],
            spendTracker : tracker,
            maxIterations: 1
        } );

        const result = await agent.run( 'Execute paid API' );

        // Tool execution caught the error and reported it in tool result message
        const toolMsg = result.messages.find( ( m ) => {return m.role === 'tool';} );

        expect( toolMsg ).toBeDefined();
        expect( toolMsg!.content ).toContain( 'budget cap exceeded' );
        expect( toolMsg!.content ).toContain( 'tools' );

    } );
} );
