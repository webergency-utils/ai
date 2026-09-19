import type { CategorySpendBreakdown } from '../spend/types.js';
import type { Span, SpanMetrics, SpanRollup, Trace } from './types.js';

/**
 * Recursively computes rolled-up duration, total spend, per-category spend,
 * token metrics, and subcall counts for a span and all its descendants.
 */
export function computeSpanRollup( span: Span ): SpanRollup
{
    let totalSpendUSD = span.spendUSD;
    const categorySpend: CategorySpendBreakdown = 
    {
        model   : span.categorySpend.model,
        storage : span.categorySpend.storage,
        compute : span.categorySpend.compute,
        network : span.categorySpend.network,
        mcp     : span.categorySpend.mcp,
        tools   : span.categorySpend.tools,
        custom  : span.categorySpend.custom
    };

    const metrics: SpanMetrics = { ...span.metrics };
    let subcallCount = 0;

    for( const child of span.children )
    {
        const childRollup = computeSpanRollup( child );

        totalSpendUSD += childRollup.totalSpendUSD;

        categorySpend.model += childRollup.categorySpend.model;
        categorySpend.storage += childRollup.categorySpend.storage;
        categorySpend.compute += childRollup.categorySpend.compute;
        categorySpend.network += childRollup.categorySpend.network;
        categorySpend.mcp += childRollup.categorySpend.mcp;
        categorySpend.tools += childRollup.categorySpend.tools;
        categorySpend.custom += childRollup.categorySpend.custom;

        for( const [ k, v ] of Object.entries( childRollup.metrics ) )
        {
            if( typeof v === 'number' && k !== 'subcallCount' )
            {
                metrics[k] = ( metrics[k] ?? 0 ) + v;
            }
        }

        subcallCount += ( childRollup.metrics.subcallCount ?? 0 ) + 1;
    }

    metrics.subcallCount = subcallCount;

    const totalDurationMs = span.durationMs ?? 
        ( span.endTime ? Math.max( 0, span.endTime - span.startTime ) : 0 );

    const rollup: SpanRollup = 
    {
        totalDurationMs,
        totalSpendUSD,
        categorySpend,
        metrics
    };

    span.rollup = rollup;

    return rollup;
}

/**
 * Computes recursive rollup across the entire trace starting from the root span.
 * Updates the trace summary fields (totalSpendUSD, categorySpend, durationMs).
 */
export function computeTraceRollup( trace: Trace ): Trace
{
    const rootRollup = computeSpanRollup( trace.rootSpan );

    trace.totalSpendUSD = rootRollup.totalSpendUSD;
    trace.categorySpend = { ...rootRollup.categorySpend };

    if( trace.durationMs === undefined && rootRollup.totalDurationMs > 0 )
    {
        trace.durationMs = rootRollup.totalDurationMs;
    }

    return trace;
}
