import { describe, it, expect, vi } from 'vitest';
import { 
    calculateSpend, 
    SpendCalculator,
    SpendTracker, 
    PricingRegistry,
    defaultPricingRegistry
} from '../../src/spend/index.js';
import { BudgetRefusedError } from '../../src/core/error.js';
import type { UsageMetrics } from '../../src/core/types.js';
import { createMeteredModel } from '../../src/providers/metered.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelResponse } from '../../src/core/types.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import { SpanImpl } from '../../src/trace/span.js';

const tinyUsage = ( tokens = 1_000 ): UsageMetrics => 
{
    return {
        promptTokens     : tokens,
        completionTokens : tokens,
        totalTokens      : tokens * 2
    };
};

describe( 'Pricing identity & spend reliability (U4)', () => 
{
    it( 'uses dated mini price not sibling gpt-4o (AE8)', () => 
    {
        const mini = calculateSpend( 'gpt-4o-mini-2024-07-18', tinyUsage() );
        const baseMini = calculateSpend( 'gpt-4o-mini', tinyUsage() );
        const gpt4o = calculateSpend( 'gpt-4o', tinyUsage() );

        expect( mini.totalCost ).toBeCloseTo( baseMini.totalCost, 8 );
        expect( mini.totalCost ).not.toBeCloseTo( gpt4o.totalCost, 8 );
        expect( mini.unpriced ).toBeUndefined();
    } );

    it( 'does not match unlisted siblings like o1-pro to o1 (AE8)', () => 
    {
        const result = calculateSpend( 'o1-pro', tinyUsage() );

        expect( result.unpriced ).toBe( true );
        expect( result.totalCost ).toBe( 0 );
    } );

    it( 'marks unpriced usage with a warning when no model budget (AE9)', () => 
    {
        const tracker = new SpendTracker();
        const warnings: Array<{ code: string }> = [];

        tracker.on( 'warning', ( e ) => 
        {
            warnings.push( e );
        } );

        const details = tracker.record( 'totally-unknown-model', tinyUsage(), {
            provider : 'openai'
        } );

        expect( details.unpriced ).toBe( true );
        expect( warnings.some( ( w ) => {return w.code === 'unpriced_usage';} ) ).toBe( true );
    } );

    it( 'refuses unpriced model calls when a model budget cap is set (AE9)', async () => 
    {
        const tracker = new SpendTracker( {
            categoryBudgets : { model : 1.0 }
        } );

        const inner: ModelProtocol = {
            provider : 'openai',
            model    : 'mystery-model',
            async generate(): Promise<ModelResponse>
            {
                return { content : 'nope', role : 'assistant', finishReason : 'stop', raw : {} };
            },
            async* stream()
            {
                yield* [];
            }
        };

        const metered = createMeteredModel( inner, { tracker } );

        await expect( metered.generate( { messages : [ { role : 'user', content : 'hi' } ] } ) )
            .rejects
            .toThrow( BudgetRefusedError );

        // Storage under the same cap still proceeds.
        tracker.recordCategorySpend( { category : 'storage', costUSD : 0.5 } );
        expect( tracker.getCategorySpend( 'storage' ) ).toBe( 0.5 );
    } );

    it( 'refuses further model calls after the model budget is exhausted (AE10)', async () => 
    {
        const tracker = new SpendTracker( {
            categoryBudgets : { model : 0.001 }
        } );

        tracker.record( 'gpt-4o', {
            promptTokens     : 1_000_000,
            completionTokens : 0,
            totalTokens      : 1_000_000
        }, { provider : 'openai' } );

        expect( tracker.getCategorySpend( 'model' ) ).toBeGreaterThanOrEqual( 0.001 );

        const inner: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                throw new Error( 'should not be called' );
            },
            async* stream()
            {
                yield* [];
            }
        };

        const metered = createMeteredModel( inner, { tracker } );
        const err = await metered.generate( { messages : [ { role : 'user', content : 'hi' } ] } )
            .then( () => {throw new Error( 'expected refuse' );} )
            .catch( ( e: unknown ) => {return e;} );

        expect( err ).toBeInstanceOf( BudgetRefusedError );
        expect( ( err as BudgetRefusedError ).reason ).toBe( 'exhausted' );
    } );

    it( 'returns the crossing call then refuses the next (AE12)', async () => 
    {
        const tracker = new SpendTracker( {
            categoryBudgets : { model : 1.0 }
        } );
        const warnings: Array<{ code: string }> = [];

        tracker.on( 'warning', ( e ) => 
        {
            warnings.push( e );
        } );

        // Seed ~$0.50 under a $1 model cap (gpt-4o input $2.50/M).
        tracker.record( 'gpt-4o', {
            promptTokens     : 200_000,
            completionTokens : 0,
            totalTokens      : 200_000
        }, { provider : 'openai' } );

        expect( tracker.getCategorySpend( 'model' ) ).toBeCloseTo( 0.5, 4 );

        let calls = 0;
        const inner: ModelProtocol = {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                calls++;

                return {
                    content      : 'crossed',
                    role         : 'assistant',
                    finishReason : 'stop',
                    usage        : {
                        promptTokens     : 400_000,
                        completionTokens : 0,
                        totalTokens      : 400_000
                    },
                    raw : {}
                };
            },
            async* stream()
            {
                yield* [];
            }
        };

        const metered = createMeteredModel( inner, { tracker } );
        const res = await metered.generate( { messages : [ { role : 'user', content : 'hi' } ] } );

        expect( res.content ).toBe( 'crossed' );
        expect( calls ).toBe( 1 );
        expect( tracker.getCategorySpend( 'model' ) ).toBeGreaterThan( 1.0 );
        expect( warnings.some( ( w ) => {return w.code === 'budget_exceeded';} ) ).toBe( true );

        await expect( metered.generate( { messages : [ { role : 'user', content : 'again' } ] } ) )
            .rejects
            .toMatchObject( { reason : 'exhausted' } );
        expect( calls ).toBe( 1 );
    } );

    it( 'treats default Ollama as free and custom baseUrl as unpriced (R50)', () => 
    {
        const free = calculateSpend( 'llama3', tinyUsage(), undefined, {
            provider : 'ollama'
        } );
        expect( free.free ).toBe( true );
        expect( free.totalCost ).toBe( 0 );

        const custom = calculateSpend( 'llama3', tinyUsage(), undefined, {
            provider : 'ollama',
            baseUrl  : 'https://remote.ollama.example'
        } );
        expect( custom.unpriced ).toBe( true );
    } );

    it( 'bills Gemini cached tokens once and adds thoughts to output (R26/R27)', () => 
    {
        const usage: UsageMetrics = {
            promptTokens           : 2_000,
            completionTokens       : 100,
            totalTokens            : 2_200,
            cachedPromptReadTokens : 1_500,
            reasoningTokens        : 50,
            raw                    : {
                promptTokenCount        : 2_000,
                candidatesTokenCount    : 100,
                cachedContentTokenCount : 1_500,
                thoughtsTokenCount      : 50
            }
        };

        const result = calculateSpend( 'gemini-2.5-flash', usage, undefined, {
            provider : 'gemini'
        } );

        // uncached 500 * 0.15 / 1M + cached 1500 * 0.0375 / 1M + output (100+50) * 0.60 / 1M
        expect( result.inputCost ).toBeCloseTo( 500 * 0.15 / 1_000_000, 8 );
        expect( result.cacheReadCost ).toBeCloseTo( 1_500 * 0.0375 / 1_000_000, 8 );
        expect( result.outputCost ).toBeCloseTo( 150 * 0.60 / 1_000_000, 8 );
    } );

    it( 'does not double-bill OpenAI reasoning tokens already in completion (R27)', () => 
    {
        const registry = new PricingRegistry();
        registry.register( 'openai:o1-test', {
            provider            : 'openai',
            inputPerMillion     : 1,
            outputPerMillion    : 1,
            reasoningPerMillion : 10
        } );

        const calc = new SpendCalculator( registry );
        const usage: UsageMetrics = {
            promptTokens     : 0,
            completionTokens : 100,
            totalTokens      : 100,
            reasoningTokens  : 40,
            raw              : {
                completion_tokens         : 100,
                completion_tokens_details : { reasoning_tokens : 40 }
            }
        };

        const result = calc.calculate( 'o1-test', usage, undefined, { provider : 'openai' } );

        expect( result.outputCost ).toBeCloseTo( 100 / 1_000_000, 8 );
        expect( result.reasoningCost ).toBeUndefined();
    } );

    it( 'keeps span units-only spend aligned with the tracker (R28)', () => 
    {
        const tracker = new SpendTracker();
        const span = new SpanImpl( 'tool' );
        const ctx = new SimpleExecutionContext( {
            tracker,
            activeSpan : span
        } );

        ctx.reportSpend( {
            category    : 'tools',
            subcategory : 'call',
            units       : 10,
            unitType    : 'call'
        } );

        expect( tracker.getCategorySpend( 'tools' ) ).toBeCloseTo( 0.001, 6 );
        expect( span.spendUSD ).toBeCloseTo( 0.001, 6 );
    } );
} );

describe( 'MeteredModel', () => 
{
    it( 'forwards generate after preflight and records usage', async () => 
    {
        const tracker = new SpendTracker();
        const generate = vi.fn().mockResolvedValue( {
            content      : 'ok',
            role         : 'assistant',
            finishReason : 'stop',
            usage        : tinyUsage( 1_000 ),
            raw          : {}
        } satisfies ModelResponse );

        const metered = createMeteredModel( {
            provider : 'openai',
            model    : 'gpt-4o-mini',
            generate,
            async* stream()
            {
                yield* [];
            }
        }, { tracker } );

        const res = await metered.generate( { messages : [ { role : 'user', content : 'hi' } ] } );

        expect( res.content ).toBe( 'ok' );
        expect( generate ).toHaveBeenCalledOnce();
        expect( tracker.records ).toHaveLength( 1 );
        expect( tracker.records[0].provider ).toBe( 'openai' );
    } );

    it( 'records a spend gap when usage is missing (R57)', async () => 
    {
        const tracker = new SpendTracker();
        const warnings: Array<{ code: string }> = [];

        tracker.on( 'warning', ( e ) => 
        {
            warnings.push( e );
        } );

        const metered = createMeteredModel( {
            provider : 'openai',
            model    : 'gpt-4o',
            async generate(): Promise<ModelResponse>
            {
                return {
                    content      : 'bridged',
                    role         : 'assistant',
                    finishReason : 'stop',
                    usageMissing : true,
                    raw          : {}
                };
            },
            async* stream()
            {
                yield* [];
            }
        }, { tracker } );

        await metered.generate( { messages : [ { role : 'user', content : 'hi' } ] } );

        expect( tracker.records ).toHaveLength( 0 );
        expect( warnings.some( ( w ) => {return w.code === 'spend_gap';} ) ).toBe( true );
    } );
} );

describe( 'defaultPricingRegistry snapshot/date matching', () => 
{
    it( 'resolves provider-aware keys', () => 
    {
        const priced = defaultPricingRegistry.resolve( {
            provider : 'openai',
            model    : 'gpt-4o'
        } );

        expect( priced.status ).toBe( 'priced' );
    } );
} );
