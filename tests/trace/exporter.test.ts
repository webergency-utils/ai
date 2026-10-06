import { describe, it, expect } from 'vitest';
import { SpanImpl } from '../../src/trace/span.js';
import { exportTraceToJSON, exportTraceToOTLP, exportTracesToOTLP, type OTLPKeyValue } from '../../src/trace/exporter.js';
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

describe( 'Trace Exporters encoding correctness (R11, R12)', () => 
{
    function traceOf( root: SpanImpl, endTime?: number ): Trace
    {
        const trace: Trace = 
            {
                traceId       : root.traceId,
                startTime     : root.startTime,
                endTime,
                durationMs    : endTime === undefined ? undefined : endTime - root.startTime,
                rootSpan      : root,
                totalSpendUSD : 0,
                categorySpend : { model : 0, storage : 0, compute : 0, network : 0, mcp : 0, tools : 0, custom : 0 }
            };

        computeTraceRollup( trace );

        return trace;
    }

    function attr( span: { attributes: OTLPKeyValue[] }, key: string )
    {
        return span.attributes.find( ( a ) => {return a.key === key;} )?.value;
    }

    it( 'AE7: exports an open child span as unfinished error, never a zero-length success', () => 
    {
        const root = new SpanImpl( 'agent:run', { kind : 'agent', startTime : 1_000 } );
        const open = new SpanImpl( 'tool:slow', { kind : 'tool', startTime : 1_100 } );

        root.addChild( open );
        root.end( 1_500 );

        const otlp = exportTraceToOTLP( traceOf( root, 1_500 ) );
        const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
        const openOtlp = spans[1]!;

        expect( attr( openOtlp, 'trace.span.unfinished' ) ).toEqual( { boolValue : true } );
        expect( openOtlp.status.code ).toBe( 2 );
        expect( openOtlp.status.message ).toBe( 'unfinished' );
        expect( BigInt( openOtlp.endTimeUnixNano ) ).toBeGreaterThan( BigInt( openOtlp.startTimeUnixNano ) );
        expect( spans[0]!.attributes.find( ( a ) => {return a.key === 'trace.span.unfinished';} ) ).toBeUndefined();
    } );

    it( 'never ends a span before it starts', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 5_000 } );

        root.end( 4_000 );

        const [ span ] = exportTraceToOTLP( traceOf( root, 4_000 ) ).resourceSpans[0]!.scopeSpans[0]!.spans;

        expect( BigInt( span!.endTimeUnixNano ) ).toBeGreaterThanOrEqual( BigInt( span!.startTimeUnixNano ) );
    } );

    it( 'drops non-finite numbers with a TRACE_ATTRIBUTE_INVALID warning and stays valid JSON', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 1 } );

        root.setAttribute( 'bad.nan', Number.NaN );
        root.setAttribute( 'bad.inf', Number.POSITIVE_INFINITY );
        root.setAttribute( 'good', 1.5 );
        root.metrics.weird = Number.NEGATIVE_INFINITY;
        root.end( 2 );

        const warnings: string[] = [];
        const otlp = exportTraceToOTLP( traceOf( root, 2 ), { onWarning : ( w ) => {warnings.push( `${w.code}:${( w.details as { key: string } ).key}` );} } );
        const json = JSON.stringify( otlp );
        const span = otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

        expect( json ).not.toContain( 'null' );
        expect( attr( span, 'bad.nan' ) ).toBeUndefined();
        expect( attr( span, 'metrics.weird' ) ).toBeUndefined();
        expect( attr( span, 'good' ) ).toEqual( { doubleValue : 1.5 } );
        expect( warnings.sort() ).toEqual( [ 'TRACE_ATTRIBUTE_INVALID:bad.inf', 'TRACE_ATTRIBUTE_INVALID:bad.nan', 'TRACE_ATTRIBUTE_INVALID:metrics.weird' ] );
    } );

    it( 'adds error.type and an exception event with truncated stacktrace on error spans', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 1 } );

        root.status = 'error';
        root.errorDetails = { message : 'boom', name : 'TypeError', stack : 's'.repeat( 10_000 ) };
        root.end( 3 );

        const span = exportTraceToOTLP( traceOf( root, 3 ) ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
        const event = span.events![0]!;

        expect( attr( span, 'error.type' ) ).toEqual( { stringValue : 'TypeError' } );
        expect( span.status ).toEqual( { code : 2, message : 'boom' } );
        expect( event.name ).toBe( 'exception' );
        expect( event.attributes.find( ( a ) => {return a.key === 'exception.type';} )?.value ).toEqual( { stringValue : 'TypeError' } );
        expect( event.attributes.find( ( a ) => {return a.key === 'exception.message';} )?.value ).toEqual( { stringValue : 'boom' } );
        expect( event.attributes.find( ( a ) => {return a.key === 'exception.stacktrace';} )?.value.stringValue ).toHaveLength( 4096 );
    } );

    it( 'omits parentSpanId for roots and carries recorded span events, flags, and resource attributes', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 1 } );
        const child = new SpanImpl( 'y', { startTime : 1 } );

        root.addChild( child );
        child.addEvent( 'retry', { attempt : 2 }, 2 );
        child.end( 2 );
        root.end( 3 );

        const otlp = exportTraceToOTLP( traceOf( root, 3 ), { resourceAttributes : { 'deployment.environment' : 'test', 'service.name' : 'ignored' }, serviceName : 'svc' } );
        const [ r, c ] = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;

        expect( 'parentSpanId' in r! ).toBe( false );
        expect( c!.parentSpanId ).toBe( r!.spanId );
        expect( c!.events![0]!.name ).toBe( 'retry' );
        expect( r!.flags ).toBe( 0x101 );
        expect( otlp.resourceSpans[0]!.resource.attributes.map( ( a ) => {return a.key;} ) ).toEqual( [ 'service.name', 'service.version', 'deployment.environment' ] );
        expect( otlp.resourceSpans[0]!.resource.attributes[0]!.value ).toEqual( { stringValue : 'svc' } );
    } );

    it( 'merges many traces under one resource with exportTracesToOTLP', () => 
    {
        const a = new SpanImpl( 'a', { startTime : 1 } );
        const b = new SpanImpl( 'b', { startTime : 1 } );

        a.end( 2 );
        b.end( 2 );

        const otlp = exportTracesToOTLP( [ traceOf( a, 2 ), traceOf( b, 2 ) ] );

        expect( otlp.resourceSpans ).toHaveLength( 1 );
        expect( otlp.resourceSpans[0]!.scopeSpans[0]!.spans.map( ( s ) => {return s.traceId;} ) ).toEqual( [ a.traceId, b.traceId ] );
    } );

    it( 'serializes span events through toJSON/fromSerialized', () => 
    {
        const s = new SpanImpl( 'x', { startTime : 1 } );

        s.addEvent( 'e', { k : 'v' }, 5 );

        const copy = SpanImpl.fromSerialized( s.toJSON() );

        expect( copy.events ).toEqual( [ { name : 'e', time : 5, attributes : { k : 'v' } } ] );
    } );
} );
