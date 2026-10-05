import { describe, it, expect, vi } from 'vitest';
import { TraceCollector } from '../../src/trace/collector.js';
import { SpanImpl } from '../../src/trace/span.js';
import type { Span, Trace } from '../../src/trace/types.js';

describe( 'TraceCollector & Real-Time Event Bus (U5)', () => 
{
    it( 'emits real-time span:start and span:end events during execution (Flow F2)', async () => 
    {
        const collector = new TraceCollector();

        const startEvents: Span[] = [];
        const endEvents: Span[] = [];
        let completedTrace: Trace | undefined;

        collector.on( 'span:start', ( span ) => 
        {
            startEvents.push( span );
        } );

        collector.on( 'span:end', ( span ) => 
        {
            endEvents.push( span );
        } );

        collector.on( 'trace:complete', ( trace ) => 
        {
            completedTrace = trace;
        } );

        // Start trace via collector
        const { trace, rootSpan, context } = collector.startTrace( {
            name     : 'agent:run',
            threadId : 'th_1',
            agentId  : 'ag_main'
        } );

        expect( startEvents ).toHaveLength( 1 );
        expect( startEvents[0]?.id ).toBe( rootSpan.id );

        // Execute child operations with context
        await context.withSpan( 'tool:search', async ( toolSpan, toolCtx ) => 
        {
            expect( startEvents ).toHaveLength( 2 );
            expect( startEvents[1]?.id ).toBe( toolSpan.id );

            toolCtx.reportSpend( { category : 'tools', costUSD : 0.005 } );

            await toolCtx.withSpan( 'http:fetch', async ( httpSpan ) => 
            {
                expect( startEvents ).toHaveLength( 3 );
                httpSpan.setAttribute( 'http.status', 200 );
            } );

            // http:fetch ended
            expect( endEvents ).toHaveLength( 1 );
            expect( endEvents[0]?.name ).toBe( 'http:fetch' );
        } );

        // tool:search ended
        expect( endEvents ).toHaveLength( 2 );
        expect( endEvents[1]?.name ).toBe( 'tool:search' );

        // End root trace
        collector.endTrace( trace.traceId );

        // trace:complete emitted
        expect( completedTrace ).toBeDefined();
        expect( completedTrace?.traceId ).toBe( trace.traceId );
        expect( completedTrace?.totalSpendUSD ).toBeCloseTo( 0.005, 4 );
        expect( completedTrace?.rootSpan.rollup?.metrics.subcallCount ).toBe( 2 );
    } );

    it( 'stores completed traces in-memory and allows querying by traceId', () => 
    {
        const collector = new TraceCollector();

        const root = new SpanImpl( 'root_op' );
        root.recordSpend( { category : 'model', costUSD : 0.01 } );
        root.end();

        const trace: Trace = 
        {
            traceId       : root.traceId,
            threadId      : 'thread_abc',
            agentId       : 'agent_xyz',
            startTime     : root.startTime,
            endTime       : root.endTime,
            durationMs    : root.durationMs,
            rootSpan      : root,
            totalSpendUSD : root.spendUSD,
            categorySpend : root.categorySpend
        };

        collector.recordCompletedTrace( trace );

        const retrieved = collector.getTrace( trace.traceId );
        expect( retrieved ).toBeDefined();
        expect( retrieved?.traceId ).toBe( trace.traceId );
        expect( retrieved?.threadId ).toBe( 'thread_abc' );
        expect( retrieved?.totalSpendUSD ).toBe( 0.01 );
    } );

    it( 'enforces LRU capacity limit and evicts oldest traces', () => 
    {
        const collector = new TraceCollector( { maxTraces : 3 } );

        for( let i = 1; i <= 5; i++ )
        {
            const root = new SpanImpl( `root_${i}` );
            root.end();
            collector.recordCompletedTrace( {
                traceId       : `trace_${i}`,
                startTime     : i * 1000,
                rootSpan      : root,
                totalSpendUSD : 0,
                categorySpend : root.categorySpend
            } );
        }

        // Capacity is 3, so trace_1 and trace_2 should be evicted
        expect( collector.getTrace( 'trace_1' ) ).toBeUndefined();
        expect( collector.getTrace( 'trace_2' ) ).toBeUndefined();
        expect( collector.getTrace( 'trace_3' ) ).toBeDefined();
        expect( collector.getTrace( 'trace_4' ) ).toBeDefined();
        expect( collector.getTrace( 'trace_5' ) ).toBeDefined();
    } );

    it( 'filters traces using query parameters', () => 
    {
        const collector = new TraceCollector();

        for( let i = 1; i <= 6; i++ )
        {
            const root = new SpanImpl( `root_${i}`, {
                status : i % 2 === 0 ? 'error' : 'ok'
            } );
            root.end( root.startTime + i * 50 );

            collector.recordCompletedTrace( {
                traceId       : `trace_${i}`,
                threadId      : i <= 3 ? 'thread_A' : 'thread_B',
                agentId       : 'agent_1',
                startTime     : 1000 + i * 100,
                durationMs    : i * 50,
                rootSpan      : root,
                totalSpendUSD : i * 0.001,
                categorySpend : root.categorySpend
            } );
        }

        // Filter by threadId
        const threadATraces = collector.listTraces( { threadId : 'thread_A' } );
        expect( threadATraces ).toHaveLength( 3 );

        // Filter by status 'error'
        const errorTraces = collector.listTraces( { status : 'error' } );
        expect( errorTraces ).toHaveLength( 3 );

        // Filter by minDuration
        const longTraces = collector.listTraces( { minDuration : 160 } );
        expect( longTraces.every( ( t ) => {return ( t.durationMs ?? 0 ) >= 160;} ) ).toBe( true );

        // Filter by limit
        const limited = collector.listTraces( { limit : 2 } );
        expect( limited ).toHaveLength( 2 );
    } );

    it( 'bounds in-progress traces and emits a warning on overflow (R38)', () => 
    {
        const collector = new TraceCollector( { maxActiveTraces : 2 } );
        const warnings: Array<{ code: string, message: string }> = [];

        collector.on( 'warning', ( event ) => 
        {
            warnings.push( event );
        } );

        const first = collector.startTrace( { name : 't1' } );
        const second = collector.startTrace( { name : 't2' } );
        const third = collector.startTrace( { name : 't3' } );

        expect( warnings ).toHaveLength( 1 );
        expect( warnings[ 0 ]?.code ).toBe( 'active_trace_overflow' );
        expect( collector.getTrace( first.trace.traceId ) ).toBeUndefined();
        expect( collector.getTrace( second.trace.traceId )?.traceId ).toBe( second.trace.traceId );
        expect( collector.getTrace( third.trace.traceId )?.traceId ).toBe( third.trace.traceId );
    } );
} );
