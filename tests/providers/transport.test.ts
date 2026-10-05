import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { parseRetryAfterMs, computeBackoffMs } from '../../src/providers/base.js';
import { CancelledError, QuotaExceededError, RateLimitError } from '../../src/core/error.js';
import { jsonResponse } from '../helpers/http.js';

describe( 'parseRetryAfterMs', () => 
{
    it( 'parses seconds, retry-after-ms, and HTTP-date relative to Date header', () => 
    {
        expect( parseRetryAfterMs( new Headers( { 'retry-after' : '3' } ) ) ).toBe( 3000 );
        expect( parseRetryAfterMs( new Headers( { 'retry-after-ms' : '1500' } ) ) ).toBe( 1500 );

        const headers = new Headers( {
            'retry-after' : 'Wed, 21 Oct 2015 07:28:03 GMT',
            date          : 'Wed, 21 Oct 2015 07:28:00 GMT'
        } );

        expect( parseRetryAfterMs( headers ) ).toBe( 3000 );
    } );
} );

describe( 'computeBackoffMs', () => 
{
    it( 'grows exponentially with jitter under the 8s cap', () => 
    {
        const a0 = computeBackoffMs( 0 );
        const a3 = computeBackoffMs( 3 );

        expect( a0 ).toBeGreaterThanOrEqual( 375 );
        expect( a0 ).toBeLessThanOrEqual( 500 );
        expect( a3 ).toBeGreaterThanOrEqual( 3000 );
        expect( a3 ).toBeLessThanOrEqual( 4000 );
    } );
} );

describe( 'BaseProviderAdapter.request transport', () => 
{
    const originalFetch = globalThis.fetch;

    beforeEach( () => 
    {
        vi.stubGlobal( 'fetch', vi.fn() );
    } );

    afterEach( () => 
    {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        vi.useRealTimers();
    } );

    it( 'uses distinct Authorization headers for different apiKeys (AE2)', async () => 
    {
        vi.mocked( fetch ).mockImplementation( async () => {return jsonResponse( {
            choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ],
            usage   : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 }
        } );} );

        const a = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'key-a'
        } );
        const b = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'key-b'
        } );

        await a.generate( { messages : [ { role : 'user', content : 'hi' } ] } );
        await b.generate( { messages : [ { role : 'user', content : 'hi' } ] } );

        const calls = vi.mocked( fetch ).mock.calls;
        const authA = ( calls[0][1] as RequestInit ).headers as Record<string, string>;
        const authB = ( calls[1][1] as RequestInit ).headers as Record<string, string>;

        expect( authA.Authorization ).toBe( 'Bearer key-a' );
        expect( authB.Authorization ).toBe( 'Bearer key-b' );
    } );

    it( 'honors HTTP-date retry-after under fake timers (AE3)', async () => 
    {
        vi.useFakeTimers();

        const now = Date.parse( 'Wed, 21 Oct 2015 07:28:00 GMT' );
        vi.setSystemTime( now );

        vi.mocked( fetch )
            .mockResolvedValueOnce( new Response( 
                JSON.stringify( { error : { message : 'slow down' } } ), 
                {
                    status  : 429,
                    headers : {
                        'retry-after' : 'Wed, 21 Oct 2015 07:28:03 GMT',
                        date          : 'Wed, 21 Oct 2015 07:28:00 GMT'
                    }
                } 
            ) )
            .mockResolvedValueOnce( jsonResponse( {
                choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ],
                usage   : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 }
            } ) );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock'
        } );

        const pending = adapter.generate( { messages : [ { role : 'user', content : 'hi' } ] } );
        await vi.advanceTimersByTimeAsync( 3000 );
        const res = await pending;

        expect( res.content ).toBe( 'ok' );
        expect( fetch ).toHaveBeenCalledTimes( 2 );
    } );

    it( 'fails immediately when retry-after exceeds 60s (AE15)', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( new Response( 
            JSON.stringify( { error : { message : 'rate limited' } } ), 
            {
                status  : 429,
                headers : { 'retry-after' : '120' }
            } 
        ) );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock'
        } );

        const err = await adapter.generate( { messages : [ { role : 'user', content : 'hi' } ] } )
            .then( () => {throw new Error( 'expected throw' );} )
            .catch( ( e: unknown ) => {return e;} );

        expect( err ).toBeInstanceOf( RateLimitError );
        expect( ( err as RateLimitError ).retryAfterSeconds ).toBe( 120 );
        expect( fetch ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'does not retry quota/billing 429s', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( new Response( 
            JSON.stringify( { error : { message : 'out of credits', code : 'insufficient_quota' } } ), 
            { status : 429, headers : { 'retry-after' : '1' } } 
        ) );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock'
        } );

        await expect( adapter.generate( { messages : [ { role : 'user', content : 'hi' } ] } ) )
            .rejects
            .toThrow( QuotaExceededError );

        expect( fetch ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'turns caller abort mid-backoff into CancelledError without further retries', async () => 
    {
        vi.useFakeTimers();

        vi.mocked( fetch ).mockResolvedValue( new Response( 
            JSON.stringify( { error : { message : 'busy' } } ), 
            {
                status  : 429,
                headers : { 'retry-after' : '5' }
            } 
        ) );

        const controller = new AbortController();
        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock'
        } );

        const pending = adapter.generate( {
            messages : [ { role : 'user', content : 'hi' } ],
            signal   : controller.signal
        } );

        // Let the first 429 classify and enter backoff sleep.
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync( 1 );
        controller.abort();

        await expect( pending ).rejects.toThrow( CancelledError );
        expect( fetch ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'exposes retry attempts via onAttempt before the next try (R59)', async () => 
    {
        vi.useFakeTimers();

        vi.mocked( fetch )
            .mockResolvedValueOnce( new Response( 
                JSON.stringify( { error : { message : 'server error' } } ), 
                { status : 500, headers : {} } 
            ) )
            .mockResolvedValueOnce( jsonResponse( {
                choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ],
                usage   : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 }
            } ) );

        const attempts: number[] = [];
        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock'
        } );

        const pending = adapter.generate( {
            messages  : [ { role : 'user', content : 'hi' } ],
            onAttempt : ( info ) => 
            {
                attempts.push( info.attempt );
            }
        } );

        await vi.advanceTimersByTimeAsync( 10_000 );
        await pending;

        expect( attempts.length ).toBeGreaterThanOrEqual( 1 );
        expect( attempts[0] ).toBe( 2 );
        expect( fetch ).toHaveBeenCalledTimes( 2 );
    } );
} );
