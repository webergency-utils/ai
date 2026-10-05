import { describe, it, expect } from 'vitest';
import { 
    calculateSpend, 
    SpendCalculator, 
    PricingRegistry, 
    SpendTracker 
} from '../../src/spend/index.js';
import type { UsageMetrics } from '../../src/core/types.js';

describe( 'Spend Calculator & Pricing Engine', () => 
{
    it( 'should calculate cost for standard GPT-4o usage', () => 
    {
        const usage: UsageMetrics = 
            {
                promptTokens     : 1_000,
                completionTokens : 500,
                totalTokens      : 1_500
            };

        const result = calculateSpend( 'gpt-4o', usage );

        // gpt-4o: $2.50/M input, $10.00/M output
        // input: 1000 * 2.50 / 1M = 0.0025
        // output: 500 * 10.00 / 1M = 0.0050
        // total: 0.0075
        expect( result.inputCost ).toBeCloseTo( 0.0025, 6 );
        expect( result.outputCost ).toBeCloseTo( 0.0050, 6 );
        expect( result.totalCost ).toBeCloseTo( 0.0075, 6 );
        expect( result.currency ).toBe( 'USD' );
    } );

    it( 'should apply prompt caching discounts for Claude 3.7 usage', () => 
    {
        const usage: UsageMetrics = 
            {
                promptTokens            : 400,
                completionTokens        : 100,
                totalTokens             : 500,
                cachedPromptReadTokens  : 1_600,
                cachedPromptWriteTokens : 200,
                raw : 
            {
                input_tokens                : 400,
                cache_read_input_tokens     : 1_600,
                cache_creation_input_tokens : 200
            }
            };

        const result = calculateSpend( 'claude-3-7-sonnet-20250219', usage );

        // claude-3-7-sonnet:
        // input: $3.00/M -> 400 * 3 / 1M = 0.0012
        // output: $15.00/M -> 100 * 15 / 1M = 0.0015
        // cache read: $0.30/M -> 1600 * 0.30 / 1M = 0.00048
        // cache write: $3.75/M -> 200 * 3.75 / 1M = 0.00075
        // total: 0.0012 + 0.0015 + 0.00048 + 0.00075 = 0.00393
        expect( result.inputCost ).toBeCloseTo( 0.0012, 6 );
        expect( result.outputCost ).toBeCloseTo( 0.0015, 6 );
        expect( result.cacheReadCost ).toBeCloseTo( 0.00048, 6 );
        expect( result.cacheWriteCost ).toBeCloseTo( 0.00075, 6 );
        expect( result.totalCost ).toBeCloseTo( 0.00393, 6 );
    } );

    it( 'should handle OpenAI cached tokens embedded in promptTokens', () => 
    {
        const usage: UsageMetrics = 
            {
                promptTokens           : 2_000, // includes 1,500 cached
                completionTokens       : 500,
                totalTokens            : 2_500,
                cachedPromptReadTokens : 1_500,
                raw : 
            {
                prompt_tokens         : 2000,
                prompt_tokens_details : { cached_tokens : 1500 }
            }
            };

        const result = calculateSpend( 'gpt-4o', usage );

        // uncached: 500 * $2.50 / 1M = 0.00125
        // cached: 1500 * $1.25 / 1M = 0.001875
        // output: 500 * $10.00 / 1M = 0.005
        // total: 0.00125 + 0.001875 + 0.005 = 0.008125
        expect( result.inputCost ).toBeCloseTo( 0.00125, 6 );
        expect( result.cacheReadCost ).toBeCloseTo( 0.001875, 6 );
        expect( result.outputCost ).toBeCloseTo( 0.005, 6 );
        expect( result.totalCost ).toBeCloseTo( 0.008125, 6 );
    } );

    it( 'should support custom pricing overrides and registries', () => 
    {
        const registry = new PricingRegistry();
        registry.register( 'my-custom-model', 
            {
                inputPerMillion  : 10.00,
                outputPerMillion : 20.00
            } );

        const calc = new SpendCalculator( registry );
        const res = calc.calculate( 'my-custom-model', {
            promptTokens     : 1_000_000,
            completionTokens : 1_000_000,
            totalTokens      : 2_000_000
        } );

        expect( res.inputCost ).toBe( 10.00 );
        expect( res.outputCost ).toBe( 20.00 );
        expect( res.totalCost ).toBe( 30.00 );
    } );

    it( 'should track accumulated spend and warn when budget is crossed (R49)', () => 
    {
        const tracker = new SpendTracker( { maxBudgetUSD : 0.01 } );
        const warnings: Array<{ code: string }> = [];

        tracker.on( 'warning', ( e ) => 
        {
            warnings.push( e );
        } );

        const call1 = tracker.record( 'gpt-4o-mini', 
            {
                promptTokens     : 10_000,
                completionTokens : 5_000,
                totalTokens      : 15_000
            } );

        expect( tracker.totalSpendUSD ).toBeCloseTo( call1.totalCost, 6 );
        expect( tracker.records ).toHaveLength( 1 );

        // Crossing the cap records spend and warns — does not throw (R32/R49).
        const call2 = tracker.record( 'gpt-4o', 
            {
                promptTokens     : 100_000,
                completionTokens : 50_000,
                totalTokens      : 150_000
            } );

        expect( call2.totalCost ).toBeGreaterThan( 0 );
        expect( tracker.totalSpendUSD ).toBeGreaterThan( 0.01 );
        expect( warnings.some( ( w ) => {return w.code === 'budget_exceeded';} ) ).toBe( true );
    } );

    it( 'should manage isolated thread trackers', () => 
    {
        const tracker = new SpendTracker();
        const thread1 = tracker.getThreadTracker( 'thread-1' );
        const thread2 = tracker.getThreadTracker( 'thread-2' );

        thread1.record( 'gpt-4o', { promptTokens : 1_000, completionTokens : 500, totalTokens : 1_500 } );

        expect( thread1.totalSpendUSD ).toBeGreaterThan( 0 );
        expect( thread2.totalSpendUSD ).toBe( 0 );
    } );
} );
