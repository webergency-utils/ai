import { describe, it, expect } from 'vitest';
import { Agent, createTool, CheckpointManager, type AgentEvent } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { CancelledError, InvalidInputError, ProviderError } from '../../src/core/error.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { TraceCollector } from '../../src/trace/index.js';
import type { LanguageModel } from '../../src/core/protocol.js';
import type { ModelRequest, ModelResponse, ModelStreamChunk } from '../../src/core/types.js';
import type { Span } from '../../src/trace/types.js';

/** Scripted model: call N of `stream` yields turn N's chunks; `generate` returns the matching response. */
function scriptedModel( turns: { chunks: ModelStreamChunk[], response: ModelResponse }[], requests: ModelRequest[] = [] ): LanguageModel
{
    let streamCalls = 0;
    let generateCalls = 0;

    return {
        provider : 'openai',
        model    : 'gpt-4o',
        async generate( request: ModelRequest ): Promise<ModelResponse>
        {
            requests.push( request );

            return turns[ generateCalls++ ]!.response;
        },
        async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
        {
            requests.push( request );

            yield* turns[ streamCalls++ ]!.chunks;
        }
    };
}

function weatherTool( runs: string[] = [] )
{
    return createTool( {
        name        : 'get_weather',
        description : 'weather',
        parameters  : schema.object( { city : schema.string() } ),
        execute     : async ( args: { city: string } ) => 
        {
            runs.push( args.city );

            return `sunny in ${args.city}`;
        }
    } );
}

const TOOL_TURN = {
    chunks : [
        { deltaContent : 'Checking' },
        { deltaContent : ' now', deltaReasoningContent : 'thinking' },
        { deltaContent : '', deltaToolCall : { index : 0, id : 'c1', name : 'get_weather', arguments : '{"ci' } },
        { deltaContent : '', deltaToolCall : { index : 0, arguments : 'ty":"Prague"}' } },
        { deltaContent : '', finishReason : 'tool_calls' as const, usage : { promptTokens : 10, completionTokens : 5, totalTokens : 15 } }
    ],
    response : {
        role         : 'assistant' as const,
        content      : 'Checking now',
        reasoningContent : 'thinking',
        finishReason : 'tool_calls' as const,
        toolCalls    : [ { id : 'c1', name : 'get_weather', arguments : { city : 'Prague' } } ],
        usage        : { promptTokens : 10, completionTokens : 5, totalTokens : 15 },
        raw          : {}
    }
};

const FINAL_TURN = {
    chunks : [
        { deltaContent : 'Sunny' },
        { deltaContent : ' in Prague', finishReason : 'stop' as const, usage : { promptTokens : 20, completionTokens : 4, totalTokens : 24 } }
    ],
    response : {
        role         : 'assistant' as const,
        content      : 'Sunny in Prague',
        finishReason : 'stop' as const,
        usage        : { promptTokens : 20, completionTokens : 4, totalTokens : 24 },
        raw          : {}
    }
};

async function collect( events: AsyncIterable<AgentEvent> ): Promise<AgentEvent[]>
{
    const all: AgentEvent[] = [];

    for await ( const event of events )
    {
        all.push( event );
    }

    return all;
}

function findSpans( span: Span, name: string, found: Span[] = [] ): Span[]
{
    span.name === name && found.push( span );
    span.children.forEach( ( child ) => {return findSpans( child, name, found );} );

    return found;
}

describe( 'Agent.runStream (U1)', () => 
{
    it( 'emits deterministic events and finishes with the result (AE1, R1, R2)', async () => 
    {
        const agent = new Agent( { model : scriptedModel( [ TOOL_TURN, FINAL_TURN ] ), tools : [ weatherTool() ] } );
        const events = await collect( agent.runStream( 'weather?' ) );

        expect( events.map( ( e ) => {return e.type;} ) ).toEqual( [
            'step:start', 'text:delta', 'text:delta', 'reasoning:delta', 'tool:call', 'tool:result', 'step:finish',
            'step:start', 'text:delta', 'text:delta', 'step:finish',
            'finish'
        ] );

        const call = events.find( ( e ) => {return e.type === 'tool:call';} );
        expect( call ).toMatchObject( { step : 0, toolCall : { id : 'c1', name : 'get_weather', arguments : { city : 'Prague' } } } );

        const toolResult = events.find( ( e ) => {return e.type === 'tool:result';} );
        expect( toolResult ).toMatchObject( { toolCallId : 'c1', content : 'sunny in Prague', isError : false } );

        const firstFinish = events.find( ( e ) => {return e.type === 'step:finish';} );
        expect( firstFinish ).toMatchObject( { step : 0, toolCalls : 1, finishReason : 'tool_calls', usage : { totalTokens : 15 } } );

        const finish = events[ events.length - 1 ]!;
        expect( finish.type ).toBe( 'finish' );
        expect( finish.type === 'finish' && finish.result ).toMatchObject( { text : 'Sunny in Prague', steps : 2, status : 'completed' } );
    } );

    it( 'flags tool errors in tool:result events', async () => 
    {
        const agent = new Agent( { model : scriptedModel( [ TOOL_TURN, FINAL_TURN ] ), tools : [] } );
        const events = await collect( agent.runStream( 'weather?' ) );

        expect( events.find( ( e ) => {return e.type === 'tool:result';} ) )
            .toMatchObject( { isError : true, content : "Error: Tool 'get_weather' not found" } );
    } );

    it( 'throws ProviderError for malformed tool JSON and emits no tool:call (AE2, R3)', async () => 
    {
        const model = scriptedModel( [ {
            chunks : [
                { deltaContent : '', deltaToolCall : { index : 0, id : 'c1', name : 'get_weather', arguments : '{"city":' } },
                { deltaContent : '', finishReason : 'tool_calls' }
            ],
            response : TOOL_TURN.response
        } ] );
        const agent = new Agent( { model, tools : [ weatherTool() ] } );
        const seen: string[] = [];
        let error: unknown;

        try
        {
            for await ( const event of agent.runStream( 'x' ) )
            {
                seen.push( event.type );
            }
        }
        catch( err )
        {
            error = err;
        }

        expect( error ).toBeInstanceOf( ProviderError );
        expect( seen ).not.toContain( 'tool:call' );
        expect( seen ).not.toContain( 'finish' );
    } );

    it( 'throws InvalidInputError when streamed arguments violate the tool schema (R3)', async () => 
    {
        const model = scriptedModel( [ {
            chunks : [
                { deltaContent : '', deltaToolCall : { index : 0, id : 'c1', name : 'get_weather', arguments : '{"city":42}' } },
                { deltaContent : '', finishReason : 'tool_calls' }
            ],
            response : TOOL_TURN.response
        } ] );
        const agent = new Agent( { model, tools : [ weatherTool() ] } );

        await expect( collect( agent.runStream( 'x' ) ) ).rejects.toBeInstanceOf( InvalidInputError );
    } );

    it( 'saves an interrupted checkpoint when the consumer leaves early (R4)', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        let aborted: AbortSignal | undefined;
        const model: LanguageModel = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                throw new Error( 'unused' );
            },
            async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
            {
                aborted = request.signal;

                yield { deltaContent : 'one' };
                yield { deltaContent : 'two' };
                yield { deltaContent : 'three', finishReason: 'stop' };
            }
        };
        const agent = new Agent( { model, checkpointManager : checkpoints } );

        for await ( const event of agent.runStream( 'x', { threadId : 't1' } ) )
        {
            if( event.type === 'text:delta' )
            {
                break;
            }
        }

        expect( aborted?.aborted ).toBe( true );

        const latest = await checkpoints.getLatestCheckpoint( 't1' );
        expect( latest?.status ).toBe( 'interrupted' );
    } );

    it( 'saves interrupted and throws CancelledError when options.signal aborts mid-stream (R4)', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        const controller = new AbortController();
        const agent = new Agent( { model : scriptedModel( [ FINAL_TURN ] ), checkpointManager : checkpoints } );
        const events: string[] = [];
        let error: unknown;

        try
        {
            for await ( const event of agent.runStream( 'x', { threadId : 't2', signal : controller.signal } ) )
            {
                events.push( event.type );
                controller.abort();
            }
        }
        catch( err )
        {
            error = err;
        }

        expect( error ).toBeInstanceOf( CancelledError );
        expect( events ).not.toContain( 'finish' );
        expect( ( await checkpoints.getLatestCheckpoint( 't2' ) )?.status ).toBe( 'interrupted' );
    } );

    it( 'surfaces a pre-aborted signal as CancelledError', async () => 
    {
        const controller = new AbortController();

        controller.abort();

        const agent = new Agent( { model : scriptedModel( [ FINAL_TURN ] ) } );

        await expect( collect( agent.runStream( 'x', { signal : controller.signal } ) ) ).rejects.toBeInstanceOf( CancelledError );
    } );

    it( 'produces the same messages for run and runStream (R1)', async () => 
    {
        const turns = [ TOOL_TURN, FINAL_TURN ];
        const viaRun = await new Agent( { model : scriptedModel( turns ), tools : [ weatherTool() ] } ).run( 'weather?' );
        const events = await collect( new Agent( { model : scriptedModel( turns ), tools : [ weatherTool() ] } ).runStream( 'weather?' ) );
        const finish = events[ events.length - 1 ]!;

        expect( finish.type === 'finish' && finish.result.messages ).toEqual( viaRun.messages );
        expect( finish.type === 'finish' && finish.result.text ).toBe( viaRun.text );
    } );

    it( 'keeps span names and checkpoint sequence aligned with run (R5)', async () => 
    {
        const collector = new TraceCollector();
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        const agent = new Agent( { model : scriptedModel( [ FINAL_TURN ] ), checkpointManager : checkpoints, collector } );
        const events = await collect( agent.runStream( 'x', { threadId : 't3' } ) );
        const finish = events[ events.length - 1 ]!;
        const span = finish.type === 'finish' ? finish.result.span! : undefined;

        expect( findSpans( span!, 'agent:step:0' ) ).toHaveLength( 1 );
        expect( findSpans( span!, 'model:stream' ) ).toHaveLength( 1 );
        expect( findSpans( span!, 'model:generate' ) ).toHaveLength( 0 );

        const history = await checkpoints.getLatestCheckpoint( 't3' );
        expect( history?.status ).toBe( 'completed' );
    } );

    it( 'records spend once per streamed step (R5)', async () => 
    {
        const tracker = new SpendTracker();
        const agent = new Agent( { model : scriptedModel( [ TOOL_TURN, FINAL_TURN ] ), tools : [ weatherTool() ], spendTracker : tracker } );
        const events = await collect( agent.runStream( 'x' ) );
        const finish = events[ events.length - 1 ]!;

        const viaRun = new SpendTracker();
        const runResult = await new Agent( { model : scriptedModel( [ TOOL_TURN, FINAL_TURN ] ), tools : [ weatherTool() ], spendTracker : viaRun } ).run( 'x' );

        expect( finish.type === 'finish' && finish.result.spendUSD ).toBeGreaterThan( 0 );
        expect( finish.type === 'finish' && finish.result.spendUSD ).toBe( runResult.spendUSD );
    } );

    it( 'resumeStream continues an interrupted thread with events', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        const runs: string[] = [];

        await checkpoints.saveCheckpoint( {
            threadId         : 'rs',
            runId            : 'run_1',
            sequence         : 2,
            stepIndex        : 1,
            runStepCount     : 1,
            messages         : [
                { role : 'user', content : 'go' },
                { role : 'assistant', content : '', toolCalls : [ { id : 'c1', name : 'get_weather', arguments : { city : 'Prague' } } ] }
            ],
            status           : 'interrupted',
            originalInput    : 'go',
            pendingToolCalls : [ { id : 'c1', name : 'get_weather', arguments : { city : 'Prague' } } ]
        } );

        const agent = new Agent( { model : scriptedModel( [ FINAL_TURN ] ), tools : [ weatherTool( runs ) ], checkpointManager : checkpoints } );
        const events = await collect( agent.resumeStream( 'rs' ) );

        expect( runs ).toEqual( [ 'Prague' ] );
        expect( events.map( ( e ) => {return e.type;} ) ).toEqual( [ 'tool:result', 'step:start', 'text:delta', 'text:delta', 'step:finish', 'finish' ] );
    } );
} );
