import { describe, it, expect } from 'vitest';
import { SpanImpl } from '../../src/trace/span.js';
import { exportTraceToJSON, exportTraceToOTLP } from '../../src/trace/exporter.js';
import { computeTraceRollup } from '../../src/trace/rollup.js';
import type { Trace } from '../../src/trace/types.js';

describe( 'Trace Exporters (U6)', () => 
{
    function createSampleTrace(): Trace
    {
        const root = new SpanImpl( 'agent:run', { kind : 'agent' } );
        const tool = new SpanImpl( 'tool:search', { kind : 'tool' } );
        const model = new SpanImpl( 'model:chat', { kind : 'model' } );

        root.addChild( tool );
        tool.addChild( model );

        tool.setAttribute( 'tool.query', 'vitest docs' );
        model.setAttribute( 'model.temperature', 0.7 );
        model.setAttribute( 'model.cached', false );
        model.setAttribute( 'tokens.prompt', 120 );
        model.recordSpend( { category : 'model', costUSD : 0.003 } );
        model.recordMetric( 'promptTokens', 120 );
        model.end( model.startTime + 150 );

        tool.recordSpend( { category : 'tools', costUSD : 0.001 } );
        tool.end( tool.startTime + 200 );

        root.end( root.startTime + 250 );

        const trace: Trace = 
        {
            traceId       : root.traceId,
            threadId      : 'thread_123',
            agentId       : 'agent_abc',
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

        computeTraceRollup( trace );
        return trace;
    }

    it( 'exports hierarchical trace to pure JSON', () => 
    {
        const trace = createSampleTrace();
        const jsonStr = exportTraceToJSON( trace, { pretty : true } );

        expect( typeof jsonStr ).toBe( 'string' );
        const parsed = JSON.parse( jsonStr ) as Record<string, unknown>;

        expect( parsed.traceId ).toBe( trace.traceId );
        expect( parsed.threadId ).toBe( 'thread_123' );
        expect( parsed.agentId ).toBe( 'agent_abc' );
        expect( parsed.totalSpendUSD ).toBeCloseTo( 0.004, 4 );

        const rootSpan = parsed.rootSpan as { name: string, children: Array<{ name: string, children: Array<{ name: string }> }> };
        expect( rootSpan.name ).toBe( 'agent:run' );
        expect( rootSpan.children ).toHaveLength( 1 );
        expect( rootSpan.children[0]?.name ).toBe( 'tool:search' );
        expect( rootSpan.children[0]?.children[0]?.name ).toBe( 'model:chat' );
    } );

    it( 'exports to OpenTelemetry compliant OTLP JSON schema (Acceptance Example AE3 & Flow F3)', () => 
    {
        const trace = createSampleTrace();
        const otlp = exportTraceToOTLP( trace, { serviceName : 'my-agent-service' } );

        // Validate top-level OTLP ResourceSpans
        expect( otlp.resourceSpans ).toBeDefined();
        expect( otlp.resourceSpans ).toHaveLength( 1 );

        const resourceSpan = otlp.resourceSpans[0]!;
        expect( resourceSpan.resource.attributes ).toBeDefined();

        // Check service.name attribute
        const serviceNameAttr = resourceSpan.resource.attributes.find( ( a ) => {return a.key === 'service.name';} );
        expect( serviceNameAttr?.value.stringValue ).toBe( 'my-agent-service' );

        // Validate ScopeSpans
        expect( resourceSpan.scopeSpans ).toHaveLength( 1 );
        const scopeSpan = resourceSpan.scopeSpans[0]!;
        expect( scopeSpan.scope.name ).toBe( '@webergency-utils/ai' );

        // Validate all 3 spans are flattened into scopeSpan.spans
        expect( scopeSpan.spans ).toHaveLength( 3 );

        const [ rootOtlp, toolOtlp, modelOtlp ] = scopeSpan.spans as [
            typeof scopeSpan.spans[0],
            typeof scopeSpan.spans[0],
            typeof scopeSpan.spans[0]
        ];

        // Root span checks
        expect( rootOtlp.name ).toBe( 'agent:run' );
        expect( rootOtlp.traceId ).toBe( trace.traceId );
        expect( rootOtlp.parentSpanId ).toBeUndefined();
        expect( rootOtlp.kind ).toBe( 1 ); // INTERNAL
        expect( rootOtlp.status.code ).toBe( 1 ); // OK
        expect( typeof rootOtlp.startTimeUnixNano ).toBe( 'string' );
        expect( typeof rootOtlp.endTimeUnixNano ).toBe( 'string' );
        expect( rootOtlp.startTimeUnixNano.endsWith( '000000' ) ).toBe( true );

        // Tool span checks
        expect( toolOtlp.name ).toBe( 'tool:search' );
        expect( toolOtlp.traceId ).toBe( trace.traceId );
        expect( toolOtlp.parentSpanId ).toBe( rootOtlp.spanId );
        expect( toolOtlp.kind ).toBe( 1 ); // INTERNAL

        const queryAttr = toolOtlp.attributes.find( ( a ) => {return a.key === 'tool.query';} );
        expect( queryAttr?.value.stringValue ).toBe( 'vitest docs' );

        // Model span checks
        expect( modelOtlp.name ).toBe( 'model:chat' );
        expect( modelOtlp.traceId ).toBe( trace.traceId );
        expect( modelOtlp.parentSpanId ).toBe( toolOtlp.spanId );
        expect( modelOtlp.kind ).toBe( 3 ); // CLIENT

        const tempAttr = modelOtlp.attributes.find( ( a ) => {return a.key === 'model.temperature';} );
        expect( tempAttr?.value.doubleValue ).toBe( 0.7 );

        const cachedAttr = modelOtlp.attributes.find( ( a ) => {return a.key === 'model.cached';} );
        expect( cachedAttr?.value.boolValue ).toBe( false );

        const promptTokenAttr = modelOtlp.attributes.find( ( a ) => {return a.key === 'tokens.prompt';} );
        expect( promptTokenAttr?.value.intValue ).toBe( '120' );
    } );
} );
