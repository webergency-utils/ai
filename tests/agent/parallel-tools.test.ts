import { describe, it, expect } from 'vitest';
import { Agent, createTool, CheckpointManager, type AgentEvent } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { AIError, BudgetRefusedError, CancelledError } from '../../src/core/error.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import type { LanguageModel } from '../../src/core/protocol.js';
import type { ModelResponse, ToolCall } from '../../src/core/types.js';

const sleep = ( ms: number ) => {return new Promise<void>( ( resolve ) => {setTimeout( resolve, ms );} );};

function toolTurnModel( calls: ToolCall[] ): LanguageModel
{
    let turn = 0;
    let streamTurn = 0;

    return {
        provider : 'openai',
        model    : 'gpt-4o',
        async generate(): Promise<ModelResponse>
        {
            turn++;

            if( turn === 1 )
            {
                return { role : 'assistant', content : '', finishReason : 'tool_calls', toolCalls : calls, raw : {} };
            }

            return { role : 'assistant', content : 'done', finishReason : 'stop', raw : {} };
        },
        async* stream()
        {
            streamTurn++;

            yield streamTurn === 1 
                ? { deltaContent : '', toolCalls : calls, finishReason : 'tool_calls' as const }
                : { deltaContent : 'done', finishReason : 'stop' as const };
        }
    };
}

function call( id: string, name = 'work', args: Record<string, unknown> = {} ): ToolCall
{
    return { id, name, arguments : args };
}

describe( 'parallel tool execution (U2)', () => 
{
    it( 'overlaps tools but commits results in model-call order (AE3, R6, R7)', async () => 
    {
        const delays: Record<string, number> = { c1 : 50, c2 : 20, c3 : 5 };
        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( { id : schema.string() } ),
            execute     : async ( args: { id: string } ) => 
            {
                await sleep( delays[ args.id ]! );

                return `result-${args.id}`;
            }
        } );
        const agent = new Agent( { model : toolTurnModel( [ call( 'c1', 'work', { id : 'c1' } ), call( 'c2', 'work', { id : 'c2' } ), call( 'c3', 'work', { id : 'c3' } ) ] ), tools : [ work ], toolConcurrency : 3 } );
        const events: AgentEvent[] = [];
        const started = Date.now();

        for await ( const event of agent.runStream( 'go' ) )
        {
            events.push( event );
        }

        expect( Date.now() - started ).toBeLessThan( 75 );

        const finish = events[ events.length - 1 ]!;
        const toolMessages = finish.type === 'finish' ? finish.result.messages.filter( ( m ) => {return m.role === 'tool';} ) : [];

        expect( toolMessages.map( ( m ) => {return m.role === 'tool' && m.toolCallId;} ) ).toEqual( [ 'c1', 'c2', 'c3' ] );
        expect( events.filter( ( e ) => {return e.type === 'tool:result';} ).map( ( e ) => {return e.type === 'tool:result' && e.content;} ) )
            .toEqual( [ 'result-c1', 'result-c2', 'result-c3' ] );
    } );

    it( 'never lets a contiguous gap into completedToolIds (R7)', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        const snapshots: string[][] = [];
        const original = checkpoints.saveCheckpoint.bind( checkpoints );

        checkpoints.saveCheckpoint = async ( input ) => 
        {
            snapshots.push( [ ...( input.completedToolIds ?? [] ) ] );

            return original( input );
        };

        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( { ms : schema.number() } ),
            execute     : async ( args: { ms: number } ) => 
            {
                await sleep( args.ms );

                return 'ok';
            }
        } );
        const agent = new Agent( { 
            model             : toolTurnModel( [ call( 'c1', 'work', { ms : 30 } ), call( 'c2', 'work', { ms : 1 } ), call( 'c3', 'work', { ms : 1 } ) ] ), 
            tools             : [ work ], 
            toolConcurrency   : 3, 
            checkpointManager : checkpoints 
        } );

        await agent.run( 'go', { threadId : 'gap' } );

        for( const completed of snapshots )
        {
            const expected = [ 'c1', 'c2', 'c3' ].slice( 0, completed.length );

            expect( completed ).toEqual( expected );
        }

        expect( snapshots.some( ( completed ) => {return completed.length === 3;} ) ).toBe( true );
    } );

    it( 'respects the concurrency cap (R6)', async () => 
    {
        let inFlight = 0;
        let maxInFlight = 0;
        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                maxInFlight = Math.max( maxInFlight, ++inFlight );
                await sleep( 5 );
                inFlight--;

                return 'ok';
            }
        } );
        const calls = [ 1, 2, 3, 4, 5, 6 ].map( ( n ) => {return call( `c${n}` );} );
        const result = await new Agent( { model : toolTurnModel( calls ), tools : [ work ], toolConcurrency : 2 } ).run( 'go' );

        expect( maxInFlight ).toBe( 2 );
        expect( result.messages.filter( ( m ) => {return m.role === 'tool';} ) ).toHaveLength( 6 );
    } );

    it( 'defaults to sequential execution (R6)', async () => 
    {
        let inFlight = 0;
        let maxInFlight = 0;
        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                maxInFlight = Math.max( maxInFlight, ++inFlight );
                await sleep( 2 );
                inFlight--;

                return 'ok';
            }
        } );

        await new Agent( { model : toolTurnModel( [ call( 'c1' ), call( 'c2' ), call( 'c3' ) ] ), tools : [ work ] } ).run( 'go' );

        expect( maxInFlight ).toBe( 1 );
    } );

    it( 'runs parallelSafe:false tools alone (R6)', async () => 
    {
        let inFlight = 0;
        let overlapWithExclusive = false;
        let exclusiveRunning = false;
        const exclusive = createTool( {
            name         : 'solo',
            description  : 'solo',
            parameters   : schema.object( {} ),
            parallelSafe : false,
            execute      : async () => 
            {
                exclusiveRunning = true;
                inFlight++;
                overlapWithExclusive = overlapWithExclusive || inFlight > 1;
                await sleep( 8 );
                inFlight--;
                exclusiveRunning = false;

                return 'solo';
            }
        } );
        const safe = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                inFlight++;
                overlapWithExclusive = overlapWithExclusive || exclusiveRunning;
                await sleep( 8 );
                inFlight--;

                return 'work';
            }
        } );

        const calls = [ call( 'a', 'work' ), call( 'b', 'work' ), call( 'c', 'solo' ), call( 'd', 'work' ), call( 'e', 'work' ) ];
        const result = await new Agent( { model : toolTurnModel( calls ), tools : [ safe, exclusive ], toolConcurrency : 4 } ).run( 'go' );

        expect( overlapWithExclusive ).toBe( false );
        expect( result.messages.filter( ( m ) => {return m.role === 'tool';} ).map( ( m ) => {return m.role === 'tool' && m.toolCallId;} ) )
            .toEqual( [ 'a', 'b', 'c', 'd', 'e' ] );
    } );

    it( 'keeps ordinary tool errors model-visible without disturbing siblings (R9)', async () => 
    {
        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( { fail : schema.boolean() } ),
            execute     : async ( args: { fail: boolean } ) => 
            {
                await sleep( 2 );

                if( args.fail ){throw new Error( 'boom' );}

                return 'fine';
            }
        } );
        const result = await new Agent( { 
            model           : toolTurnModel( [ call( 'c1', 'work', { fail : false } ), call( 'c2', 'work', { fail : true } ), call( 'c3', 'work', { fail : false } ) ] ), 
            tools           : [ work ], 
            toolConcurrency : 3 
        } ).run( 'go' );
        const contents = result.messages.filter( ( m ) => {return m.role === 'tool';} ).map( ( m ) => {return m.content;} );

        expect( contents ).toEqual( [ 'fine', 'Error: Error: boom', 'fine' ] );
        expect( result.status ).toBe( 'completed' );
    } );

    it( 'aborts siblings on a fatal error, waits for them, saves interrupted, rethrows (R9)', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        let siblingAborted = false;
        let siblingSettledBeforeThrow = false;
        const fatal = createTool( {
            name        : 'fatal',
            description : 'fatal',
            parameters  : schema.object( {} ),
            execute     : async () => 
            {
                await sleep( 5 );

                throw new BudgetRefusedError( 'exhausted', 'budget gone' );
            }
        } );
        const sibling = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( {} ),
            execute     : async ( _args, _ctx, options ) => 
            {
                await new Promise<void>( ( resolve ) => 
                {
                    options?.signal?.addEventListener( 'abort', () => {return resolve();}, { once : true } );
                } );
                await sleep( 5 );
                siblingAborted = true;
                siblingSettledBeforeThrow = true;

                return 'late';
            }
        } );
        const agent = new Agent( { 
            model             : toolTurnModel( [ call( 'c1', 'work' ), call( 'c2', 'fatal' ), call( 'c3', 'work' ) ] ), 
            tools             : [ sibling, fatal ], 
            toolConcurrency   : 3, 
            checkpointManager : checkpoints 
        } );

        await expect( agent.run( 'go', { threadId : 'fatal' } ) ).rejects.toBeInstanceOf( BudgetRefusedError );

        expect( siblingAborted ).toBe( true );
        expect( siblingSettledBeforeThrow ).toBe( true );

        const latest = await checkpoints.getLatestCheckpoint( 'fatal' );
        expect( latest?.status ).toBe( 'interrupted' );
        expect( latest?.completedToolIds ?? [] ).toEqual( [] );
    } );

    it( 'leaves the batch uncommitted when call 1 is still running at abort, then resume re-runs all (AE4, R8)', async () => 
    {
        const checkpoints = new CheckpointManager( new MemoryDocStore() );
        const controller = new AbortController();
        const runs: string[] = [];
        let mode: 'abort' | 'resume' = 'abort';
        const work = createTool( {
            name        : 'work',
            description : 'work',
            parameters  : schema.object( { id : schema.string() } ),
            execute     : async ( args: { id: string }, _ctx, options ) => 
            {
                runs.push( args.id );

                if( mode === 'resume' )
                {
                    return `ok-${args.id}`;
                }

                if( args.id === 'c3' )
                {
                    await sleep( 2 );
                    controller.abort();

                    return 'ok-c3';
                }

                await new Promise<void>( ( _resolve, reject ) => 
                {
                    options?.signal?.addEventListener( 'abort', () => {return reject( new CancelledError( 'stop' ) );}, { once : true } );
                } );

                return 'unreachable';
            }
        } );
        let turn = 0;
        const model: LanguageModel = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                turn++;

                return turn === 1 
                    ? { role : 'assistant', content : '', finishReason : 'tool_calls', toolCalls : [ call( 'c1', 'work', { id : 'c1' } ), call( 'c2', 'work', { id : 'c2' } ), call( 'c3', 'work', { id : 'c3' } ) ], raw : {} }
                    : { role : 'assistant', content : 'done', finishReason : 'stop', raw : {} };
            },
            async* stream(){yield* [];}
        };
        const agent = new Agent( { model, tools : [ work ], toolConcurrency : 3, checkpointManager : checkpoints } );

        await expect( agent.run( 'go', { threadId : 'ae4', signal : controller.signal } ) ).rejects.toBeInstanceOf( CancelledError );

        const interrupted = await checkpoints.getLatestCheckpoint( 'ae4' );
        expect( interrupted?.status ).toBe( 'interrupted' );
        expect( interrupted?.completedToolIds ?? [] ).toEqual( [] );
        expect( interrupted?.messages.filter( ( m ) => {return m.role === 'tool';} ) ).toHaveLength( 0 );

        runs.length = 0;
        mode = 'resume';

        const resumed = await agent.resume( 'ae4' );

        expect( runs.sort() ).toEqual( [ 'c1', 'c2', 'c3' ] );
        expect( resumed.status ).toBe( 'completed' );
        expect( resumed.messages.filter( ( m ) => {return m.role === 'tool';} ).map( ( m ) => {return m.role === 'tool' && m.toolCallId;} ) )
            .toEqual( [ 'c1', 'c2', 'c3' ] );
    } );

    it.each( [ 0, -1, 1.5, Number.NaN ] )( 'rejects toolConcurrency %s at construction (R6)', ( value ) => 
    {
        const model = toolTurnModel( [] );

        expect( () => {return new Agent( { model, toolConcurrency : value } );} ).toThrow( AIError );
        expect( () => {return new Agent( { model, toolConcurrency : value } );} ).toThrow( /toolConcurrency/ );
    } );
} );
