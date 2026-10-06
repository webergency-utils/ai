import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { GroqProviderAdapter } from '../../src/providers/groq.js';
import { CapabilityError } from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

function lastCall(): { body: Record<string, any>, headers: Record<string, string> }
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;
    const init = call[ 1 ] as RequestInit;

    return { body : JSON.parse( init.body as string ), headers : init.headers as Record<string, string> };
}

const anthropicOk = (): Response => 
{
    return jsonResponse( {
        content     : [ { type : 'text', text : 'ok' } ],
        stop_reason : 'end_turn',
        usage       : { input_tokens : 10, output_tokens : 2, cache_read_input_tokens : 800, cache_creation_input_tokens : 100 }
    } );
};

describe( 'prompt cache controls', () =>
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
    } );

    const anthropic = (): AnthropicProviderAdapter => {return new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );};

    it( 'Anthropic emits a cache_control system block when a system message requests it', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( anthropicOk() );

        await anthropic().generate( {
            systemPrompt : 'base',
            messages     : [
                { role : 'system', content : 'long context', cacheControl : { type : 'ephemeral' } },
                { role : 'user', content : 'q' }
            ]
        } );

        expect( lastCall().body.system ).toEqual( [
            { type : 'text', text : 'base' },
            { type : 'text', text : 'long context', cache_control : { type : 'ephemeral' } }
        ] );
    } );

    it( 'Anthropic keeps system as a plain string when no cache control is requested', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( anthropicOk() );

        await anthropic().generate( {
            messages : [ { role : 'system', content : 'a' }, { role : 'system', content : 'b' }, { role : 'user', content : 'q' } ]
        } );

        expect( lastCall().body.system ).toBe( 'a\n\nb' );
    } );

    it( 'Anthropic marks the last block of cached user/assistant/tool messages and forwards ttl with the beta flag', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( anthropicOk() );

        await anthropic().generate( {
            messages : [
                { role : 'user', content : 'big doc', cacheControl : { type : 'ephemeral', ttl : '1h' } },
                { role : 'assistant', content : 'calling', toolCalls : [ { id : 't1', name : 'f', arguments : {} } ], cacheControl : { type : 'ephemeral' } },
                { role : 'tool', content : 'result', toolCallId : 't1', cacheControl : { type : 'ephemeral' } }
            ]
        } );

        const { body, headers } = lastCall();

        expect( body.messages[ 0 ].content ).toEqual( [ { type : 'text', text : 'big doc', cache_control : { type : 'ephemeral', ttl : '1h' } } ] );
        expect( body.messages[ 1 ].content[ 0 ].cache_control ).toBeUndefined();
        expect( body.messages[ 1 ].content[ 1 ].cache_control ).toEqual( { type : 'ephemeral' } );
        expect( body.messages[ 2 ].content[ 0 ].cache_control ).toEqual( { type : 'ephemeral' } );
        expect( headers[ 'anthropic-beta' ] ).toContain( 'extended-cache-ttl' );
    } );

    it( 'Anthropic omits the extended-ttl beta flag when no ttl is used and still reports cache usage', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( anthropicOk() );

        const res = await anthropic().generate( {
            messages : [ { role : 'user', content : 'q', cacheControl : { type : 'ephemeral' } } ]
        } );

        expect( lastCall().headers[ 'anthropic-beta' ] ).not.toContain( 'extended-cache-ttl' );
        expect( res.usage?.cachedPromptReadTokens ).toBe( 800 );
        expect( res.usage?.cachedPromptWriteTokens ).toBe( 100 );
    } );

    it( 'Groq fails with a prompt-cache capability error before fetch (AE8)', async () =>
    {
        const groq = new GroqProviderAdapter( { provider : 'groq', model : 'm', apiKey : 'k' } );
        const promise = groq.generate( {
            messages : [ { role : 'system', content : 'x', cacheControl : { type : 'ephemeral' } }, { role : 'user', content : 'q' } ]
        } );

        await expect( promise ).rejects.toBeInstanceOf( CapabilityError );
        await expect( promise ).rejects.toThrow( /promptCacheControl/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'Gemini and OpenAI reject message-level cacheControl', async () =>
    {
        const gemini = new GeminiProviderAdapter( { provider : 'gemini', model : 'g', apiKey : 'k' } );
        const openai = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );
        const request = { messages : [ { role : 'user' as const, content : 'x', cacheControl : { type : 'ephemeral' as const } } ] };

        await expect( gemini.generate( request ) ).rejects.toThrow( /promptCacheControl/ );
        await expect( openai.generate( request ) ).rejects.toThrow( /promptCacheControl/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'OpenAI maps promptCacheKey to prompt_cache_key; others reject it', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ] } ) );

        const openai = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );

        await openai.generate( { messages : [ { role : 'user', content : 'x' } ], promptCacheKey : 'tenant-1' } );
        expect( lastCall().body.prompt_cache_key ).toBe( 'tenant-1' );

        const groq = new GroqProviderAdapter( { provider : 'groq', model : 'm', apiKey : 'k' } );

        await expect( groq.generate( { messages : [ { role : 'user', content : 'x' } ], promptCacheKey : 'k' } ) )
            .rejects.toBeInstanceOf( CapabilityError );
        await expect( anthropic().generate( { messages : [ { role : 'user', content : 'x' } ], promptCacheKey : 'k' } ) )
            .rejects.toBeInstanceOf( CapabilityError );
    } );
} );
