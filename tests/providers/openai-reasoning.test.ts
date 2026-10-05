import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { assembleStream, type ModelStreamChunk } from '../../src/core/index.js';
import { jsonResponse, sseResponse } from '../helpers/http.js';

function lastBody(): Record<string, any>
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;

    return JSON.parse( ( call[ 1 ] as RequestInit ).body as string );
}

describe( 'OpenAI-compatible reasoning fields', () =>
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

    const adapter = (): OpenAIProviderAdapter => {return new OpenAIProviderAdapter( { provider : 'openai', model : 'o-compat', apiKey : 'k' } );};

    it( 'reads `reasoning` as a fallback field and omits it when absent', async () =>
    {
        vi.mocked( fetch )
            .mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'a', reasoning : 'why' }, finish_reason : 'stop' } ] } ) )
            .mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'a' }, finish_reason : 'stop' } ] } ) );

        expect( ( await adapter().generate( { messages : [ { role : 'user', content : 'x' } ] } ) ).reasoningContent ).toBe( 'why' );
        expect( ( await adapter().generate( { messages : [ { role : 'user', content : 'x' } ] } ) ).reasoningContent ).toBeUndefined();
    } );

    it( 'does not send reasoning_content to providers that do not require the echo', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'a' }, finish_reason : 'stop' } ] } ) );

        await adapter().generate( { messages : [
            { role : 'user', content : 'x' },
            { role : 'assistant', content : 'y', reasoningContent : 'hidden' },
            { role : 'user', content : 'z' }
        ] } );

        expect( lastBody().messages[ 1 ] ).toEqual( { role : 'assistant', content : 'y' } );
    } );

    it( 'accumulates streamed reasoning in the assembler, separate from text', async () =>
    {
        const events = [
            { choices : [ { delta : { reasoning_content : 'a' } } ] },
            { choices : [ { delta : { reasoning_content : 'b', content : 'X' } } ] },
            { choices : [ { delta : { content : 'Y' }, finish_reason : 'stop' } ] }
        ].map( ( e ) => {return `data: ${JSON.stringify( e )}\n\n`;} );

        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( [ ...events, 'data: [DONE]\n\n' ] ) );

        const chunks: ModelStreamChunk[] = [];

        for await ( const chunk of adapter().stream( { messages : [ { role : 'user', content : 'x' } ] } ) )
        {
            chunks.push( chunk );
        }

        const result = await assembleStream( chunks );

        expect( result.reasoning ).toBe( 'ab' );
        expect( result.text ).toBe( 'XY' );
    } );
} );
