import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JevDecisionAdapter, MeteredDecisionModel, createMeteredDecisionModel } from '../../src/providers/index.js';
import { decideWithContext, SimpleExecutionContext } from '../../src/agent/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { BudgetRefusedError, question, type DecisionModel } from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

const questions = { ok : question.yesNo() };
const body = ( usage?: unknown ): unknown => {return { model : 'jev-1.13.0', answers : { ok : { type : 'noul', noul : 0.8 } }, ...( usage ? { usage } : {} ) };};

describe( 'decision spend and traces (R14)', () =>
{
    const originalFetch = globalThis.fetch;

    beforeEach( () =>
    {
        vi.stubGlobal( 'fetch', vi.fn() );
    } );

    afterEach( () =>
    {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    } );

    it( 'prices Jev on input tokens only; output tokens are free', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( body( { input_tokens : 1_000_000, output_tokens : 5_000_000 } ) ) );

        const tracker = new SpendTracker();
        const model = createMeteredDecisionModel( new JevDecisionAdapter( { apiKey : 'k' } ), { tracker } );

        expect( model ).toBeInstanceOf( MeteredDecisionModel );
        expect( model.provider ).toBe( 'typesafe' );
        expect( model.inner ).toBeInstanceOf( JevDecisionAdapter );

        await model.decide( { input : 'x', questions } );

        expect( tracker.totalSpendUSD ).toBeCloseTo( 0.042, 6 );
        expect( tracker.records[ 0 ].unpriced ).toBeFalsy();
    } );

    it( 'prices pinned Jev versions via the wildcard entry', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( body( { input_tokens : 1_000_000, output_tokens : 10 } ) ) );

        const tracker = new SpendTracker();

        await new MeteredDecisionModel( new JevDecisionAdapter( { apiKey : 'k', model : 'jev-1.13.0' } ), { tracker } )
            .decide( { input : 'x', questions } );

        expect( tracker.totalSpendUSD ).toBeCloseTo( 0.042, 6 );
    } );

    it( 'records a spend gap, never zero cost, when usage is missing', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( body() ) );

        const tracker = new SpendTracker();
        const warnings: string[] = [];

        tracker.on( 'warning', ( w ) => {warnings.push( w.code );} );

        await new MeteredDecisionModel( new JevDecisionAdapter( { apiKey : 'k' } ), { tracker } ).decide( { input : 'x', questions } );

        expect( tracker.records ).toHaveLength( 0 );
        expect( warnings ).toContain( 'spend_gap' );
    } );

    it( 'records retry gaps and observes the caller onAttempt', async () =>
    {
        vi.mocked( fetch )
            .mockResolvedValueOnce( jsonResponse( { error : { message : 'busy' } }, { status : 429, headers : { 'retry-after-ms' : '1' } } ) )
            .mockResolvedValueOnce( jsonResponse( body( { input_tokens : 10, output_tokens : 1 } ) ) );

        const tracker = new SpendTracker();
        const gaps: string[] = [];
        const attempts: number[] = [];

        tracker.on( 'warning', ( w ) => {gaps.push( w.message );} );

        await new MeteredDecisionModel( new JevDecisionAdapter( { apiKey : 'k' } ), { tracker } )
            .decide( { input : 'x', questions, onAttempt : ( info ) => {attempts.push( info.attempt );} } );

        expect( gaps.some( ( m ) => {return m.includes( 'Retry attempt 2/3' );} ) ).toBe( true );
        expect( attempts ).toContain( 2 );
    } );

    it( 'refuses calls once the model budget is exhausted', async () =>
    {
        const tracker = new SpendTracker( { categoryBudgets : { model : 0.00001 } } );

        tracker.record( 'jev-latest', { promptTokens : 100_000_000, completionTokens : 0, totalTokens : 100_000_000 }, { provider : 'typesafe' } );

        const inner: DecisionModel = { provider : 'typesafe', model : 'jev-latest', decide : vi.fn() as never };

        await expect( new MeteredDecisionModel( inner, { tracker } ).decide( { input : 'x', questions } ) ).rejects.toBeInstanceOf( BudgetRefusedError );
        expect( inner.decide ).not.toHaveBeenCalled();
    } );

    it( 'appears in traces as a model span with spend and metrics', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( body( { input_tokens: 2_000_000, output_tokens : 100 } ) ) );

        const tracker = new SpendTracker();
        const root = new SimpleExecutionContext( { tracker } );
        let rootSpan: any;
        let childSpan: any;

        await root.withSpan( 'run', async ( span, ctx ) =>
        {
            rootSpan = span;

            const res = await decideWithContext( ctx, new JevDecisionAdapter( { apiKey : 'k' } ), { input : 'x', questions }, { tracker } );

            childSpan = span.children[ 0 ];

            return res;
        } );

        expect( childSpan.name ).toBe( 'model:decide' );
        expect( childSpan.kind ).toBe( 'model' );
        expect( childSpan.attributes ).toMatchObject( { 'model.provider' : 'typesafe', 'model.name' : 'jev-latest', 'decision.calibrated' : true, 'decision.questions' : 1 } );
        expect( childSpan.metrics ).toMatchObject( { promptTokens : 2_000_000, completionTokens : 100 } );
        expect( childSpan.categorySpend.model ).toBeCloseTo( 0.084, 6 );
        expect( rootSpan.children ).toHaveLength( 1 );
    } );

    it( 'marks the span as failed when the decision call fails', async () =>
    {
        vi.mocked( fetch ).mockResolvedValue( jsonResponse( { error : { message : 'boom' } }, { status : 400 } ) );

        const ctx = new SimpleExecutionContext();
        let span: any;

        await expect( ctx.withSpan( 'run', async ( s, c ) => 
        {
            span = s;

            return decideWithContext( c, new JevDecisionAdapter( { apiKey : 'k' } ), { input : 'x', questions }, { name : 'custom' } );
        } ) ).rejects.toThrow( /boom/ );

        expect( span.children[ 0 ].name ).toBe( 'custom' );
        expect( span.children[ 0 ].status ).toBe( 'error' );
    } );
} );
