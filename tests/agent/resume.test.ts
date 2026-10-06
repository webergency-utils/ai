import { describe, it, expect } from 'vitest';
import { Agent, createTool, CheckpointManager } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { CancelledError } from '../../src/core/error.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelResponse } from '../../src/core/types.js';

describe( 'Agent run lifecycle (U5)', () => 
{
    it( 'applies step limit per run, not across prior turns (AE4)', async () => 
    {
        const store = new MemoryDocStore();
        const checkpoints = new CheckpointManager( store );
        let calls = 0;

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                calls++;

                return {
                    role         : 'assistant',
                    content      : `answer-${calls}`,
                    finishReason : 'stop',
                    raw          : {}
                };
            },
            async* stream(){yield* [];}
        };

        const agent = new Agent( {
            model,
            maxIterations     : 10,
            checkpointManager : checkpoints
        } );

        // Prior turn used many steps in checkpoint history — should not block a new run.
        await checkpoints.saveCheckpoint( {
            threadId     : 't1',
            runId        : 'old',
            sequence     : 9,
            stepIndex    : 9,
            runStepCount : 9,
            messages     : [ { role : 'user', content : 'old' }, { role : 'assistant', content : 'done' } ],
            status       : 'completed'
        } );

        const result = await agent.run( 'new question', { threadId : 't1' } );

        expect( result.status ).toBe( 'completed' );
        expect( result.steps ).toBe( 1 );
        expect( result.text ).toBe( 'answer-1' );
    } );

    it( 'reports step_limit status when a single run exceeds maxIterations (R15)', async () => 
    {
        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                return {
                    role         : 'assistant',
                    content      : '',
                    finishReason : 'tool_calls',
                    toolCalls    : [ { id : 'c1', name : 'noop', arguments : {} } ],
                    raw          : {}
                };
            },
            async* stream(){yield* [];}
        };

        const noop = createTool( {
            name        : 'noop',
            description : 'noop',
            parameters  : schema.object( {} ),
            execute     : async () => {return 'ok';}
        } );

        const agent = new Agent( { model, tools : [ noop ], maxIterations : 2 } );
        const result = await agent.run( 'loop' );

        expect( result.status ).toBe( 'step_limit' );
        expect( result.steps ).toBe( 2 );
    } );

    it( 'refuses a new turn on an interrupted thread until resume or abandon (AE11)', async () => 
    {
        const store = new MemoryDocStore();
        const checkpoints = new CheckpointManager( store );
        let calls = 0;
        let toolRuns = 0;

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                calls++;

                if( calls === 1 )
                {
                    return {
                        role         : 'assistant',
                        content      : '',
                        finishReason : 'tool_calls',
                        toolCalls    : [
                            { id : 't1', name : 'slow', arguments : {} },
                            { id : 't2', name : 'slow', arguments : {} },
                            { id : 't3', name : 'slow', arguments : {} }
                        ],
                        raw : {}
                    };
                }

                return {
                    role         : 'assistant',
                    content      : 'finished',
                    finishReason : 'stop',
                    raw          : {}
                };
            },
            async* stream(){yield* [];}
        };

        const slow = createTool( {
            name        : 'slow',
            description : 'slow',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                toolRuns++;

                return `ok-${toolRuns}`;
            }
        } );

        const agent = new Agent( {
            model,
            tools             : [ slow ],
            checkpointManager : checkpoints
        } );

        // Simulate a mid-batch process crash: two tools completed, third never ran.
        await checkpoints.saveCheckpoint( {
            threadId     : 'intr',
            runId        : 'run_crash',
            sequence     : 3,
            stepIndex    : 1,
            runStepCount : 1,
            messages     : [
                { role : 'user', content : 'go' },
                {
                    role      : 'assistant',
                    content   : '',
                    toolCalls : [
                        { id : 't1', name : 'slow', arguments : {} },
                        { id : 't2', name : 'slow', arguments : {} },
                        { id : 't3', name : 'slow', arguments : {} }
                    ]
                },
                { role : 'tool', toolCallId : 't1', name : 'slow', content : 'ok-1' },
                { role : 'tool', toolCallId : 't2', name : 'slow', content : 'ok-2' }
            ],
            status           : 'interrupted',
            originalInput    : 'go',
            pendingToolCalls : [
                { id : 't1', name : 'slow', arguments : {} },
                { id : 't2', name : 'slow', arguments : {} },
                { id : 't3', name : 'slow', arguments : {} }
            ],
            completedToolIds : [ 't1', 't2' ]
        } );

        await expect( agent.run( 'again', { threadId : 'intr' } ) )
            .rejects
            .toThrow( /interrupted/ );

        const beforeResume = toolRuns;
        const resumed = await agent.resume( 'intr' );

        expect( resumed.status ).toBe( 'completed' );
        expect( resumed.text ).toBe( 'finished' );
        expect( toolRuns ).toBe( beforeResume + 1 );
        expect( resumed.messages.filter( ( m ) => {return m.role === 'user';} ) ).toHaveLength( 1 );
    } );

    it( 'abandon closes pending tools then allows a new run (AE11)', async () => 
    {
        const store = new MemoryDocStore();
        const checkpoints = new CheckpointManager( store );

        await checkpoints.saveCheckpoint( {
            threadId     : 'ab',
            runId        : 'r1',
            sequence     : 1,
            stepIndex    : 1,
            runStepCount : 1,
            messages     : [
                { role : 'user', content : 'x' },
                {
                    role      : 'assistant',
                    content   : '',
                    toolCalls : [ { id : 'p1', name : 't', arguments : {} } ]
                }
            ],
            status           : 'interrupted',
            pendingToolCalls : [ { id : 'p1', name : 't', arguments : {} } ],
            completedToolIds : []
        } );

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                return { role : 'assistant', content : 'fresh', finishReason : 'stop', raw : {} };
            },
            async* stream(){yield* [];}
        };

        const agent = new Agent( { model, checkpointManager : checkpoints } );
        const abandoned = await agent.run( 'ignored', { threadId : 'ab', interrupted : 'abandon' } );

        expect( abandoned.status ).toBe( 'abandoned' );
        expect( abandoned.messages.at( -1 )?.content ).toContain( 'not executed' );

        const next = await agent.run( 'hello', { threadId : 'ab' } );
        expect( next.status ).toBe( 'completed' );
        expect( next.text ).toBe( 'fresh' );
    } );

    it( 'assigns distinct default thread ids (AE16)', async () => 
    {
        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                return { role : 'assistant', content : 'ok', finishReason : 'stop', raw : {} };
            },
            async* stream(){yield* [];}
        };

        const agent = new Agent( { model } );
        const [ a, b ] = await Promise.all( [ agent.run( 'a' ), agent.run( 'b' ) ] );

        expect( a.threadId ).toBeDefined();
        expect( b.threadId ).toBeDefined();
        expect( a.threadId ).not.toBe( b.threadId );
    } );

    it( 'throws CancelledError on abort without recording a completed tool result', async () => 
    {
        const controller = new AbortController();
        const store = new MemoryDocStore();
        const checkpoints = new CheckpointManager( store );

        const model: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                return {
                    role         : 'assistant',
                    content      : '',
                    finishReason : 'tool_calls',
                    toolCalls    : [ { id : 'c1', name : 'block', arguments : {} } ],
                    raw          : {}
                };
            },
            async* stream(){yield* [];}
        };

        const block = createTool( {
            name        : 'block',
            description : 'block',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                controller.abort();
                throw new CancelledError( 'tool cancelled' );
            }
        } );

        const agent = new Agent( {
            model,
            tools             : [ block ],
            checkpointManager : checkpoints
        } );

        await expect( agent.run( 'x', { threadId : 'cancel', signal : controller.signal } ) )
            .rejects
            .toThrow( CancelledError );

        const latest = await checkpoints.getLatestCheckpoint( 'cancel' );
        expect( latest?.status ).toBe( 'interrupted' );
        expect( latest?.messages.some( ( m ) => 
        {
            return m.role === 'tool' && m.content.includes( 'tool cancelled' );
        } ) ).toBe( false );
    } );
} );
