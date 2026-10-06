import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Workflow, WorkflowRunner } from '../../src/workflow/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { JevDecisionAdapter, LanguageModelDecisionAdapter } from '../../src/providers/index.js';
import { SimpleExecutionContext } from '../../src/agent/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import {
    AIError,
    NO_CAPABILITIES,
    question,
    type DecisionAnswers,
    type DecisionModel,
    type LanguageModel,
    type DecisionRequest,
    type DecisionQuestions
} from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

const questions = {
    team   : question.choice( [ 'billing', 'technical' ] ),
    urgent : question.yesNo()
};

type Answers = DecisionAnswers<typeof questions>;

function scriptedModel( team: 'billing' | 'technical' ): { model : DecisionModel, decide : ReturnType<typeof vi.fn> }
{
    const decide = vi.fn( async ( request: DecisionRequest<DecisionQuestions> ) =>
    {
        void request;

        return {
            answers : {
                team   : { type : 'choice', value : team, probabilities : { billing : team === 'billing' ? 1 : 0, technical : team === 'technical' ? 1 : 0 }, confidence : 0.9 },
                urgent : { type : 'yesNo', value : 0.7, probability : 0.7 }
            },
            calibrated : true,
            model      : 'scripted-1',
            raw        : {}
        };
    } );

    return { model : { provider : 'scripted', model : 'scripted-1', decide : decide as never }, decide };
}

function buildWorkflow( model: DecisionModel, log: string[], options: { retries? : number, timeoutMs? : number } = {} ): Workflow
{
    return new Workflow( 'support' )
        .step( 'intake', async () => {return { subject : 'Charged twice' };} )
        .decision( 'triage', {
            model,
            questions,
            dependencies : [ 'intake' ],
            input        : ( upstream: { subject: string } ) => {return { ticket : upstream.subject };},
            branches     : { billing : 'billingFlow', technical : 'techFlow' },
            route        : ( answers: Answers ) => {return answers.team.value;},
            ...options
        } )
        .step( 'billingFlow', async () => {log.push( 'billing' ); return 'B';} )
        .step( 'techFlow', async () => {log.push( 'technical' ); return 'T';} )
        .step( 'finish', async ( joined: Record<string, unknown> ) => {log.push( 'finish' ); return joined;}, { dependencies : [ 'billingFlow', 'techFlow' ] } );
}

describe( 'workflow decision step', () =>
{
    it( 'asks one call, routes to the chosen branch only, and skips the rest (AE4, F1)', async () =>
    {
        const log: string[] = [];
        const { model, decide } = scriptedModel( 'billing' );
        const result = await new WorkflowRunner( buildWorkflow( model, log ) ).execute();

        expect( result.status ).toBe( 'completed' );
        expect( log ).toEqual( [ 'billing', 'finish' ] );
        expect( result.skippedSteps ).toEqual( [ 'techFlow' ] );
        expect( decide ).toHaveBeenCalledTimes( 1 );
        expect( decide.mock.calls[ 0 ][ 0 ].input ).toEqual( { ticket : 'Charged twice' } );
        expect( decide.mock.calls[ 0 ][ 0 ].questions ).toBe( questions );
        expect( decide.mock.calls[ 0 ][ 0 ].retry ).toBe( false );
        expect( decide.mock.calls[ 0 ][ 0 ].signal ).toBeInstanceOf( AbortSignal );

        const output = result.outputs.triage as any;

        expect( output.branch ).toBe( 'billing' );
        expect( output.nextStep ).toBe( 'billingFlow' );
        expect( output.calibrated ).toBe( true );
        expect( output.answers.team.value ).toBe( 'billing' );
        expect( result.outputs.finish ).toEqual( { billingFlow : 'B' } );
    } );

    it( 'routes to the other branch for another answer', async () =>
    {
        const log: string[] = [];
        const result = await new WorkflowRunner( buildWorkflow( scriptedModel( 'technical' ).model, log ) ).execute();

        expect( log ).toEqual( [ 'technical', 'finish' ] );
        expect( result.skippedSteps ).toEqual( [ 'billingFlow' ] );
    } );

    it( 'accepts a fixed input value and passes the timeout (R13)', async () =>
    {
        const { model, decide } = scriptedModel( 'billing' );
        const workflow = new Workflow( 'fixed' )
            .decision( 'd', { model, questions, input : 'static text', timeoutMs : 4321, branches : { billing : 'a', technical : 'b' }, route : ( a: Answers ) => {return a.team.value;} } )
            .step( 'a', async () => {return 1;} )
            .step( 'b', async () => {return 2;} );

        await new WorkflowRunner( workflow ).execute();

        expect( decide.mock.calls[ 0 ][ 0 ] ).toMatchObject( { input : 'static text', timeoutMs : 4321 } );
    } );

    it( 'rejects a routing function that returns an undeclared branch (AE4, R18)', async () =>
    {
        const log: string[] = [];
        const workflow = new Workflow( 'bad-route' )
            .decision( 'd', {
                model    : scriptedModel( 'billing' ).model,
                questions,
                input    : 'x',
                branches : { billing : 'a', technical : 'b' },
                route    : () => {return 'refund' as 'billing';}
            } )
            .step( 'a', async () => {log.push( 'a' );} )
            .step( 'b', async () => {log.push( 'b' );} );
        const result = await new WorkflowRunner( workflow ).execute();

        expect( result.status ).toBe( 'failed' );
        expect( ( result.error as AIError ).code ).toBe( 'WORKFLOW_UNKNOWN_BRANCH' );
        expect( ( result.error as AIError ).message ).toMatch( /refund/ );
        expect( log ).toEqual( [] );
        expect( result.outputs.d ).toBeUndefined();
    } );

    it( 'does not treat prototype members as declared branches', async () =>
    {
        const workflow = new Workflow( 'proto' )
            .decision( 'd', {
                model    : scriptedModel( 'billing' ).model,
                questions,
                input    : 'x',
                branches : { billing : 'a' },
                route    : () => {return 'constructor' as 'billing';}
            } )
            .step( 'a', async () => {return 1;} );
        const result = await new WorkflowRunner( workflow ).execute();

        expect( result.status ).toBe( 'failed' );
        expect( ( result.error as AIError ).code ).toBe( 'WORKFLOW_UNKNOWN_BRANCH' );
    } );

    it( 'fails on a throwing input builder or routing function without a second model call', async () =>
    {
        const { model, decide } = scriptedModel( 'billing' );
        const failingRoute = new Workflow( 'r' )
            .decision( 'd', { model, questions, input : 'x', branches : { billing : 'a' }, route : () => {throw new Error( 'route broke' );} } )
            .step( 'a', async () => {return 1;} );
        const result = await new WorkflowRunner( failingRoute ).execute();

        expect( result.status ).toBe( 'failed' );
        expect( ( result.error as Error ).message ).toBe( 'route broke' );
        expect( decide ).toHaveBeenCalledTimes( 1 );

        const failingInput = new Workflow( 'i' )
            .decision( 'd', { model, questions, input : () => {throw new Error( 'input broke' );}, branches : { billing : 'a' }, route : () => {return 'billing';} } )
            .step( 'a', async () => {return 1;} );

        expect( ( await new WorkflowRunner( failingInput ).execute() ).error ).toMatchObject( { message : 'input broke' } );
    } );

    it( 'validates the definition early', () =>
    {
        const { model } = scriptedModel( 'billing' );
        const base = { model, questions, input : 'x', branches : { billing : 'a' }, route : () => {return 'billing' as const;} };

        expect( () => new Workflow( 'w' ).decision( 'd', { ...base, questions : {} } ) ).toThrow( /at least one question/ );
        expect( () => new Workflow( 'w' ).decision( 'd', { ...base, branches : {} as never } ) ).toThrow( /at least one branch/ );
        expect( () => new Workflow( 'w' ).decision( 'd', { ...base, questions : { x : { type : 'bad' } as never } } ) ).toThrow( /unknown type/ );
        expect( () => new Workflow( 'w' ).step( 'd', async () => {return 1;} ).decision( 'd', base ) ).toThrow( /already defined/ );

        const dangling = new Workflow( 'w' ).decision( 'd', { ...base, branches : { billing : 'missing' } } );

        expect( () => dangling.topologicalSort() ).toThrow( /undefined node 'missing'/ );
    } );

    it( 'saves answers in the checkpoint and does not ask again on resume (AE5, R19)', async () =>
    {
        const checkpointStore = new MemoryDocStore();
        const { model, decide } = scriptedModel( 'billing' );
        const log: string[] = [];
        const workflow = new Workflow( 'resume' )
            .decision( 'triage', { model, questions, input : 'ticket', branches : { billing : 'review', technical : 'techFlow' }, route : ( a: Answers ) => {return a.team.value;} } )
            .step( 'review', async () => {log.push( 'review' ); return 'r';} )
            .step( 'techFlow', async () => {log.push( 'technical' ); return 't';} )
            .wait( 'approval', { dependencies : [ 'review', 'techFlow' ], prompt : 'ok?' } )
            .step( 'publish', async () => {log.push( 'publish' ); return 'done';}, { dependencies : [ 'approval' ] } );
        const runner = new WorkflowRunner( workflow, { checkpointStore } );
        const first = await runner.execute( {}, 'run-1' );

        expect( first.status ).toBe( 'suspended' );
        expect( decide ).toHaveBeenCalledTimes( 1 );

        const saved = await checkpointStore.get<any>( 'workflow_checkpoints', 'run-1' );

        expect( saved.outputs.triage.answers.team.value ).toBe( 'billing' );
        expect( saved.skippedSteps ).toContain( 'techFlow' );

        const resumed = await new WorkflowRunner( workflow, { checkpointStore } ).resume( 'run-1', { waitId : 'approval', data : { ok : true } } );

        expect( resumed.status ).toBe( 'completed' );
        expect( decide ).toHaveBeenCalledTimes( 1 );
        expect( log ).toEqual( [ 'review', 'publish' ] );
        expect( ( resumed.outputs.triage as any ).branch ).toBe( 'billing' );
    } );

    it( 'emits step events for the decision', async () =>
    {
        const runner = new WorkflowRunner( buildWorkflow( scriptedModel( 'billing' ).model, [] ) );
        const types: string[] = [];

        runner.on( '*', ( event ) => {if( event.stepId === 'triage' ) {types.push( event.type );}} );
        await runner.execute();

        expect( types ).toEqual( [ 'step_start', 'step_complete' ] );
    } );

    it( 'swaps Jev for a language model by configuration only (F2)', async () =>
    {
        const originalFetch = globalThis.fetch;
        const structured = 
            {
                team   : { probabilities : { billing : 0.8, technical : 0.2 }, confidence : 0.7 },
                urgent : { probability : 0.4 }
            };
        const lm: LanguageModel = 
            {
                provider     : 'fake',
                model        : 'fake-1',
                capabilities : { ...NO_CAPABILITIES, structuredOutput : true },
                generate     : async () => {return { content : '', role : 'assistant', structured, finishReason : 'stop', raw : {}, usage : { promptTokens : 1, completionTokens : 1, totalTokens : 2 } } as never;},
                // eslint-disable-next-line require-yield
                async* stream() {throw new Error( 'unused' );}
            };

        vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( jsonResponse( {
            model   : 'jev-1.13.0',
            answers : {
                team   : { type : 'choice', choice : 'billing', probabilities : { billing : 0.9, technical : 0.1 }, confidence : 0.8 },
                urgent : { type : 'noul', noul : 0.4 }
            },
            usage : { input_tokens : 10, output_tokens : 2 }
        } ) ) );

        try
        {
            const outcomes: Array<{ calibrated : boolean, log : string[] }> = [];

            for( const model of [ new JevDecisionAdapter( { apiKey : 'k' } ), new LanguageModelDecisionAdapter( lm ) ] )
            {
                const log: string[] = [];
                const result = await new WorkflowRunner( buildWorkflow( model, log ) ).execute();

                expect( result.status ).toBe( 'completed' );
                outcomes.push( { calibrated : ( result.outputs.triage as any ).calibrated, log } );
            }

            expect( outcomes.map( ( o ) => {return o.log;} ) ).toEqual( [ [ 'billing', 'finish' ], [ 'billing', 'finish' ] ] );
            expect( outcomes.map( ( o ) => {return o.calibrated;} ) ).toEqual( [ true, false ] );
        }
        finally
        {
            globalThis.fetch = originalFetch;
        }
    } );

    it( 'records spend and a trace span for the decision call (R14)', async () =>
    {
        const originalFetch = globalThis.fetch;

        vi.stubGlobal( 'fetch', vi.fn().mockImplementation( async () => 
        {
            return jsonResponse( {
                model   : 'jev-1.13.0',
                answers : {
                    team   : { type : 'choice', choice : 'technical', probabilities : { billing : 0.1, technical : 0.9 }, confidence : 0.8 },
                    urgent : { type : 'noul', noul : 0.4 }
                },
                usage : { input_tokens : 1_000_000, output_tokens : 50 }
            } );
        } ) );

        try
        {
            const tracker = new SpendTracker();
            const context = new SimpleExecutionContext( { tracker } );
            let root: any;

            await context.withSpan( 'run', async ( span, ctx ) =>
            {
                root = span;

                return new WorkflowRunner( buildWorkflow( new JevDecisionAdapter( { apiKey : 'k' } ), [] ), { context : ctx, tracker } ).execute();
            } );

            const span = root.children[ 0 ];

            expect( span.name ).toBe( 'workflow:decision:triage' );
            expect( span.attributes['workflow.stepId'] ).toBe( 'triage' );
            expect( tracker.totalSpendUSD ).toBeCloseTo( 0.042, 6 );

            // Tracker alone (no trace context) still meters.
            const tracker2 = new SpendTracker();

            const metered = await new WorkflowRunner( buildWorkflow( new JevDecisionAdapter( { apiKey : 'k' } ), [] ), { tracker : tracker2 } ).execute();

            expect( metered.status ).toBe( 'completed' );
            expect( tracker2.totalSpendUSD ).toBeCloseTo( 0.042, 6 );
        }
        finally
        {
            globalThis.fetch = originalFetch;
        }
    } );
} );

describe( 'decision step retries (AE6, R20)', () =>
{
    const originalFetch = globalThis.fetch;

    beforeEach( () =>
    {
        vi.useFakeTimers();
    } );

    afterEach( () =>
    {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    } );

    it( 'fails after 3 attempts when Jev keeps failing and never calls a language model', async () =>
    {
        const fetchMock = vi.fn().mockImplementation( async () => {return jsonResponse( { error : { message : 'down' } }, { status : 503 } );} );
        const generate = vi.fn();

        vi.stubGlobal( 'fetch', fetchMock );

        const lm: LanguageModel = { provider : 'fake', model : 'fake', capabilities : { ...NO_CAPABILITIES, structuredOutput : true }, generate : generate as never, stream : vi.fn() as never };
        void lm;

        const log: string[] = [];
        const promise = new WorkflowRunner( buildWorkflow( new JevDecisionAdapter( { apiKey : 'k' } ), log, { retries : 2 } ) ).execute();

        await vi.runAllTimersAsync();

        const result = await promise;

        expect( result.status ).toBe( 'failed' );
        expect( fetchMock ).toHaveBeenCalledTimes( 3 );
        expect( generate ).not.toHaveBeenCalled();
        expect( log ).toEqual( [] );
        expect( result.error ).toMatchObject( { statusCode : 503 } );
    } );

    it( 'recovers when a later attempt succeeds', async () =>
    {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce( jsonResponse( { error : { message : 'down' } }, { status : 503 } ) )
            .mockResolvedValueOnce( jsonResponse( {
                answers : {
                    team   : { type : 'choice', choice : 'billing', probabilities : { billing : 1, technical : 0 }, confidence : 1 },
                    urgent : { type : 'noul', noul : 0 }
                }
            } ) );

        vi.stubGlobal( 'fetch', fetchMock );

        const log: string[] = [];
        const promise = new WorkflowRunner( buildWorkflow( new JevDecisionAdapter( { apiKey : 'k' } ), log, { retries : 1 } ) ).execute();

        await vi.runAllTimersAsync();

        const result = await promise;

        expect( result.status ).toBe( 'completed' );
        expect( fetchMock ).toHaveBeenCalledTimes( 2 );
        expect( log ).toEqual( [ 'billing', 'finish' ] );
    } );

    it( 'does not retry when retries is 0', async () =>
    {
        const fetchMock = vi.fn().mockImplementation( async () => {return jsonResponse( { error : { message : 'down' } }, { status : 503 } );} );

        vi.stubGlobal( 'fetch', fetchMock );

        const result = await new WorkflowRunner( buildWorkflow( new JevDecisionAdapter( { apiKey : 'k' } ), [] ) ).execute();

        expect( result.status ).toBe( 'failed' );
        expect( fetchMock ).toHaveBeenCalledTimes( 1 );
    } );
} );
