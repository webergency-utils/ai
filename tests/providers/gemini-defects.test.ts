import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { jsonResponse, sseResponse } from '../helpers/http.js';

describe( 'GeminiProviderAdapter correctness defects', () => 
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

    it( 'maps multiple system messages into systemInstruction.parts (R10)', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( jsonResponse( {
            candidates : [ { content : { parts : [ { text : 'ok' } ] }, finishReason : 'STOP' } ]
        } ) );

        const adapter = new GeminiProviderAdapter( {
            provider     : 'gemini',
            model        : 'gemini-2.5-flash',
            apiKey       : 'mock-key',
            systemPrompt : 'Config system'
        } );

        await adapter.generate( {
            messages : [
                { role : 'system', content : 'Message system A' },
                { role : 'system', content : 'Message system B' },
                { role : 'user', content : 'hi' }
            ]
        } );

        const body = JSON.parse( String( ( vi.mocked( fetch ).mock.calls[0][1] as RequestInit ).body ) );

        expect( body.systemInstruction.parts ).toEqual( [
            { text : 'Config system' },
            { text : 'Message system A' },
            { text : 'Message system B' }
        ] );
        expect( body.contents ).toEqual( [
            { role : 'user', parts : [ { text : 'hi' } ] }
        ] );
    } );

    it( 'identifies tool results by tool name from prior tool calls (R13)', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( jsonResponse( {
            candidates : [ { content : { parts : [ { text : 'done' } ] }, finishReason : 'STOP' } ]
        } ) );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-key'
        } );

        await adapter.generate( {
            messages : [
                { role : 'user', content : 'lookup' },
                {
                    role      : 'assistant',
                    content   : '',
                    toolCalls : [ { id : 'call_1', name : 'get_weather', arguments : { city : 'Prague' } } ]
                },
                { role : 'tool', toolCallId : 'call_1', content : 'sunny' }
            ]
        } );

        const body = JSON.parse( String( ( vi.mocked( fetch ).mock.calls[0][1] as RequestInit ).body ) );
        const toolResult = body.contents.find( 
            ( c: { parts?: Array<{ functionResponse?: { name?: string } }> } ) => 
            {
                return c.parts?.[0]?.functionResponse;
            } 
        );

        expect( toolResult.parts[0].functionResponse.name ).toBe( 'get_weather' );
    } );

    it( 'yields every tool-call delta in a streaming chunk (R11)', async () => 
    {
        const event = 'data: {"candidates":[{"content":{"parts":['
            + '{"functionCall":{"name":"alpha","args":{"a":1}}},'
            + '{"functionCall":{"name":"beta","args":{"b":2}}}'
            + ']},"finishReason":"STOP"}]}\n\n';

        vi.mocked( fetch ).mockResolvedValue( sseResponse( [ event ] ) );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-key'
        } );

        const chunks = [];

        for await ( const chunk of adapter.stream( { messages : [ { role : 'user', content : 'hi' } ] } ) )
        {
            chunks.push( chunk );
        }

        const toolChunks = chunks.filter( ( c ) => {return c.deltaToolCall;} );

        expect( toolChunks ).toHaveLength( 2 );
        expect( toolChunks[0].deltaToolCall?.name ).toBe( 'alpha' );
        expect( toolChunks[1].deltaToolCall?.name ).toBe( 'beta' );
    } );
} );
