import { describe, it, expect } from 'vitest';
import { generateTraceId, generateSpanId } from '../../src/trace/id.js';
import type { 
    Span, 
    Trace, 
    SpanKind, 
    SpanStatus, 
    SpanRollup, 
    SerializedSpan 
} from '../../src/trace/types.js';

describe( 'Trace ID Generation', () => 
{
    it( 'generates a valid 32-character hexadecimal lowercase traceId', () => 
    {
        const traceId = generateTraceId();

        expect( traceId ).toHaveLength( 32 );
        expect( /^[0-9a-f]{32}$/.test( traceId ) ).toBe( true );
    } );

    it( 'generates a valid 16-character hexadecimal lowercase spanId', () => 
    {
        const spanId = generateSpanId();

        expect( spanId ).toHaveLength( 16 );
        expect( /^[0-9a-f]{16}$/.test( spanId ) ).toBe( true );
    } );

    it( 'generates unique IDs across sequential calls', () => 
    {
        const traceIds = new Set<string>();
        const spanIds = new Set<string>();

        for( let i = 0; i < 100; i++ )
        {
            traceIds.add( generateTraceId() );
            spanIds.add( generateSpanId() );
        }

        expect( traceIds.size ).toBe( 100 );
        expect( spanIds.size ).toBe( 100 );
    } );
} );

describe( 'Span and Trace Contracts', () => 
{
    it( 'allows constructing valid typed span and trace models', () => 
    {
        const rollup: SpanRollup = 
        {
            totalDurationMs : 150,
            totalSpendUSD   : 0.005,
            categorySpend   : {
                model   : 0.004,
                storage : 0.001,
                compute : 0,
                network : 0,
                mcp     : 0,
                tools   : 0,
                custom  : 0
            },
            metrics : {
                promptTokens     : 100,
                completionTokens : 50,
                subcallCount     : 2
            }
        };

        const span: Span = 
        {
            id            : generateSpanId(),
            traceId       : generateTraceId(),
            name          : 'agent:step:1',
            kind          : 'agent',
            startTime     : Date.now(),
            endTime       : Date.now() + 150,
            durationMs    : 150,
            status        : 'ok',
            attributes    : { 'step.index' : 1 },
            metrics       : { promptTokens : 100 },
            spendUSD      : 0,
            categorySpend : {
                model   : 0,
                storage : 0,
                compute : 0,
                network : 0,
                mcp     : 0,
                tools   : 0,
                custom  : 0
            },
            children : [],
            rollup,
            setAttribute( key, value )
            {
                this.attributes[key] = value;
            },
            setAttributes( attrs )
            {
                Object.assign( this.attributes, attrs );
            },
            recordMetric( key, value )
            {
                this.metrics[key] = ( this.metrics[key] ?? 0 ) + value;
            },
            addMetrics( metrics )
            {
                for( const [ k, v ] of Object.entries( metrics ) )
                {
                    if( v !== undefined )
                    {
                        this.metrics[k] = ( this.metrics[k] ?? 0 ) + v;
                    }
                }
            },
            recordSpend( entry )
            {
                const cost = entry.costUSD ?? 0;
                this.spendUSD += cost;
                this.categorySpend[entry.category] += cost;
            },
            addChild( child )
            {
                this.children.push( child );
            },
            end( endTime )
            {
                this.endTime = endTime ?? Date.now();
                this.durationMs = this.endTime - this.startTime;
            },
            toJSON()
            {
                return {
                    id            : this.id,
                    traceId       : this.traceId,
                    name          : this.name,
                    kind          : this.kind,
                    startTime     : this.startTime,
                    endTime       : this.endTime,
                    durationMs    : this.durationMs,
                    status        : this.status,
                    attributes    : this.attributes,
                    metrics       : this.metrics,
                    spendUSD      : this.spendUSD,
                    categorySpend : this.categorySpend,
                    children      : this.children.map( ( c ) => {return c.toJSON();} )
                } as unknown as SerializedSpan;
            }
        };

        const trace: Trace = 
        {
            traceId       : span.traceId,
            threadId      : 'thread_123',
            agentId       : 'agent_abc',
            startTime     : span.startTime,
            endTime       : span.endTime,
            durationMs    : span.durationMs,
            rootSpan      : span,
            totalSpendUSD : span.spendUSD,
            categorySpend : span.categorySpend
        };

        expect( span.id ).toHaveLength( 16 );
        expect( trace.traceId ).toHaveLength( 32 );
        expect( trace.rootSpan.kind ).toBe( 'agent' as SpanKind );
        expect( trace.rootSpan.status ).toBe( 'ok' as SpanStatus );
    } );
} );
