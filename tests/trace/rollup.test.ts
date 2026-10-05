import { describe, it, expect } from 'vitest';
import { SpanImpl } from '../../src/trace/span.js';
import { computeSpanRollup, computeTraceRollup } from '../../src/trace/rollup.js';
import type { Trace } from '../../src/trace/types.js';

describe( 'Recursive Rollup Engine (U3)', () => 
{
    it( 'computes rollup for a single leaf span', () => 
    {
        const leaf = new SpanImpl( 'leaf', { kind : 'model' } );
        leaf.recordSpend( { category : 'model', costUSD : 0.005 } );
        leaf.recordMetric( 'promptTokens', 100 );
        leaf.recordMetric( 'completionTokens', 50 );
        leaf.end( leaf.startTime + 80 );

        const rollup = computeSpanRollup( leaf );

        expect( rollup.totalSpendUSD ).toBe( 0.005 );
        expect( rollup.categorySpend.model ).toBe( 0.005 );
        expect( rollup.categorySpend.storage ).toBe( 0 );
        expect( rollup.metrics.promptTokens ).toBe( 100 );
        expect( rollup.metrics.completionTokens ).toBe( 50 );
        expect( rollup.metrics.subcallCount ).toBe( 0 );
        expect( rollup.totalDurationMs ).toBe( 80 );
        expect( leaf.rollup ).toEqual( rollup );
    } );

    it( 'verifies nested subcall rollup (Acceptance Example AE1)', () => 
    {
        // AE1: A parent span tool:analyze_doc that executes 2 subcalls:
        // vector search ($0.0001, 15ms) and LLM summary ($0.003, 120ms)
        const parent = new SpanImpl( 'tool:analyze_doc', { kind : 'tool' } );

        const vectorSearch = new SpanImpl( 'storage:vector_search', { kind : 'storage' } );
        vectorSearch.recordSpend( { category : 'storage', costUSD : 0.0001 } );
        vectorSearch.end( vectorSearch.startTime + 15 );

        const llmSummary = new SpanImpl( 'model:summary', { kind : 'model' } );
        llmSummary.recordSpend( { category : 'model', costUSD : 0.003 } );
        llmSummary.recordMetric( 'promptTokens', 200 );
        llmSummary.recordMetric( 'completionTokens', 80 );
        llmSummary.end( llmSummary.startTime + 120 );

        parent.addChild( vectorSearch );
        parent.addChild( llmSummary );
        parent.end( parent.startTime + 140 );

        const rollup = computeSpanRollup( parent );

        // Self spend of parent is 0, total rolled-up spend is 0.0031
        expect( parent.spendUSD ).toBe( 0 );
        expect( rollup.totalSpendUSD ).toBeCloseTo( 0.0031, 6 );
        expect( rollup.categorySpend.storage ).toBeCloseTo( 0.0001, 6 );
        expect( rollup.categorySpend.model ).toBeCloseTo( 0.003, 6 );
        expect( rollup.metrics.subcallCount ).toBe( 2 );
        expect( rollup.metrics.promptTokens ).toBe( 200 );
        expect( rollup.metrics.completionTokens ).toBe( 80 );
        expect( rollup.totalDurationMs ).toBe( 140 );
    } );

    it( 'handles deeply nested multi-level trees with branching', () => 
    {
        // Root -> Step -> Tool -> (DB Query, Sub LLM)
        const root = new SpanImpl( 'agent:run', { kind : 'agent' } );
        const step = new SpanImpl( 'agent:step:1', { kind : 'agent' } );
        const tool = new SpanImpl( 'tool:complex_workflow', { kind : 'tool' } );
        const dbQuery = new SpanImpl( 'db:query', { kind : 'storage' } );
        const subLLM = new SpanImpl( 'model:sub', { kind : 'model' } );

        root.addChild( step );
        step.addChild( tool );
        tool.addChild( dbQuery );
        tool.addChild( subLLM );

        // Parent step has local compute cost
        step.recordSpend( { category : 'compute', costUSD : 0.0005 } );

        // DB query has storage cost and bytes
        dbQuery.recordSpend( { category : 'storage', costUSD : 0.001 } );
        dbQuery.recordMetric( 'bytes', 4096 );
        dbQuery.end();

        // Sub LLM has model cost and tokens
        subLLM.recordSpend( { category : 'model', costUSD : 0.015 } );
        subLLM.recordMetric( 'promptTokens', 500 );
        subLLM.recordMetric( 'completionTokens', 250 );
        subLLM.end();

        tool.end();
        step.end();
        root.end();

        const rootRollup = computeSpanRollup( root );

        expect( rootRollup.totalSpendUSD ).toBeCloseTo( 0.0165, 6 );
        expect( rootRollup.categorySpend.storage ).toBeCloseTo( 0.001, 6 );
        expect( rootRollup.categorySpend.model ).toBeCloseTo( 0.015, 6 );
        expect( rootRollup.categorySpend.compute ).toBeCloseTo( 0.0005, 6 );
        expect( rootRollup.metrics.subcallCount ).toBe( 4 );
        expect( rootRollup.metrics.bytes ).toBe( 4096 );
        expect( rootRollup.metrics.promptTokens ).toBe( 500 );
        expect( rootRollup.metrics.completionTokens ).toBe( 250 );

        // Tool rollup isolated
        expect( tool.rollup?.totalSpendUSD ).toBeCloseTo( 0.016, 6 );
        expect( tool.rollup?.metrics.subcallCount ).toBe( 2 );
    } );

    it( 'computes trace level rollup via computeTraceRollup', () => 
    {
        const root = new SpanImpl( 'root', { kind : 'agent' } );
        const child = new SpanImpl( 'child', { kind : 'tool' } );
        child.recordSpend( { category : 'tools', costUSD : 0.02 } );
        child.end( child.startTime + 50 );
        root.addChild( child );
        root.end( root.startTime + 60 );

        const trace: Trace = 
        {
            traceId       : root.traceId,
            startTime     : root.startTime,
            endTime       : root.endTime,
            durationMs    : root.durationMs,
            rootSpan      : root,
            totalSpendUSD : 0,
            categorySpend : {
                model   : 0,
                storage : 0,
                compute : 0,
                network : 0,
                mcp     : 0,
                tools   : 0,
                custom  : 0
            }
        };

        const rolledUpTrace = computeTraceRollup( trace );

        expect( rolledUpTrace.totalSpendUSD ).toBe( 0.02 );
        expect( rolledUpTrace.categorySpend.tools ).toBe( 0.02 );
        expect( rolledUpTrace.rootSpan.rollup?.totalSpendUSD ).toBe( 0.02 );
    } );
} );
