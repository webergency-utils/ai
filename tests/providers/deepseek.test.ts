import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepSeekProviderAdapter } from '../../src/providers/deepseek.js';
import { InvalidInputError, type ChatMessage, type ModelStreamChunk } from '../../src/core/index.js';
import { jsonResponse, sseResponse } from '../helpers/http.js';

function lastBody(): Record<string, any>
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;

    return JSON.parse( ( call[ 1 ] as RequestInit ).body as string );
}

const history = ( reasoningContent?: string ): ChatMessage[] =>
{
    return [
        { role : 'user', content : 'weather in Paris?' },
        { role : 'assistant', content : '', toolCalls : [ { id : 'call_1', name : 'weather', arguments : { city : 'Paris' } } ], ...( reasoningContent !== undefined ? { reasoningContent } : {} ) },
        { role : 'tool', content : '18C', toolCallId : 'call_1' },
        { role : 'user', content : 'and tomorrow?' }
    ];
};

describe( 'DeepSeek reasoning round-trip', () =>
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

    const reasoner = (): DeepSeekProviderAdapter => {return new DeepSeekProviderAdapter( { provider : 'deepseek', model : 'deepseek-reasoner', apiKey : 'k' } );};

    it( 'echoes reasoning_content on the assistant tool-call turn (AE5)', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'sunny' }, finish_reason : 'stop' } ] } ) );

        await reasoner().generate( { messages : history( 'step plan' ) } );

        expect( lastBody().messages ).toEqual( [
            { role : 'user', content : 'weather in Paris?' },
            {
                role              : 'assistant',
                content           : null,
                reasoning_content : 'step plan',
                tool_calls        : [ { id : 'call_1', type : 'function', function : { name : 'weather', arguments : '{"city":"Paris"}' } } ]
            },
            { role : 'tool', tool_call_id : 'call_1', content : '18C' },
            { role : 'user', content : 'and tomorrow?' }
        ] );
    } );

    it( 'fails before HTTP when a reasoning model history lacks the required echo', async () =>
    {
        const promise = reasoner().generate( { messages : history() } );

        await expect( promise ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( promise ).rejects.toThrow( /reasoningContent/ );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'does not require the echo on non-reasoning models', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { choices : [ { message : { content : 'ok' }, finish_reason : 'stop' } ] } ) );

        const chat = new DeepSeekProviderAdapter( { provider : 'deepseek', model : 'deepseek-chat', apiKey : 'k' } );

        await chat.generate( { messages : history() } );

        expect( lastBody().messages[ 1 ].reasoning_content ).toBeUndefined();
    } );

    it( 'parses reasoning_content from responses', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            choices : [ { message : { content : 'answer', reasoning_content : 'because' }, finish_reason : 'stop' } ]
        } ) );

        const res = await reasoner().generate( { messages : [ { role : 'user', content : 'hi' } ] } );

        expect( res.content ).toBe( 'answer' );
        expect( res.reasoningContent ).toBe( 'because' );
    } );

    it( 'streams reasoning separately from content', async () =>
    {
        const events = [ 
            { choices : [ { delta : { reasoning_content : 'th' } } ] },
            { choices : [ { delta : { reasoning_content : 'ink' } } ] },
            { choices : [ { delta : { content : 'done' } } ] },
            { choices : [ { delta : {}, finish_reason : 'stop' } ] }
        ].map( ( e ) => {return `data: ${JSON.stringify( e )}\n\n`;} );

        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( [ ...events, 'data: [DONE]\n\n' ] ) );

        const chunks: ModelStreamChunk[] = [];

        for await ( const chunk of reasoner().stream( { messages : [ { role : 'user', content : 'hi' } ] } ) )
        {
            chunks.push( chunk );
        }

        expect( chunks.map( ( c ) => {return c.deltaReasoningContent ?? '';} ).join( '' ) ).toBe( 'think' );
        expect( chunks.map( ( c ) => {return c.deltaContent;} ).join( '' ) ).toBe( 'done' );
    } );
} );
