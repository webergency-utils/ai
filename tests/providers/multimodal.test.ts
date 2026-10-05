import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { OllamaProviderAdapter } from '../../src/providers/ollama.js';
import { GroqProviderAdapter } from '../../src/providers/groq.js';
import { CapabilityError, InvalidInputError, type MessageAttachment } from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

const b64 = Buffer.from( [ 9, 8, 7 ] ).toString( 'base64' );
const video: MessageAttachment = { type : 'video', mimeType : 'video/mp4', data : b64 };

function lastBody(): Record<string, unknown>
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;

    return JSON.parse( ( call[ 1 ] as RequestInit ).body as string );
}

describe( 'provider multimodal mapping', () =>
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

    it( 'Ollama rejects video before fetch, naming type and provider (AE6)', async () =>
    {
        const adapter = new OllamaProviderAdapter( { provider : 'ollama', model : 'llava' } );
        const promise = adapter.generate( { messages : [ { role : 'user', content : 'x', attachments : [ video ] } ] } );

        await expect( promise ).rejects.toBeInstanceOf( CapabilityError );
        await expect( promise ).rejects.toThrow( /video/ );
        await expect( promise ).rejects.toThrow( /ollama/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'OpenAI rejects video and Groq rejects audio before fetch', async () =>
    {
        const openai = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );
        const groq = new GroqProviderAdapter( { provider : 'groq', model : 'm', apiKey : 'k' } );

        await expect( openai.generate( { messages : [ { role : 'user', content : '', attachments : [ video ] } ] } ) )
            .rejects.toThrow( /video/ );
        await expect( groq.generate( { messages : [ { role : 'user', content : '', attachments : [ { type : 'audio', mimeType : 'audio/wav', data : b64 } ] } ] } ) )
            .rejects.toThrow( /groq/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'OpenAI sends URL-only images as image_url without base64 and omits empty text', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ] } ) );

        const adapter = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );

        await adapter.generate( { messages : [ { role : 'user', content : '', attachments : [ { type : 'image', mimeType : 'image/png', url : 'https://x/y.png' } ] } ] } );

        const messages = lastBody().messages as Array<{ content: unknown }>;

        expect( messages[ 0 ].content ).toEqual( [ { type : 'image_url', image_url : { url : 'https://x/y.png' } } ] );
    } );

    it( 'Anthropic sends PDF document blocks with the right media_type', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { content : [ { type : 'text', text : 'ok' } ], stop_reason : 'end_turn' } ) );

        const adapter = new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );

        await adapter.generate( { messages : [ { role : 'user', content : 'sum', attachments : [ { type : 'document', mimeType : 'application/pdf', data : b64 } ] } ] } );

        const messages = lastBody().messages as Array<{ content: unknown }>;

        expect( messages[ 0 ].content ).toEqual( [
            { type : 'document', source : { type : 'base64', media_type : 'application/pdf', data : b64 } },
            { type : 'text', text : 'sum' }
        ] );
    } );

    it( 'Anthropic rejects video before fetch', async () =>
    {
        const adapter = new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );

        await expect( adapter.generate( { messages : [ { role : 'user', content : 'x', attachments : [ video ] } ] } ) )
            .rejects.toThrow( /video/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'Gemini maps video bytes to inlineData and URL-only to fileData', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { candidates : [ { content : { parts : [ { text : 'ok' } ] }, finishReason : 'STOP' } ] } ) );

        const adapter = new GeminiProviderAdapter( { provider : 'gemini', model : 'g', apiKey : 'k' } );

        await adapter.generate( { messages : [ { role : 'user', content : '', attachments : [ video, { type : 'document', mimeType : 'application/pdf', url : 'https://files/abc' } ] } ] } );

        const contents = lastBody().contents as Array<{ parts: unknown[] }>;

        expect( contents[ 0 ].parts ).toEqual( [
            { inlineData : { mimeType : 'video/mp4', data : b64 } },
            { fileData : { mimeType : 'application/pdf', fileUri : 'https://files/abc' } }
        ] );
    } );

    it( 'rejects attachments on assistant messages instead of dropping them', async () =>
    {
        const adapter = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );

        await expect( adapter.generate( { messages : [ { role : 'assistant', content : 'x', attachments : [ { type : 'image', mimeType : 'image/png', data : b64 } ] } ] } ) )
            .rejects.toBeInstanceOf( InvalidInputError );
        expect( fetch ).not.toHaveBeenCalled();
    } );
} );
