import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { Agent, createTool } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { AIError } from '../../src/core/error.js';
import { SpendTracker } from '../../src/spend/index.js';
import { TraceCollector } from '../../src/trace/collector.js';
import { SpanImpl } from '../../src/trace/span.js';
import { computeTraceRollup } from '../../src/trace/rollup.js';
import { exportTraceToOTLP } from '../../src/trace/exporter.js';
import { OTLPHttpExporter, type OTLPFetch } from '../../src/trace/otlp-http.js';
import { createMeteredModel } from '../../src/providers/metered.js';
import 
{
    DEFAULT_MAX_CONTENT_BYTES, TRUNCATION_MARKER, isSecretAttributeKey, scrubSecrets, truncateContent
} from '../../src/trace/genai.js';
import { createSampler, hasErrorSpan, sampleByRate, traceIdToUnit } from '../../src/trace/sampling.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelResponse } from '../../src/core/types.js';
import type { Trace, TraceWarningEvent } from '../../src/trace/types.js';

const SECRET = 'sk-live-ABCDEFGHIJKLMNOP1234';

function textModel( reply = 'The answer is 42.' ): ModelProtocol
{
    return {
        provider : 'openai',
        model    : 'gpt-4o',
        generate : vi.fn( async (): Promise<ModelResponse> => {return { role : 'assistant', content : reply, finishReason : 'stop', usage : { promptTokens : 5, completionTokens : 3, totalTokens : 8 }, raw : {} };} ),
        stream   : vi.fn()
    };
}

function sink()
{
    const bodies: string[] = [];
    const fetch: OTLPFetch = async ( _url, init ) => 
    {
        bodies.push( init.body );

        return { ok : true, status : 200, headers : new Headers(), text : async () => {return '';} };
    };

    return { fetch, bodies };
}

function traceOf( root: SpanImpl ): Trace
{
    const trace: Trace = { traceId : root.traceId, startTime : root.startTime, endTime : root.endTime, rootSpan : root, totalSpendUSD : 0, categorySpend : root.categorySpend };

    computeTraceRollup( trace );

    return trace;
}

const redactSecrets = ( text: string ) => {return text.replaceAll( SECRET, '[SECRET]' ).replaceAll( 'hunter2', '[PW]' );};

describe( 'content capture and redaction (R13, AE8)', () => 
{
    it( 'AE8: captureContent without redact throws at construction (collector, exporter, export function)', () => 
    {
        expect( () => {return new TraceCollector( { capture : { captureContent : true } } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { captureContent : true } );} ).toThrow( /redact/ );
        expect( () => {return new OTLPHttpExporter( { captureContent : true, redact : 'no' as never } );} ).toThrow( AIError );
        expect( () => {return exportTraceToOTLP( traceOf( new SpanImpl( 'x' ) ), { captureContent : true } );} ).toThrow( AIError );
        expect( () => {return new TraceCollector( { capture : { captureContent : true, redact : ( t ) => {return t;} } } );} ).not.toThrow();
        expect( () => {return new TraceCollector( { capture : { captureContent : false } } );} ).not.toThrow();
        expect( () => {return new TraceCollector( { capture : { maxContentBytes : 0 } } );} ).toThrow( AIError );
    } );

    it( 'by default nothing is captured: prompts and completions never reach the payload', async () => 
    {
        const collector = new TraceCollector();
        const { fetch, bodies } = sink();
        const exporter = new OTLPHttpExporter( { fetch } );

        exporter.attach( collector );

        const agent = new Agent( { model : textModel( `reply ${SECRET}` ), instructions : 'be nice' } );

        await agent.run( `my password is hunter2 and key ${SECRET}`, { collector } );
        await exporter.shutdown();

        expect( bodies ).toHaveLength( 1 );
        expect( bodies[0] ).not.toContain( 'hunter2' );
        expect( bodies[0] ).not.toContain( SECRET );
        expect( bodies[0] ).not.toContain( 'gen_ai.input.messages' );
        expect( bodies[0] ).not.toContain( 'be nice' );
    } );

    it( 'with redact, captured prompts/completions are exported and secrets matched by the callback do not appear', async () => 
    {
        const collector = new TraceCollector( { capture : { captureContent : true, redact : redactSecrets } } );
        const { fetch, bodies } = sink();
        const exporter = new OTLPHttpExporter( { fetch, captureContent : true, redact : redactSecrets } );

        exporter.attach( collector );

        const agent = new Agent( { model : textModel( `reply ${SECRET}` ), instructions : 'be nice' } );

        await agent.run( `my password is hunter2 and key ${SECRET}`, { collector } );
        await exporter.shutdown();

        const body = bodies[0]!;
        const spans = JSON.parse( body ).resourceSpans[0].scopeSpans[0].spans as Array<{ name: string, attributes: Array<{ key: string, value: { stringValue?: string } }> }>;
        const model = spans.find( ( s ) => {return s.name === 'model:generate';} )!;
        const input = JSON.parse( model.attributes.find( ( a ) => {return a.key === 'gen_ai.input.messages';} )!.value.stringValue! );
        const output = JSON.parse( model.attributes.find( ( a ) => {return a.key === 'gen_ai.output.messages';} )!.value.stringValue! );

        expect( input[0] ).toEqual( { role : 'system', parts : [ { type : 'text', content : 'be nice' } ] } );
        expect( input[1].parts[0].content ).toBe( 'my [PW] is [PW]'.replace( 'my [PW] is [PW]', 'my password is [PW] and key [SECRET]' ) );
        expect( output[0] ).toMatchObject( { role : 'assistant', finish_reason : 'stop' } );
        expect( output[0].parts[0].content ).toBe( 'reply [SECRET]' );
        expect( body ).not.toContain( 'hunter2' );
        expect( body ).not.toContain( SECRET );
    } );

    it( 'captures tool calls and tool results as structured parts', async () => 
    {
        let n = 0;
        const model: ModelProtocol = 
            {
                provider : 'openai', model : 'gpt', stream : vi.fn(),
                generate : vi.fn( async (): Promise<ModelResponse> => 
                {
                    n++;

                    return n === 1
                        ? { role : 'assistant', content : '', finishReason : 'tool_calls', toolCalls : [ { id : 'c1', name : 'lookup', arguments : { q : 'hunter2' } } ], raw : {} }
                        : { role : 'assistant', content : 'done', finishReason : 'stop', raw : {} };
                } )
            };
        const lookup = createTool( { name : 'lookup', description : 'd', parameters : schema.object( { q : schema.string() } ), execute : async () => {return 'result-hunter2';} } );
        const collector = new TraceCollector( { capture : { captureContent : true, redact : redactSecrets } } );
        let trace: Trace | undefined;

        collector.on( 'trace:complete', ( t ) => {trace = t;} );
        await new Agent( { model, tools : [ lookup ] } ).run( 'go', { collector } );

        const models = JSON.stringify( exportTraceToOTLP( trace!, { captureContent : true, redact : redactSecrets } ) );

        expect( models ).toContain( 'tool_call_response' );
        expect( models ).toContain( 'result-[PW]' );
        expect( models ).toContain( 'tool_call' );
        expect( models ).not.toContain( 'hunter2' );
    } );

    it( 'exporter policy is authoritative: content attributes set by other instrumentation are dropped unless enabled, redacted and truncated when enabled', () => 
    {
        const root = new SpanImpl( 'model:x', { kind : 'model', startTime : 1, attributes : { 'gen_ai.input.messages' : `hello ${SECRET}`, 'gen_ai.output.messages' : 'z'.repeat( 100 ) } } );

        root.end( 2 );

        const off = JSON.stringify( exportTraceToOTLP( traceOf( root ) ) );

        expect( off ).not.toContain( 'gen_ai.input.messages' );
        expect( off ).not.toContain( SECRET );

        const warnings: TraceWarningEvent[] = [];
        const on = exportTraceToOTLP( traceOf( root ), { captureContent : true, redact : redactSecrets, maxContentBytes : 20, onWarning : ( w ) => {warnings.push( w );} } );
        const attrs = on.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
        const input = attrs.find( ( a ) => {return a.key === 'gen_ai.input.messages';} )!.value.stringValue!;
        const output = attrs.find( ( a ) => {return a.key === 'gen_ai.output.messages';} )!.value.stringValue!;

        expect( input ).toBe( 'hello [SECRET]' );
        expect( output ).toBe( 'z'.repeat( 20 ) + TRUNCATION_MARKER );
        expect( warnings ).toEqual( [] );
    } );

    it( 'a throwing redactor fails closed at export time with a warning', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 1, attributes : { 'gen_ai.input.messages' : 'secret stuff' } } );

        root.end( 2 );

        const warnings: TraceWarningEvent[] = [];
        const json = JSON.stringify( exportTraceToOTLP( traceOf( root ), { captureContent : true, redact : () => {throw new Error( 'bug' );}, onWarning : ( w ) => {warnings.push( w );} } ) );

        expect( json ).not.toContain( 'secret stuff' );
        expect( warnings.map( ( w ) => {return w.code;} ) ).toEqual( [ 'TRACE_REDACT_FAILED' ] );
    } );

    it( 'a throwing redactor at instrumentation time captures nothing and never breaks the run', async () => 
    {
        const collector = new TraceCollector( { capture : { captureContent : true, redact : () => {throw new Error( 'bug' );} } } );
        let trace: Trace | undefined;

        collector.on( 'trace:complete', ( t ) => {trace = t;} );

        const result = await new Agent( { model : textModel() } ).run( 'hello', { collector } );

        expect( result.text ).toBe( 'The answer is 42.' );
        expect( JSON.stringify( trace!.rootSpan.toJSON() ) ).not.toContain( 'gen_ai.input.messages' );
    } );

    it( 'truncates at maxContentBytes on a UTF-8 boundary and redacts before truncating', () => 
    {
        expect( truncateContent( 'short', 100 ) ).toBe( 'short' );
        expect( truncateContent( 'abcdef', 3 ) ).toBe( `abc${TRUNCATION_MARKER}` );
        // 'é' is 2 bytes; cutting inside it must back off to the character boundary.
        expect( truncateContent( 'aéé', 2 ) ).toBe( `a${TRUNCATION_MARKER}` );
        expect( truncateContent( 'aéé', 3 ) ).toBe( `aé${TRUNCATION_MARKER}` );
        expect( DEFAULT_MAX_CONTENT_BYTES ).toBe( 16384 );
    } );

    it( 'standalone MeteredModel captures content only when its context carries a policy', async () => 
    {
        const on = new TraceCollector( { capture : { captureContent : true, redact : redactSecrets } } );
        const { rootSpan: rootOn, context: ctxOn } = on.startTrace( { name : 'job' } );

        await createMeteredModel( textModel( `r ${SECRET}` ), { tracker : new SpendTracker(), context : ctxOn } ).generate( { messages : [ { role : 'user', content : `u ${SECRET}` } ], systemPrompt : 'sys' } );

        const span = rootOn.children[0]!;

        expect( String( span.attributes['gen_ai.input.messages'] ) ).toContain( '[SECRET]' );
        expect( String( span.attributes['gen_ai.input.messages'] ) ).toContain( 'sys' );
        expect( String( span.attributes['gen_ai.output.messages'] ) ).not.toContain( SECRET );

        const off = new TraceCollector();
        const { rootSpan: rootOff, context: ctxOff } = off.startTrace( { name : 'job' } );

        await createMeteredModel( textModel(), { tracker : new SpendTracker(), context : ctxOff } ).generate( { messages : [ { role : 'user', content : 'u' } ] } );
        expect( rootOff.children[0]!.attributes['gen_ai.input.messages'] ).toBeUndefined();
    } );

    it( 'standalone streaming captures redacted output text', async () => 
    {
        const collector = new TraceCollector( { capture : { captureContent : true, redact : redactSecrets } } );
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const inner: ModelProtocol = 
            {
                provider : 'openai', model : 'gpt', generate : vi.fn(),
                stream   : async function* ()
                {
                    yield { deltaContent : 'say ' };
                    yield { deltaContent : SECRET, finishReason : 'stop' as const, usage : { promptTokens : 1, completionTokens : 1, totalTokens : 2 } };
                }
            };

        for await ( const _c of createMeteredModel( inner, { tracker : new SpendTracker(), context } ).stream( { messages : [] } ) ){ void _c }

        const out = String( rootSpan.children[0]!.attributes['gen_ai.output.messages'] );

        expect( out ).toContain( 'say [SECRET]' );
        expect( out ).not.toContain( SECRET );
    } );
} );

describe( 'credential safety (R14)', () => 
{
    it( 'classifies credential-like attribute keys', () => 
    {
        for( const key of [ 'authorization', 'http.request.header.authorization', 'apiKey', 'api_key', 'model.rawOptions', 'provider.api-key', 'password', 'client_secret', 'cookie', 'auth.token' ] )
        {
            expect( isSecretAttributeKey( key ), key ).toBe( true );
        }

        for( const key of [ 'gen_ai.usage.input_tokens', 'gen_ai.request.max_tokens', 'tool.name', 'model.name', 'spend.usd', 'metrics.promptTokens', 'storage.collection' ] )
        {
            expect( isSecretAttributeKey( key ), key ).toBe( false );
        }
    } );

    it( 'scrubs well-known credential shapes from free text', () => 
    {
        const scrubbed = scrubSecrets( 'Authorization: Bearer abc.def-ghi_jkl123 key sk-abcdefghijklmnopqr and AIzaSyA1234567890abcdefghijk, ghp_abcdefghijklmnop' );

        expect( scrubbed ).not.toMatch( /abc\.def|sk-abcdef|AIzaSy|ghp_/ );
        expect( scrubbed ).toContain( '[REDACTED]' );
        expect( scrubSecrets( 'plain text 12345' ) ).toBe( 'plain text 12345' );
    } );

    it( 'regression: apiKey, Authorization and rawOptions never appear in exported payloads, even from errors and custom attributes', async () => 
    {
        const failing: ModelProtocol = 
            {
                provider : 'openai', model : 'gpt', stream : vi.fn(),
                generate : vi.fn( async () => {throw Object.assign( new Error( `401 Incorrect API key provided: ${SECRET}. Authorization: Bearer ${SECRET}` ), { name : 'ProviderError' } );} )
            };
        const collector = new TraceCollector();
        const { fetch, bodies } = sink();
        const exporter = new OTLPHttpExporter( { fetch } );

        exporter.attach( collector );

        const { rootSpan, context, trace } = collector.startTrace( { name : 'job' } );

        rootSpan.setAttribute( 'apiKey', SECRET );
        rootSpan.setAttribute( 'http.authorization', `Bearer ${SECRET}` );
        rootSpan.setAttribute( 'model.rawOptions', JSON.stringify( { apiKey : SECRET } ) );
        rootSpan.setAttribute( 'note', `token Bearer ${SECRET}` );

        await expect( createMeteredModel( failing, { tracker : new SpendTracker(), context } ).generate( 
            { messages : [], rawOptions : { apiKey : SECRET, headers : { Authorization : `Bearer ${SECRET}` } } } ) ).rejects.toThrow();
        rootSpan.end();
        collector.endTrace( trace.traceId );
        await exporter.shutdown();

        const body = bodies[0]!;

        expect( body ).not.toContain( SECRET );
        expect( body ).not.toMatch( /apiKey|rawOptions|http\.authorization/i );
        expect( body ).toContain( 'Incorrect API key provided' );
    } );

    it( 'dropped credential-like attributes raise TRACE_ATTRIBUTE_DROPPED warnings', () => 
    {
        const root = new SpanImpl( 'x', { startTime : 1, attributes : { password : 'hunter-secret-value', ok : 'y' } } );

        root.end( 2 );

        const warnings: TraceWarningEvent[] = [];
        const attrs = exportTraceToOTLP( traceOf( root ), { onWarning : ( w ) => {warnings.push( w );} } ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;

        expect( attrs.map( ( a ) => {return a.key;} ) ).toEqual( [ 'ok' ] );
        expect( warnings.map( ( w ) => {return w.code;} ) ).toEqual( [ 'TRACE_ATTRIBUTE_DROPPED' ] );
        expect( JSON.stringify( warnings ) ).not.toContain( 'hunter-secret-value' );
    } );
} );

describe( 'sampling (R15, AE9)', () => 
{
    function complete( collector: TraceCollector, fail = false, name = 'job' ): Trace
    {
        const { trace, rootSpan } = collector.startTrace( { name } );

        if( fail )
        {
            rootSpan.status = 'error';
        }

        rootSpan.end();

        return collector.endTrace( trace.traceId )!;
    }

    it( 'AE9: sampleRate 0 drops healthy traces and keeps errored ones', async () => 
    {
        const collector = new TraceCollector();
        const { fetch, bodies } = sink();
        const exporter = new OTLPHttpExporter( { fetch, sampleRate : 0 } );

        exporter.attach( collector );
        complete( collector );
        complete( collector );
        const bad = complete( collector, true );
        await exporter.forceFlush();

        expect( bodies ).toHaveLength( 1 );
        expect( bodies[0] ).toContain( bad.traceId );
        expect( exporter.stats ).toMatchObject( { sampledOut : 2, exportedTraces : 1 } );
        await exporter.shutdown();
    } );

    it( 'a nested errored span also keeps the trace; alwaysSampleErrors:false disables that', async () => 
    {
        const collector = new TraceCollector();
        const { trace, rootSpan, context } = collector.startTrace( { name : 'job' } );

        await context.withSpan( 'child', async () => {throw new Error( 'x' );} ).catch( () => {} );
        rootSpan.end();
        collector.endTrace( trace.traceId );

        expect( hasErrorSpan( trace.rootSpan ) ).toBe( true );
        expect( createSampler( { sampleRate : 0 } )( trace ) ).toBe( true );
        expect( createSampler( { sampleRate : 0, alwaysSampleErrors : false } )( trace ) ).toBe( false );
    } );

    it( 'rate decisions are deterministic by traceId and track the requested fraction', () => 
    {
        const ids = Array.from( { length: 4000 }, ( _, i ) => {return createHash( 'sha256' ).update( String( i ) ).digest( 'hex' ).slice( 0, 32 );} );
        const first = ids.map( ( id ) => {return sampleByRate( id, 0.25 );} );
        const second = ids.map( ( id ) => {return sampleByRate( id, 0.25 );} );
        const kept = first.filter( Boolean ).length / ids.length;

        expect( first ).toEqual( second );
        expect( kept ).toBeGreaterThan( 0.15 );
        expect( kept ).toBeLessThan( 0.35 );
        expect( sampleByRate( 'abc', 1 ) ).toBe( true );
        expect( sampleByRate( 'abc', 0 ) ).toBe( false );
        expect( traceIdToUnit( '0'.repeat( 32 ) ) ).toBe( 0 );
        expect( traceIdToUnit( 'f'.repeat( 32 ) ) ).toBeLessThan( 1 );
        // Non-hex ids fall back to a stable hash.
        expect( traceIdToUnit( 'not-hex-trace-id' ) ).toBe( traceIdToUnit( 'not-hex-trace-id' ) );
        expect( traceIdToUnit( 'not-hex-trace-id' ) ).toBeGreaterThanOrEqual( 0 );
        expect( traceIdToUnit( 'not-hex-trace-id' ) ).toBeLessThan( 1 );
    } );

    it( 'stable known vectors: the same trace id always gets the same decision', () => 
    {
        expect( traceIdToUnit( '00000000000000000000000000000000'.slice( 0, 19 ) + '8000000000000' ) ).toBeCloseTo( 0.5, 10 );
        expect( sampleByRate( 'a'.repeat( 19 ) + '4000000000000', 0.3 ) ).toBe( true );
        expect( sampleByRate( 'a'.repeat( 19 ) + 'c000000000000', 0.3 ) ).toBe( false );
    } );

    it( 'custom sampler combines with rate by AND; a throwing sampler keeps the trace and warns', async () => 
    {
        const collector = new TraceCollector();
        const { fetch, bodies } = sink();
        const errors: TraceWarningEvent[] = [];
        const exporter = new OTLPHttpExporter( { fetch, sampler : ( t ) => {return t.rootSpan.name === 'keep';}, onError : ( e ) => {errors.push( e );} } );

        exporter.attach( collector );
        complete( collector, false, 'drop' );
        const kept = complete( collector, false, 'keep' );
        await exporter.forceFlush();
        expect( bodies ).toHaveLength( 1 );
        expect( bodies[0] ).toContain( kept.traceId );
        await exporter.shutdown();

        const boom = new OTLPHttpExporter( { fetch, sampler : () => {throw new Error( 'sampler bug' );}, onError : ( e ) => {errors.push( e );} } );

        await boom.export( complete( collector ) );
        expect( errors.map( ( e ) => {return e.code;} ) ).toContain( 'TRACE_SAMPLER_FAILED' );
        expect( boom.stats.exportedTraces ).toBe( 1 );
        await boom.shutdown();
    } );

    it( 'validates sampling options', () => 
    {
        expect( () => {return new OTLPHttpExporter( { sampleRate : 1.5 } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { sampleRate : -0.1 } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { sampleRate : Number.NaN } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { sampler : 'x' as never } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { sampleRate : 0.5 } );} ).not.toThrow();
    } );

    it( 'no sampling options keeps everything', async () => 
    {
        const collector = new TraceCollector();
        const { fetch, bodies } = sink();
        const exporter = new OTLPHttpExporter( { fetch } );

        exporter.attach( collector );

        for( let i = 0; i < 5; i++ ){ complete( collector ) }

        await exporter.forceFlush();
        expect( bodies ).toHaveLength( 1 );
        expect( exporter.stats.sampledOut ).toBe( 0 );
        await exporter.shutdown();
    } );
} );
