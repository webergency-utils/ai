import { describe, it, expect, vi } from 'vitest';
import { ModelRegistry, createModel } from '../../src/providers/registry.js';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { GroqProviderAdapter } from '../../src/providers/groq.js';
import { OllamaProviderAdapter } from '../../src/providers/ollama.js';
import { DeepSeekProviderAdapter } from '../../src/providers/deepseek.js';
import { MistralProviderAdapter } from '../../src/providers/mistral.js';
import { ProviderError } from '../../src/core/error.js';
import { jsonResponse } from '../helpers/http.js';

describe( 'ModelRegistry', () => 
{
    it( 'should resolve default built-in providers', () => 
    {
        const registry = new ModelRegistry();

        const openai = registry.resolve( 'openai', { model : 'gpt-4o' } );
        expect( openai ).toBeInstanceOf( OpenAIProviderAdapter );
        expect( openai.model ).toBe( 'gpt-4o' );

        const anthropic = registry.resolve( 'anthropic', { model : 'claude-3-7-sonnet' } );
        expect( anthropic ).toBeInstanceOf( AnthropicProviderAdapter );

        const gemini = registry.resolve( 'gemini', { model : 'gemini-2.5-flash' } );
        expect( gemini ).toBeInstanceOf( GeminiProviderAdapter );

        const groq = registry.resolve( 'groq', { model : 'llama-3.3-70b-versatile' } );
        expect( groq ).toBeInstanceOf( GroqProviderAdapter );

        const ollama = registry.resolve( 'ollama', { model : 'llama3' } );
        expect( ollama ).toBeInstanceOf( OllamaProviderAdapter );

        const deepseek = registry.resolve( 'deepseek', { model : 'deepseek-chat' } );
        expect( deepseek ).toBeInstanceOf( DeepSeekProviderAdapter );
        expect( ( deepseek as DeepSeekProviderAdapter ).config.baseUrl ).toBe( 'https://api.deepseek.com' );

        const mistral = registry.resolve( 'mistral', { model : 'mistral-large-latest' } );
        expect( mistral ).toBeInstanceOf( MistralProviderAdapter );
        expect( ( mistral as MistralProviderAdapter ).config.baseUrl ).toBe( 'https://api.mistral.ai/v1' );
    } );

    it( 'should cache and return the same adapter instance for identical configs', () => 
    {
        const registry = new ModelRegistry();

        const model1 = registry.create( { provider : 'openai', model : 'gpt-4o' } );
        const model2 = registry.create( { provider : 'openai', model : 'gpt-4o' } );

        expect( model1 ).toBe( model2 );

        const model3 = registry.create( { provider : 'openai', model : 'gpt-4o-mini' } );
        expect( model3 ).not.toBe( model1 );
    } );

    it( 'does not reuse cached adapters across different credentials (R9)', () => 
    {
        const registry = new ModelRegistry();

        const a = registry.create( { provider : 'openai', model : 'gpt-4o', apiKey : 'key-a' } );
        const b = registry.create( { provider : 'openai', model : 'gpt-4o', apiKey : 'key-b' } );

        expect( a ).not.toBe( b );
        expect( ( a as OpenAIProviderAdapter ).config.apiKey ).toBe( 'key-a' );
        expect( ( b as OpenAIProviderAdapter ).config.apiKey ).toBe( 'key-b' );
    } );

    it( 'DeepSeek factory reads DEEPSEEK_API_KEY (R12)', async () => 
    {
        const originalFetch = globalThis.fetch;
        const prev = process.env.DEEPSEEK_API_KEY;
        process.env.DEEPSEEK_API_KEY = 'ds-from-env';
        vi.stubGlobal( 'fetch', vi.fn().mockResolvedValue( jsonResponse( {
            choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ],
            usage   : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 }
        } ) ) );

        try
        {
            const registry = new ModelRegistry();
            const model = registry.resolve( 'deepseek', { model : 'deepseek-chat' } );

            await model.generate( { messages : [ { role : 'user', content : 'hi' } ] } );

            const headers = ( vi.mocked( fetch ).mock.calls[0][1] as RequestInit ).headers as Record<string, string>;
            expect( headers.Authorization ).toBe( 'Bearer ds-from-env' );
        }
        finally
        {
            if( prev === undefined )
            {
                delete process.env.DEEPSEEK_API_KEY;
            }
            else
            {
                process.env.DEEPSEEK_API_KEY = prev;
            }

            globalThis.fetch = originalFetch;
            vi.restoreAllMocks();
        }
    } );

    it( 'should allow registering custom provider factories', () => 
    {
        const registry = new ModelRegistry();

        registry.register( 'custom-llm', ( config ) => 
        {
            return new OpenAIProviderAdapter( { ...config, baseUrl : 'https://custom.api/v1' } );
        } );

        expect( registry.has( 'custom-llm' ) ).toBe( true );

        const custom = registry.resolve( 'custom-llm', { model : 'custom-1' } );
        expect( custom ).toBeInstanceOf( OpenAIProviderAdapter );
        expect( ( custom as OpenAIProviderAdapter ).config.baseUrl ).toBe( 'https://custom.api/v1' );
    } );

    it( 'should throw ProviderError when provider is not registered', () => 
    {
        const registry = new ModelRegistry();

        expect( () => 
        {
            registry.create( { provider : 'unsupported-provider', model : 'foo' } );
        } ).toThrow( ProviderError );
    } );

    it( 'createModel convenience function resolves via defaultRegistry', () => 
    {
        const model = createModel( { provider : 'openai', model : 'gpt-4o' } );
        expect( model ).toBeInstanceOf( OpenAIProviderAdapter );
    } );
} );
