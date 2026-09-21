import { describe, it, expect, vi } from 'vitest';
import { Agent, createTool, CheckpointManager } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelResponse } from '../../src/core/types.js';

describe( 'Autonomous Agent Tool Execution Loop', () => 
{
    it( 'should execute multi-turn tool calling loop and save checkpoints', async () => 
    {
        const docStore = new MemoryDocStore();
        const checkpointManager = new CheckpointManager( docStore );
        const spendTracker = new SpendTracker();

        const weatherTool = createTool( 
            {
                name        : 'get_weather',
                description : 'Get city weather',
                parameters  : schema.object( { city : schema.string() } ),
                execute     : async ( args: { city : string } ) => 
                {
                    return { city : args.city, temp : '22C', condition : 'Sunny' };
                }
            } );

        // Mock model that first issues a tool call, then issues final answer
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
                            content      : 'Checking weather for Prague...',
                            finishReason : 'tool_calls',
                            toolCalls : 
                        [
                            {
                                id        : 'call_weather_1',
                                name      : 'get_weather',
                                arguments : { city : 'Prague' }
                            }
                        ],
                            usage : { promptTokens : 50, completionTokens : 20, totalTokens : 70 },
                            raw   : {}
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : 'The weather in Prague is 22C and Sunny.',
                        finishReason : 'stop',
                        usage        : { promptTokens : 80, completionTokens : 15, totalTokens : 95 },
                        raw          : {}
                    };
                } ),
                stream : vi.fn()
            };

        const agent = new Agent( 
            {
                model        : mockModel,
                instructions : 'You are a weather assistant.',
                tools        : [ weatherTool ],
                checkpointManager,
                spendTracker
            } );

        const threadId = 'test-agent-thread';
        const result = await agent.run( 'What is the weather in Prague?', { threadId } );

        expect( result.text ).toBe( 'The weather in Prague is 22C and Sunny.' );
        expect( result.steps ).toBe( 2 );
        expect( result.spendUSD ).toBeGreaterThan( 0 );
        expect( result.threadId ).toBe( threadId );

        // Messages should contain: user prompt, assistant tool call, tool response, final assistant response
        expect( result.messages ).toHaveLength( 4 );
        expect( result.messages[0].role ).toBe( 'user' );
        expect( result.messages[1].role ).toBe( 'assistant' );
        expect( result.messages[1].toolCalls ).toHaveLength( 1 );
        expect( result.messages[2].role ).toBe( 'tool' );
        expect( result.messages[2].content ).toContain( '22C' );
        expect( result.messages[3].role ).toBe( 'assistant' );
        expect( result.messages[3].content ).toBe( 'The weather in Prague is 22C and Sunny.' );

        // Checkpoints should be saved for thread
        const latestCheckpoint = await checkpointManager.getLatestCheckpoint( threadId );
        expect( latestCheckpoint ).toBeDefined();
        expect( latestCheckpoint?.messages ).toHaveLength( 4 );
        expect( latestCheckpoint?.spendUSD ).toBe( result.spendUSD );
    } );

    it( 'should handle unknown tool gracefully by passing error message back to model', async () => 
    {
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
                            content      : 'Calling nonexistent tool',
                            finishReason : 'tool_calls',
                            toolCalls    : [ { id : 'c1', name : 'missing_tool', arguments : {} } ],
                            raw          : {}
                        };
                    }

                    return {
                        role         : 'assistant',
                        content      : 'I see that tool is unavailable.',
                        finishReason : 'stop',
                        raw          : {}
                    };
                } ),
                stream : vi.fn()
            };

        const agent = new Agent( { model : mockModel, tools : [] } );
        const result = await agent.run( 'test' );

        expect( result.text ).toBe( 'I see that tool is unavailable.' );
        expect( result.messages[2].content ).toContain( 'Error: Tool \'missing_tool\' not found' );
    } );

    it( 'should abort execution when AbortSignal is triggered', async () => 
    {
        const controller = new AbortController();
        controller.abort();

        const mockModel: ModelProtocol = 
            {
                provider : 'openai',
                model    : 'gpt-4o',
                generate : vi.fn(),
                stream   : vi.fn()
            };

        const agent = new Agent( { model : mockModel } );

        await expect( agent.run( 'test', { signal : controller.signal } ) )
            .rejects
            .toThrow( /aborted/ );
    } );
} );
