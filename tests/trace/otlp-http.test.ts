import { describe, it, expect, vi, afterEach } from 'vitest';
import { TraceCollector } from '../../src/trace/collector.js';
import { OTLPHttpExporter, parseRetryAfter, type OTLPFetch } from '../../src/trace/otlp-http.js';
import { AIError } from '../../src/core/error.js';
import type { TraceWarningEvent } from '../../src/trace/types.js';

type Call = { url: string, headers: Record<string, string>, body: any, signal: AbortSignal };

function reply( status: number, headers: Record<string, string> = {}, text = '' )
{
    return { ok : status >= 200 && status < 300, status, headers : new Headers( headers ), text : async () => {return text;} };
}

function fakeFetch( responder: ( n: number, call: Call ) => ReturnType<OTLPFetch> | ReturnType<typeof reply> = () => {return reply( 200 );} )
{
    const calls: Call[] = [];
    const fetch: OTLPFetch = async ( url, init ) => 
    {
        const call: Call = { url, headers : init.headers, body : JSON.parse( init.body ), signal : init.signal };

        calls.push( call );

        return await responder( calls.length, call );
    };

    return { fetch, calls };
}

function complete( collector: TraceCollector, name = 'agent:run', fail = false ): string
{
    const { trace, rootSpan } = collector.startTrace( { name } );

    if( fail )
    {
        rootSpan.status = 'error';
        rootSpan.errorDetails = { message : 'boom', name : 'Error' };
    }

    rootSpan.end();
    collector.endTrace( trace.traceId );

    return trace.traceId;
}

const spansOf = ( call: Call ) => {return call.body.resourceSpans.flatMap( ( r: any ) => {return r.scopeSpans.flatMap( ( s: any ) => {return s.spans;} );} );};

describe( 'OTLPHttpExporter', () => 
{
    afterEach( () => 
    {
        vi.useRealTimers();
    } );

    it( 'AE1: batches 40 traces into 32 + 8 with content-type and custom headers', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const collector = new TraceCollector();
        const exporter = new OTLPHttpExporter( { fetch, headers : { authorization : 'Bearer t' }, endpoint : 'http://collector.test/v1/traces', serviceName : 'svc' } );

        exporter.attach( collector );

        for( let i = 0; i < 40; i++ ){complete( collector );}

        await exporter.forceFlush();

        expect( calls ).toHaveLength( 2 );
        expect( calls.map( ( c ) => {return spansOf( c ).length;} ) ).toEqual( [ 32, 8 ] );
        expect( calls[0]!.url ).toBe( 'http://collector.test/v1/traces' );
        expect( calls[0]!.headers['content-type'] ).toBe( 'application/json' );
        expect( calls[0]!.headers.authorization ).toBe( 'Bearer t' );
        expect( calls[0]!.body.resourceSpans ).toHaveLength( 1 );
        expect( exporter.stats ).toMatchObject( { exportedTraces : 40, exportedBatches : 2, queued : 0 } );
        await exporter.shutdown();
    } );

    it( 'sends a partial batch after scheduleDelayMs and keeps timers unref()ed', async () => 
    {
        vi.useFakeTimers();

        const { fetch, calls } = fakeFetch();
        const collector = new TraceCollector();
        const exporter = new OTLPHttpExporter( { fetch, scheduleDelayMs : 1000 } );

        exporter.attach( collector );
        complete( collector );
        expect( calls ).toHaveLength( 0 );

        await vi.advanceTimersByTimeAsync( 999 );
        expect( calls ).toHaveLength( 0 );
        await vi.advanceTimersByTimeAsync( 2 );
        expect( calls ).toHaveLength( 1 );
        await exporter.shutdown();
    } );

    it( 'does not hold the event loop open with a pending schedule timer', async () => 
    {
        const { fetch } = fakeFetch();
        const collector = new TraceCollector();
        const before = process.getActiveResourcesInfo().filter( ( r ) => {return r === 'Timeout';} ).length;
        const exporter = new OTLPHttpExporter( { fetch, scheduleDelayMs : 60_000 } );

        exporter.attach( collector );
        complete( collector );

        const during = process.getActiveResourcesInfo().filter( ( r ) => {return r === 'Timeout';} ).length;

        expect( during ).toBe( before );
        await exporter.shutdown();
    } );

    it( 'AE2: retries 503 twice with growing delays, then succeeds without a warning', async () => 
    {
        const { fetch, calls } = fakeFetch( ( n ) => {return n < 3 ? reply( 503 ) : reply( 200 );} );
        const delays: number[] = [];
        const collector = new TraceCollector();
        const warnings: TraceWarningEvent[] = [];

        collector.on( 'warning', ( w ) => {warnings.push( w );} );

        const exporter = new OTLPHttpExporter( { fetch, random : () => {return 0;}, sleep : async ( ms ) => {delays.push( ms );} } );

        exporter.attach( collector );
        complete( collector );
        await exporter.forceFlush();

        expect( calls ).toHaveLength( 3 );
        expect( delays ).toHaveLength( 2 );
        expect( delays[1] ).toBeGreaterThan( delays[0]! );
        expect( warnings ).toEqual( [] );
        expect( exporter.stats ).toMatchObject( { retries : 2, exportedTraces : 1, failedTraces : 0 } );
        await exporter.shutdown();
    } );

    it.each( [ 408, 429, 502, 504 ] )( 'retries HTTP %i', async ( status ) => 
    {
        const { fetch, calls } = fakeFetch( ( n ) => {return n === 1 ? reply( status ) : reply( 200 );} );
        const exporter = new OTLPHttpExporter( { fetch, sleep : async () => {} } );

        await exporter.export( complete2() );
        expect( calls ).toHaveLength( 2 );
        await exporter.shutdown();
    } );

    it( 'honors Retry-After seconds (capped) and HTTP dates', async () => 
    {
        const { fetch } = fakeFetch( ( n ) => {return n === 1 ? reply( 429, { 'retry-after' : '7' } ) : n === 2 ? reply( 503, { 'retry-after' : '9999' } ) : reply( 200 );} );
        const delays: number[] = [];
        const exporter = new OTLPHttpExporter( { fetch, maxRetryDelayMs : 20_000, sleep : async ( ms ) => {delays.push( ms );} } );

        await exporter.export( complete2() );
        expect( delays ).toEqual( [ 7000, 20_000 ] );
        expect( parseRetryAfter( '3' ) ).toBe( 3000 );
        expect( parseRetryAfter( new Date( 10_000 ).toUTCString(), 4_000 ) ).toBe( 6000 );
        expect( parseRetryAfter( 'nonsense' ) ).toBeUndefined();
        expect( parseRetryAfter( null ) ).toBeUndefined();
        await exporter.shutdown();
    } );

    it( 'retries network errors and gives up after maxRetries with TRACE_EXPORT_FAILED', async () => 
    {
        const { fetch, calls } = fakeFetch( () => {throw new Error( 'ECONNRESET' );} );
        const collector = new TraceCollector();
        const warnings: TraceWarningEvent[] = [];

        collector.on( 'warning', ( w ) => {warnings.push( w );} );

        const exporter = new OTLPHttpExporter( { fetch, maxRetries : 2, sleep : async () => {} } );

        exporter.attach( collector );
        complete( collector );
        await exporter.forceFlush();

        expect( calls ).toHaveLength( 3 );
        expect( warnings ).toHaveLength( 1 );
        expect( warnings[0]!.code ).toBe( 'TRACE_EXPORT_FAILED' );
        expect( ( warnings[0]!.details as any ).attempts ).toBe( 3 );
        expect( warnings[0]!.message ).toContain( 'ECONNRESET' );
        expect( exporter.stats.failedTraces ).toBe( 1 );
        await exporter.shutdown();
    } );

    it( 'AE3: 401 fails immediately with a TRACE_EXPORT_FAILED warning carrying the status, never throwing', async () => 
    {
        const { fetch, calls } = fakeFetch( () => {return reply( 401, {}, 'unauthorized' );} );
        const collector = new TraceCollector();
        const warnings: TraceWarningEvent[] = [];

        collector.on( 'warning', ( w ) => {warnings.push( w );} );

        const exporter = new OTLPHttpExporter( { fetch, sleep : async () => {throw new Error( 'must not sleep' );} } );

        exporter.attach( collector );
        expect( () => {return complete( collector );} ).not.toThrow();
        await expect( exporter.forceFlush() ).resolves.toBeUndefined();

        expect( calls ).toHaveLength( 1 );
        expect( warnings ).toHaveLength( 1 );
        expect( warnings[0]!.code ).toBe( 'TRACE_EXPORT_FAILED' );
        expect( ( warnings[0]!.details as any ).status ).toBe( 401 );
        expect( warnings[0]!.message ).toContain( 'unauthorized' );
        await exporter.shutdown();
    } );

    it( 'does not leak URL credentials or headers into warnings', async () => 
    {
        const { fetch } = fakeFetch( () => {return reply( 401 );} );
        const errors: TraceWarningEvent[] = [];
        const exporter = new OTLPHttpExporter( { fetch, endpoint : 'https://user:pw@host.test/v1/traces?key=SECRET', headers : { authorization : 'Bearer SECRET2' }, onError : ( e ) => {errors.push( e );} } );

        await exporter.export( complete2() );
        expect( JSON.stringify( errors ) ).not.toMatch( /SECRET|pw@/ );
        expect( errors[0]!.message ).toContain( 'https://host.test/v1/traces' );
        await exporter.shutdown();
    } );

    it( 'AE4: drops oldest on overflow and reports one coalesced warning with the count', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const collector = new TraceCollector();
        const warnings: TraceWarningEvent[] = [];

        collector.on( 'warning', ( w ) => {warnings.push( w );} );

        const exporter = new OTLPHttpExporter( { fetch, maxQueueTraces : 4, scheduleDelayMs : 60_000 } );

        exporter.attach( collector );

        const ids: string[] = [];

        for( let i = 0; i < 10; i++ ){ids.push( complete( collector ) );}

        await Promise.resolve();
        expect( warnings ).toHaveLength( 1 );
        expect( warnings[0]!.code ).toBe( 'TRACE_EXPORT_DROPPED' );
        expect( ( warnings[0]!.details as any ).dropped ).toBe( 6 );

        await exporter.forceFlush();
        expect( spansOf( calls[0]! ).map( ( s: any ) => {return s.traceId;} ) ).toEqual( ids.slice( 6 ) );
        expect( exporter.stats.droppedTraces ).toBe( 6 );
        await exporter.shutdown();
    } );

    it( 'bounds the queue while a request is blocked', async () => 
    {
        let release!: () => void;
        const gate = new Promise<void>( ( r ) => {release = r;} );
        const { fetch, calls } = fakeFetch( async () => {await gate; return reply( 200 );} );
        const collector = new TraceCollector();
        const exporter = new OTLPHttpExporter( { fetch, maxBatchTraces : 2, maxQueueTraces : 3 } );

        exporter.attach( collector );

        for( let i = 0; i < 12; i++ ){complete( collector );}

        expect( exporter.stats.queued ).toBeLessThanOrEqual( 3 );
        expect( exporter.stats.droppedTraces ).toBe( 12 - 2 - 3 );
        release();
        await exporter.forceFlush();
        expect( calls.length ).toBeGreaterThan( 1 );
        await exporter.shutdown();
    } );

    it( 'aborts a hung request at timeoutMs and retries it', async () => 
    {
        const { fetch, calls } = fakeFetch( ( n ) => 
        {
            if( n === 1 )
            {
                return new Promise( () => {} ) as any;
            }

            return reply( 200 );
        } );
        const exporter = new OTLPHttpExporter( { fetch, timeoutMs : 20, sleep : async () => {} } );

        await exporter.export( complete2() );
        expect( calls ).toHaveLength( 2 );
        expect( calls[0]!.signal.aborted ).toBe( true );
        expect( exporter.stats.exportedTraces ).toBe( 1 );
        await exporter.shutdown();
    } );

    it( 'attach is idempotent and detach stops delivery', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const collector = new TraceCollector();
        const exporter = new OTLPHttpExporter( { fetch } );
        const detach = exporter.attach( collector );

        expect( exporter.attach( collector ) ).toBe( detach );
        expect( collector.listenerCount( 'trace:complete' ) ).toBe( 1 );

        complete( collector );
        detach();
        detach();
        expect( collector.listenerCount( 'trace:complete' ) ).toBe( 0 );
        complete( collector );
        await exporter.forceFlush();

        expect( calls.map( spansOf ).flat() ).toHaveLength( 1 );
        await exporter.shutdown();
    } );

    it( 'AE5: shutdown flushes queued traces, then export rejects with TRACE_EXPORTER_SHUTDOWN', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const collector = new TraceCollector();
        const exporter = new OTLPHttpExporter( { fetch, scheduleDelayMs : 60_000 } );

        exporter.attach( collector );
        complete( collector );
        complete( collector );
        await exporter.shutdown();

        expect( calls ).toHaveLength( 1 );
        expect( collector.listenerCount( 'trace:complete' ) ).toBe( 0 );
        await expect( exporter.export( complete2() ) ).rejects.toMatchObject( { code : 'TRACE_EXPORTER_SHUTDOWN' } );
        await expect( exporter.export( complete2() ) ).rejects.toBeInstanceOf( AIError );
        expect( () => {return exporter.attach( collector );} ).toThrow( AIError );
        await expect( exporter.shutdown() ).resolves.toBeUndefined();
    } );

    it( 'shutdown with a stuck in-flight request is bounded by timeoutMs and aborts it', async () => 
    {
        const { fetch, calls } = fakeFetch( () => {return new Promise( () => {} ) as any;} );
        const warnings: TraceWarningEvent[] = [];
        const exporter = new OTLPHttpExporter( { fetch, timeoutMs : 50, maxRetries : 0, onError : ( w ) => {warnings.push( w );} } );
        const started = Date.now();

        void exporter.export( complete2() );
        await exporter.shutdown();

        expect( Date.now() - started ).toBeLessThan( 1000 );
        expect( calls[0]!.signal.aborted ).toBe( true );
        expect( warnings.some( ( w ) => {return w.code === 'TRACE_EXPORT_DROPPED' || w.code === 'TRACE_EXPORT_FAILED';} ) ).toBe( true );
    } );

    it( 'manual export() posts a single trace and reports failures through onError only', async () => 
    {
        const { fetch } = fakeFetch( () => {return reply( 400 );} );
        const errors: TraceWarningEvent[] = [];
        const exporter = new OTLPHttpExporter( { fetch, onError : ( e ) => {errors.push( e );} } );

        await expect( exporter.export( complete2() ) ).resolves.toBeUndefined();
        expect( errors.map( ( e ) => {return e.code;} ) ).toEqual( [ 'TRACE_EXPORT_FAILED' ] );
        await exporter.shutdown();
    } );

    it( 'surfaces OTLP partialSuccess rejections', async () => 
    {
        const { fetch } = fakeFetch( () => {return reply( 200, {}, JSON.stringify( { partialSuccess : { rejectedSpans : '3', errorMessage : 'bad span' } } ) );} );
        const errors: TraceWarningEvent[] = [];
        const exporter = new OTLPHttpExporter( { fetch, onError : ( e ) => {errors.push( e );} } );

        await exporter.export( complete2() );
        expect( errors[0]!.code ).toBe( 'TRACE_EXPORT_PARTIAL' );
        expect( errors[0]!.message ).toContain( 'bad span' );
        await exporter.shutdown();
    } );

    it( 'survives throwing warning listeners', async () => 
    {
        const { fetch } = fakeFetch( () => {return reply( 400 );} );
        const collector = new TraceCollector();

        collector.on( 'warning', () => {throw new Error( 'listener bug' );} );

        const exporter = new OTLPHttpExporter( { fetch, onError : () => {throw new Error( 'handler bug' );} } );

        exporter.attach( collector );
        complete( collector );
        await expect( exporter.forceFlush() ).resolves.toBeUndefined();
        await exporter.shutdown();
    } );

    it( 'validates options and requires a fetch', () => 
    {
        const { fetch } = fakeFetch();

        expect( () => {return new OTLPHttpExporter( { fetch, timeoutMs : 0 } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { fetch, maxBatchTraces : Number.NaN } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { fetch, maxRetries : -1 } );} ).toThrow( AIError );
        expect( () => {return new OTLPHttpExporter( { fetch, maxRetries : 0 } );} ).not.toThrow();

        vi.stubGlobal( 'fetch', undefined );
        expect( () => {return new OTLPHttpExporter();} ).toThrow( /fetch/ );
        vi.unstubAllGlobals();
    } );

    it( 'defaults to the local collector endpoint', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const exporter = new OTLPHttpExporter( { fetch } );

        await exporter.export( complete2() );
        expect( calls[0]!.url ).toBe( 'http://localhost:4318/v1/traces' );
        await exporter.shutdown();
    } );

    it( 'encodes resource attributes and an unfinished-safe payload', async () => 
    {
        const { fetch, calls } = fakeFetch();
        const exporter = new OTLPHttpExporter( { fetch, serviceName : 'svc', serviceVersion : '9', resourceAttributes : { 'deployment.environment' : 'prod' } } );

        await exporter.export( complete2() );

        const attrs = calls[0]!.body.resourceSpans[0].resource.attributes.map( ( a: any ) => {return a.key;} );

        expect( attrs ).toEqual( [ 'service.name', 'service.version', 'deployment.environment' ] );
        await exporter.shutdown();
    } );
} );

function complete2()
{
    const collector = new TraceCollector();
    const { trace, rootSpan } = collector.startTrace( { name : 'agent:run' } );

    rootSpan.end();

    return collector.endTrace( trace.traceId )!;
}
