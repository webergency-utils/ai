import { describe, it, expect } from 'vitest';
import { SpanImpl } from '../../src/trace/span.js';
import { generateTraceId } from '../../src/trace/id.js';

describe( 'SpanImpl', () => 
{
    it( 'initializes with default values and timestamps', () => 
    {
        const traceId = generateTraceId();
        const span = new SpanImpl( 'test:operation', { traceId, kind : 'tool' } );

        expect( span.id ).toHaveLength( 16 );
        expect( span.traceId ).toBe( traceId );
        expect( span.parentSpanId ).toBeUndefined();
        expect( span.name ).toBe( 'test:operation' );
        expect( span.kind ).toBe( 'tool' );
        expect( span.status ).toBe( 'ok' );
        expect( span.startTime ).toBeGreaterThan( 0 );
        expect( span.endTime ).toBeUndefined();
        expect( span.durationMs ).toBeUndefined();
        expect( span.spendUSD ).toBe( 0 );
        expect( span.children ).toHaveLength( 0 );
    } );

    it( 'sets and merges attributes', () => 
    {
        const span = new SpanImpl( 'test:attrs' );

        span.setAttribute( 'http.status', 200 );
        span.setAttribute( 'user.id', 'user_1' );
        span.setAttributes( {
            'db.system' : 'postgresql',
            'cached'    : true
        } );

        expect( span.attributes ).toEqual( {
            'http.status' : 200,
            'user.id'     : 'user_1',
            'db.system'   : 'postgresql',
            'cached'      : true
        } );
    } );

    it( 'accumulates token and custom metrics', () => 
    {
        const span = new SpanImpl( 'test:metrics' );

        span.recordMetric( 'promptTokens', 50 );
        span.recordMetric( 'promptTokens', 25 );
        span.recordMetric( 'bytes', 1024 );
        span.addMetrics( {
            completionTokens : 40,
            operations       : 3
        } );

        expect( span.metrics.promptTokens ).toBe( 75 );
        expect( span.metrics.completionTokens ).toBe( 40 );
        expect( span.metrics.bytes ).toBe( 1024 );
        expect( span.metrics.operations ).toBe( 3 );
    } );

    it( 'records direct spend and updates category spend', () => 
    {
        const span = new SpanImpl( 'test:spend' );

        span.recordSpend( {
            category : 'storage',
            costUSD  : 0.0002,
            units    : 1
        } );

        span.recordSpend( {
            category : 'model',
            costUSD  : 0.003,
            units    : 100
        } );

        expect( span.spendUSD ).toBeCloseTo( 0.0032, 6 );
        expect( span.categorySpend.storage ).toBeCloseTo( 0.0002, 6 );
        expect( span.categorySpend.model ).toBeCloseTo( 0.003, 6 );
        expect( span.categorySpend.compute ).toBe( 0 );
    } );

    it( 'appends child spans and sets parentSpanId', () => 
    {
        const parent = new SpanImpl( 'parent' );
        const child = new SpanImpl( 'child', { traceId : parent.traceId } );

        parent.addChild( child );

        expect( parent.children ).toHaveLength( 1 );
        expect( parent.children[0]?.id ).toBe( child.id );
        expect( child.parentSpanId ).toBe( parent.id );
    } );

    it( 'calculates durationMs on end()', () => 
    {
        const startTime = Date.now() - 50;
        const span = new SpanImpl( 'timed', { startTime } );

        span.end( startTime + 50 );

        expect( span.endTime ).toBe( startTime + 50 );
        expect( span.durationMs ).toBe( 50 );
    } );

    it( 'keeps the first end time when end is called twice (R39)', () => 
    {
        const span = new SpanImpl( 'idempotent-end', { startTime : 1_000 } );

        span.end( 1_050 );
        span.end( 9_999 );

        expect( span.endTime ).toBe( 1_050 );
        expect( span.durationMs ).toBe( 50 );
    } );

    it( 'serializes to plain JSON structure with children', () => 
    {
        const parent = new SpanImpl( 'parent', { kind : 'agent' } );
        const child = new SpanImpl( 'child', { traceId : parent.traceId, kind : 'tool' } );
        parent.addChild( child );

        child.recordSpend( { category : 'tools', costUSD : 0.01 } );
        child.end();
        parent.end();

        const json = parent.toJSON();

        expect( json.id ).toBe( parent.id );
        expect( json.name ).toBe( 'parent' );
        expect( json.children ).toHaveLength( 1 );
        expect( json.children[0]?.name ).toBe( 'child' );
        expect( json.children[0]?.spendUSD ).toBe( 0.01 );
    } );
} );
