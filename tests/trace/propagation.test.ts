import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpanImpl } from '../../src/trace/span.js';
import { TraceCollector } from '../../src/trace/collector.js';
import { fromTraceparent, isValidSpanId, isValidTraceId, toTraceparent, traceparentFromMeta } from '../../src/trace/propagation.js';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { OpenAIEmbeddingAdapter } from '../../src/providers/openai-embeddings.js';
import { createMeteredModel } from '../../src/providers/metered.js';
import { SpendTracker } from '../../src/spend/index.js';
import { Agent } from '../../src/agent/index.js';
import { MCPClient, SSETransport, StreamableHTTPTransport } from '../../src/mcp/index.js';
import { jsonResponse, streamResponse } from '../helpers/http.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const VALID = `00-${TRACE}-${SPAN}-01`;

describe( 'W3C traceparent helpers (R16)', () => 
{
    it( 'round-trips a span through toTraceparent / fromTraceparent', () => 
    {
        const span = new SpanImpl( 'x' );
        const header = toTraceparent( span )!;
        const parsed = fromTraceparent( header )!;

        expect( header ).toMatch( /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/ );
        expect( parsed ).toEqual( { version : '00', traceId : span.traceId, spanId : span.id, flags : '01', sampled : true } );
        expect( toTraceparent( span, false ) ).toMatch( /-00$/ );
        expect( fromTraceparent( toTraceparent( span, false ) )!.sampled ).toBe( false );
    } );

    it( 'accepts the W3C spec example and unknown future versions with extra fields', () => 
    {
        expect( fromTraceparent( VALID ) ).toMatchObject( { traceId : TRACE, spanId : SPAN } );
        expect( fromTraceparent( `01-${TRACE}-${SPAN}-01-extra` ) ).toMatchObject( { version : '01', traceId : TRACE } );
    } );

    it.each( [
        [ 'undefined', undefined ],
        [ 'null', null ],
        [ 'empty', '' ],
        [ 'version ff', `ff-${TRACE}-${SPAN}-01` ],
        [ 'all-zero trace id', `00-${'0'.repeat( 32 )}-${SPAN}-01` ],
        [ 'all-zero span id', `00-${TRACE}-${'0'.repeat( 16 )}-01` ],
        [ 'uppercase hex', `00-${TRACE.toUpperCase()}-${SPAN}-01` ],
        [ 'short trace id', `00-${TRACE.slice( 1 )}-${SPAN}-01` ],
        [ 'non-hex', `00-${'g'.repeat( 32 )}-${SPAN}-01` ],
        [ 'missing flags', `00-${TRACE}-${SPAN}` ],
        [ 'v00 with extra field', `00-${TRACE}-${SPAN}-01-extra` ],
        [ 'bad flags', `00-${TRACE}-${SPAN}-zz` ],
        [ 'newline injection', `00-${TRACE}-${SPAN}-01\r\nx-evil: 1` ],
        [ 'oversized', `01-${TRACE}-${SPAN}-01-${'a'.repeat( 600 )}` ]
    ] as Array<[ string, string | null | undefined ]> )( 'rejects malformed headers: %s', ( _name, header ) => 
    {
        expect( fromTraceparent( header ) ).toBeUndefined();
    } );

    it( 'toTraceparent skips spans with non-W3C ids', () => 
    {
        expect( toTraceparent( { traceId : 'custom', id : SPAN } ) ).toBeUndefined();
        expect( toTraceparent( { traceId : TRACE, id : 'x' } ) ).toBeUndefined();
        expect( isValidTraceId( TRACE ) ).toBe( true );
        expect( isValidSpanId( SPAN ) ).toBe( true );
        expect( isValidTraceId( 5 ) ).toBe( false );
    } );

    it( 'traceparentFromMeta builds from MCP _meta and ignores garbage', () => 
    {
        expect( traceparentFromMeta( { traceId : TRACE, parentSpanId : SPAN } ) ).toBe( VALID );
        expect( traceparentFromMeta( { traceId : 'bad', parentSpanId : SPAN } ) ).toBeUndefined();
        expect( traceparentFromMeta( null ) ).toBeUndefined();
        expect( traceparentFromMeta( 'str' ) ).toBeUndefined();
    } );
} );

describe( 'provider header propagation', () => 
{
    const originalFetch = globalThis.fetch;

    afterEach( () => 
    {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    } );

    const chatBody = { choices : [ { message : { role : 'assistant', content : 'hi' }, finish_reason : 'stop' } ], usage : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 } };

    function stubFetch( body: unknown = chatBody )
    {
        const mock = vi.fn( async () => {return jsonResponse( body );} );

        vi.stubGlobal( 'fetch', mock );

        return mock;
    }

    const headersOf = ( mock: ReturnType<typeof stubFetch>, call = 0 ) => {return new Headers( ( mock.mock.calls[call] as unknown as [ string, RequestInit ] )[1].headers );};

    it( 'header absent by default, even when the request carries a traceparent', async () => 
    {
        const mock = stubFetch();

        await new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt', apiKey : 'k' } ).generate( { messages : [ { role : 'user', content : 'x' } ], traceparent : VALID } );

        expect( headersOf( mock ).has( 'traceparent' ) ).toBe( false );
    } );

    it( 'sends the header when propagateTraceContext is on and the request carries a valid traceparent', async () => 
    {
        const mock = stubFetch();
        const adapter = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt', apiKey : 'k', propagateTraceContext : true } );

        await adapter.generate( { messages : [ { role : 'user', content : 'x' } ], traceparent : VALID } );
        expect( headersOf( mock ).get( 'traceparent' ) ).toBe( VALID );
        expect( headersOf( mock ).get( 'authorization' ) ).toBe( 'Bearer k' );

        await adapter.generate( { messages : [ { role : 'user', content : 'x' } ] } );
        expect( headersOf( mock, 1 ).has( 'traceparent' ) ).toBe( false );

        await adapter.generate( { messages : [ { role : 'user', content : 'x' } ], traceparent : `${VALID}\r\nx-evil: 1` } );
        expect( headersOf( mock, 2 ).has( 'traceparent' ) ).toBe( false );
        expect( headersOf( mock, 2 ).has( 'x-evil' ) ).toBe( false );
    } );

    it( 'MeteredModel supplies the span-derived traceparent so an opted-in adapter propagates it', async () => 
    {
        const mock = stubFetch();
        const collector = new TraceCollector();
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const adapter = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt', apiKey : 'k', propagateTraceContext : true } );

        await createMeteredModel( adapter, { tracker : new SpendTracker(), context } ).generate( { messages : [ { role : 'user', content : 'x' } ] } );

        const parsed = fromTraceparent( headersOf( mock ).get( 'traceparent' ) )!;

        expect( parsed.traceId ).toBe( rootSpan.traceId );
        expect( parsed.spanId ).toBe( rootSpan.children[0]!.id );
    } );

    it( 'Agent model calls propagate the model span', async () => 
    {
        const mock = stubFetch();
        const collector = new TraceCollector();
        const adapter = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt', apiKey : 'k', propagateTraceContext : true } );
        let spanIds: string[] = [];

        collector.on( 'trace:complete', ( t ) => 
        {
            const walk = ( s: { name: string, id: string, children: any[] } ): void => 
            {
                if( s.name === 'model:generate' )
                {
                    spanIds.push( s.id );
                }
                s.children.forEach( walk );
            };

            walk( t.rootSpan );
        } );
        await new Agent( { model : adapter } ).run( 'hi', { collector } );
        expect( spanIds ).toHaveLength( 1 );
        expect( fromTraceparent( headersOf( mock ).get( 'traceparent' ) )!.spanId ).toBe( spanIds[0] );
        spanIds = [];
    } );

    it( 'embeddings propagate too', async () => 
    {
        const mock = stubFetch( { data : [ { embedding : [ 0.1 ] } ], usage : { prompt_tokens : 1, total_tokens : 1 } } );
        const adapter = new OpenAIEmbeddingAdapter( { provider : 'openai', model : 'text-embedding-3-small', apiKey : 'k', propagateTraceContext : true } );

        await adapter.embed( 'x', { traceparent : VALID } );
        expect( headersOf( mock ).get( 'traceparent' ) ).toBe( VALID );
    } );
} );

describe( 'MCP header propagation', () => 
{
    const callMessage = ( meta?: unknown ) => 
    {
        return { jsonrpc : '2.0' as const, method : 'notifications/x', params : { ...( meta ? { _meta : meta } : {} ) } };
    };

    function httpRig()
    {
        const calls: Headers[] = [];
        const impl = async ( _url: unknown, init?: RequestInit ): Promise<Response> => 
        {
            calls.push( new Headers( init?.headers ) );

            return new Response( null, { status : 202 } );
        };

        return { fetch : impl as unknown as typeof fetch, calls };
    }

    it( 'StreamableHTTPTransport: no header by default, header from _meta ids when enabled', async () => 
    {
        const off = httpRig();
        const offTransport = new StreamableHTTPTransport( 'https://mcp.example/rpc', { fetch : off.fetch } );

        await offTransport.connect();
        await offTransport.send( callMessage( { traceId : TRACE, parentSpanId : SPAN } ) );
        expect( off.calls[0]!.has( 'traceparent' ) ).toBe( false );

        const on = httpRig();
        const onTransport = new StreamableHTTPTransport( 'https://mcp.example/rpc', { fetch : on.fetch, propagateTraceContext : true } );

        await onTransport.connect();
        await onTransport.send( callMessage( { traceId : TRACE, parentSpanId : SPAN } ) );
        await onTransport.send( callMessage() );
        await onTransport.send( callMessage( { traceId : 'bad', parentSpanId : SPAN } ) );

        expect( on.calls[0]!.get( 'traceparent' ) ).toBe( VALID );
        expect( on.calls[0]!.get( 'content-type' ) ).toBe( 'application/json' );
        expect( on.calls[1]!.has( 'traceparent' ) ).toBe( false );
        expect( on.calls[2]!.has( 'traceparent' ) ).toBe( false );
        expect( MCPClient ).toBeDefined();
    } );

    it( 'SSETransport honors the same flag', async () => 
    {
        for( const flag of [ false, true ] )
        {
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const stream = new ReadableStream<Uint8Array>( { start( c ) {controller = c;} } );
            const posts: Headers[] = [];
            const impl = async ( _url: unknown, init?: RequestInit ): Promise<Response> => 
            {
                if( ( init?.method ?? 'GET' ) === 'GET' )
                {
                    return streamResponse( stream );
                }

                posts.push( new Headers( init?.headers ) );

                return new Response( null, { status : 202 } );
            };
            const transport = new SSETransport( 'https://mcp.example/sse', { fetch : impl as unknown as typeof fetch, propagateTraceContext : flag } );
            const connecting = transport.connect();

            controller.enqueue( new TextEncoder().encode( 'event: endpoint\ndata: /messages?s=1\n\n' ) );
            await connecting;
            await transport.send( callMessage( { traceId : TRACE, parentSpanId : SPAN } ) );
            expect( posts[0]!.get( 'traceparent' ) ?? null ).toBe( flag ? VALID : null );
            await transport.close();
        }
    } );
} );
