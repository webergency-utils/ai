import { describe, it, expect } from 'vitest';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import { SpendTracker } from '../../src/spend/tracker.js';

describe( 'ExecutionContext Spans & Lifecycle (U2)', () => 
{
    it( 'manages active span lifecycle and nesting via withSpan', async () => 
    {
        const tracker = new SpendTracker();
        const ctx = new SimpleExecutionContext( { tracker } );

        let innerSpanId: string | undefined;

        await ctx.withSpan( 'outer:op', async ( outerSpan, outerCtx ) => 
        {
            expect( outerCtx.activeSpan?.id ).toBe( outerSpan.id );

            outerCtx.reportSpend( {
                category : 'compute',
                costUSD  : 0.001
            } );

            await outerCtx.withSpan( 'inner:op', async ( innerSpan, innerCtx ) => 
            {
                innerSpanId = innerSpan.id;
                expect( innerCtx.activeSpan?.id ).toBe( innerSpan.id );
                expect( innerSpan.parentSpanId ).toBe( outerSpan.id );

                innerCtx.reportSpend( {
                    category : 'storage',
                    costUSD  : 0.0005
                } );
            } );

            // After inner completes, outerCtx still has outerSpan active
            expect( outerCtx.activeSpan?.id ).toBe( outerSpan.id );
            expect( outerSpan.children ).toHaveLength( 1 );
            expect( outerSpan.children[0]?.id ).toBe( innerSpanId );
        } );

        // After outer completes, root context has no activeSpan
        expect( ctx.activeSpan ).toBeUndefined();
    } );

    it( 'captures errors into span status and errorDetails, rethrowing the exception', async () => 
    {
        const ctx = new SimpleExecutionContext();
        let capturedSpan: unknown;

        await expect( 
            ctx.withSpan( 'failing:op', async ( span ) => 
            {
                capturedSpan = span;
                throw new Error( 'Simulated operation failure' );
            } ) 
        ).rejects.toThrow( 'Simulated operation failure' );

        const span = capturedSpan as { status: string, errorDetails?: { message: string }, durationMs?: number };
        expect( span.status ).toBe( 'error' );
        expect( span.errorDetails?.message ).toBe( 'Simulated operation failure' );
        expect( span.durationMs ).toBeDefined();
    } );

    it( 'supports concurrent async operations without clobbering activeSpan', async () => 
    {
        const ctx = new SimpleExecutionContext();

        await ctx.withSpan( 'root', async ( rootSpan, rootCtx ) => 
        {
            const task1 = rootCtx.withSpan( 'task1', async ( span1, ctx1 ) => 
            {
                await new Promise( ( resolve ) => {return setTimeout( resolve, 20 );} );
                ctx1.reportSpend( { category : 'model', costUSD : 0.002 } );
                expect( ctx1.activeSpan?.id ).toBe( span1.id );
                return 'result1';
            } );

            const task2 = rootCtx.withSpan( 'task2', async ( span2, ctx2 ) => 
            {
                await new Promise( ( resolve ) => {return setTimeout( resolve, 10 );} );
                ctx2.reportSpend( { category : 'tools', costUSD : 0.001 } );
                expect( ctx2.activeSpan?.id ).toBe( span2.id );
                return 'result2';
            } );

            const results = await Promise.all( [ task1, task2 ] );
            expect( results ).toEqual( [ 'result1', 'result2' ] );
            expect( rootSpan.children ).toHaveLength( 2 );
        } );
    } );

    it( 'supports manual startSpan and span.end()', () => 
    {
        const ctx = new SimpleExecutionContext();
        const span = ctx.startSpan( 'manual:span', { kind : 'custom' } );

        expect( span.id ).toHaveLength( 16 );
        expect( span.kind ).toBe( 'custom' );
        expect( span.endTime ).toBeUndefined();

        span.end();
        expect( span.endTime ).toBeDefined();
        expect( span.durationMs ).toBeGreaterThanOrEqual( 0 );
    } );
} );
