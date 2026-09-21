import { describe, it, expect, vi } from 'vitest';
import { 
    createModel, 
    createTool, 
    Agent, 
    CheckpointManager, 
    MemoryDocStore, 
    SpendTracker, 
    calculateSpend, 
    MCPServer, 
    MCPClient, 
    InMemoryTransport, 
    Workflow, 
    WorkflowRunner, 
    type ModelProtocol, 
    type ModelResponse,
    schema 
} from '../../src/index.js';

describe( 'E2E AI Toolkit Integration Pipeline', () => 
{
    it( 'should coordinate model, agent, checkpoint store, spend tracker, and MCP', async () => 
    {
        // 1. Setup Storage and Checkpoint Manager
        const docStore = new MemoryDocStore();
        const checkpointManager = new CheckpointManager( docStore );
        const spendTracker = new SpendTracker();

        // 2. Define Tools with schema builder
        const convertCurrencyTool = createTool( 
            {
                name        : 'convert_currency',
                description : 'Convert amount from USD to EUR',
                parameters  : schema.object( 
                    {
                        amountUSD : schema.number( { description : 'Amount in USD' } )
                    } ),
                execute : async ( args: { amountUSD : number } ) => 
                {
                    return { amountEUR : args.amountUSD * 0.92, rate : 0.92 };
                }
            } );

        // 3. Mock Model with Tool Calling
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
                            content      : 'Converting currency...',
                            finishReason : 'tool_calls',
                            toolCalls : 
                        [
                            {
                                id        : 'call_conv_1',
                                name      : 'convert_currency',
                                arguments : { amountUSD : 100 }
                            }
                        ],
                            usage : 
                        {
                            promptTokens     : 80,
                            completionTokens : 25,
                            totalTokens      : 105
                        },
                            raw : {}
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : '100 USD is equivalent to 92 EUR.',
                        finishReason : 'stop',
                        usage : 
                    {
                        promptTokens     : 120,
                        completionTokens : 15,
                        totalTokens      : 135
                    },
                        raw : {}
                    };
                } ),
                stream : vi.fn()
            };

        // 4. Initialize and Run Autonomous Agent
        const agent = new Agent( 
            {
                model        : mockModel,
                instructions : 'You are a financial exchange agent.',
                tools        : [ convertCurrencyTool ],
                checkpointManager,
                spendTracker
            } );

        const threadId = 'fin-thread-e2e';
        const agentResult = await agent.run( 'Convert 100 USD to EUR', { threadId } );

        expect( agentResult.text ).toBe( '100 USD is equivalent to 92 EUR.' );
        expect( agentResult.steps ).toBe( 2 );
        expect( agentResult.spendUSD ).toBeGreaterThan( 0 );

        // 5. Verify Checkpoint Preservation
        const checkpoint = await checkpointManager.getLatestCheckpoint( threadId );
        expect( checkpoint ).toBeDefined();
        expect( checkpoint?.messages ).toHaveLength( 4 );
        expect( checkpoint?.messages[2].role ).toBe( 'tool' );
        expect( checkpoint?.messages[2].content ).toContain( '92' );

        // 6. Verify Spend Tracking & Calculation
        const spendDetails = calculateSpend( 'gpt-4o', {
            promptTokens     : 200,
            completionTokens : 40,
            totalTokens      : 240
        } );

        expect( spendDetails.totalCost ).toBeGreaterThan( 0 );
        expect( spendTracker.totalSpendUSD ).toBeCloseTo( agentResult.spendUSD, 6 );

        // 7. MCP Server & Client Export Loop
        const server = new MCPServer( { name : 'finance-mcp', version : '1.0.0' } );
        server.registerTool( convertCurrencyTool.toDefinition(), async ( args ) => 
        {
            return convertCurrencyTool.run( args );
        } );

        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        await server.connect( serverTransport );

        const client = new MCPClient( clientTransport );
        await client.connect();

        const mcpTools = await client.listTools();
        expect( mcpTools ).toHaveLength( 1 );
        expect( mcpTools[0].name ).toBe( 'convert_currency' );

        const mcpCallResult = await client.callTool( 'convert_currency', { amountUSD : 200 } );
        expect( mcpCallResult.isError ).toBe( false );
        expect( mcpCallResult.content[0].text ).toContain( '184' );

        await client.close();

        // 8. Workflow Step DAG Execution with Human-in-the-Loop Interrupt
        const workflow = new Workflow( 'financial-report-pipeline' );

        workflow
            .step( 'fetch_rates', async () => 
            {
                return { eurRate : 0.92, gbpRate : 0.78 };
            } )
            .wait( 'compliance_check', { dependencies : [ 'fetch_rates' ] } )
            .step( 'compile_report', async ( input: unknown, ctx ) => 
            {
                const rates = ctx.stepOutputs.fetch_rates as { eurRate: number, gbpRate: number };
                const compliance = ctx.stepOutputs.compliance_check as { approved: boolean, approver: string };

                return {
                    rates,
                    complianceApproved : compliance.approved,
                    status             : 'ready'
                };
            }, { dependencies : [ 'compliance_check' ] } );

        const runner = new WorkflowRunner( workflow, { checkpointStore : docStore } );
        const workflowRunId = 'wf-run-finance';

        const runSuspended = await runner.execute( {}, workflowRunId );
        expect( runSuspended.status ).toBe( 'suspended' );
        expect( runSuspended.suspendedAtStepId ).toBe( 'compliance_check' );

        const runResumed = await runner.resume( workflowRunId, { approved : true, approver : 'legal_officer' } );
        expect( runResumed.status ).toBe( 'completed' );
        expect( runResumed.outputs.compile_report ).toEqual( {
            rates              : { eurRate : 0.92, gbpRate : 0.78 },
            complianceApproved : true,
            status             : 'ready'
        } );
    } );

    it( 'should instantiate models dynamically via createModel', () => 
    {
        const openai = createModel( { provider : 'openai', model : 'gpt-4o' } );
        expect( openai.provider ).toBe( 'openai' );
        expect( openai.model ).toBe( 'gpt-4o' );

        const anthropic = createModel( { provider : 'anthropic', model : 'claude-3-7-sonnet-20250219' } );
        expect( anthropic.provider ).toBe( 'anthropic' );
        expect( anthropic.model ).toBe( 'claude-3-7-sonnet-20250219' );
    } );
} );
