import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { RateLimitError, ProviderError } from '../../src/core/error.js';
import type { ModelRequest } from '../../src/core/types.js';

describe( 'GeminiProviderAdapter', () => 
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

    it( 'should generate completion with usageMetadata and raw payload', async () => 
    {
        const mockResponseData = 
            {
                candidates : 
            [
                {
                    content : 
                    {
                        role  : 'model',
                        parts : [ { text : 'Gemini 2.5 Flash response' } ]
                    },
                    finishReason : 'STOP'
                }
            ],
                usageMetadata : 
            {
                promptTokenCount        : 25,
                candidatesTokenCount    : 10,
                totalTokenCount         : 35,
                cachedContentTokenCount : 5
            }
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        const req: ModelRequest = 
            {
                messages     : [ { role : 'user', content : 'Hello Gemini' } ],
                systemPrompt : 'You are a helpful assistant'
            };

        const res = await adapter.generate( req );

        expect( res.content ).toBe( 'Gemini 2.5 Flash response' );
        expect( res.role ).toBe( 'assistant' );
        expect( res.finishReason ).toBe( 'stop' );
        expect( res.raw ).toEqual( mockResponseData );
        expect( res.usage ).toEqual( {
            promptTokens           : 25,
            completionTokens       : 10,
            totalTokens            : 35,
            cachedPromptReadTokens : 5,
            raw                    : mockResponseData.usageMetadata
        } );

        expect( vi.mocked( fetch ) ).toHaveBeenCalledWith(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
            expect.objectContaining( {
                method  : 'POST',
                headers : expect.objectContaining( {
                    'x-goog-api-key' : 'mock-gemini-key'
                } )
            } )
        );
    } );

    it( 'should map multimodal image attachment to inlineData in payload', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return { candidates : [ { content : { parts : [ { text : 'I see an image' } ] } } ] };}
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        await adapter.generate( {
            messages : 
            [
                {
                    role    : 'user',
                    content : 'What is this?',
                    attachments : 
                    [
                        {
                            type     : 'image',
                            mimeType : 'image/png',
                            data     : 'base64ImageBytes'
                        }
                    ]
                }
            ]
        } );

        const callArgs = vi.mocked( fetch ).mock.calls[0];
        const sentBody = JSON.parse( callArgs[1]?.body as string );

        expect( sentBody.contents[0].parts ).toEqual( [
            { text : 'What is this?' },
            {
                inlineData : 
                {
                    mimeType : 'image/png',
                    data     : 'base64ImageBytes'
                }
            }
        ] );
    } );

    it( 'should parse functionCall into toolCalls', async () => 
    {
        const mockResponseData = 
            {
                candidates : 
            [
                {
                    content : 
                    {
                        role : 'model',
                        parts : 
                        [
                            {
                                functionCall : 
                                {
                                    name : 'lookup_user',
                                    args : { userId : 'usr_456' }
                                }
                            }
                        ]
                    },
                    finishReason : 'STOP'
                }
            ]
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        const res = await adapter.generate( {
            messages : [ { role : 'user', content : 'Find user 456' } ]
        } );

        expect( res.finishReason ).toBe( 'tool_calls' );
        expect( res.toolCalls ).toHaveLength( 1 );
        expect( res.toolCalls![0].name ).toBe( 'lookup_user' );
        expect( res.toolCalls![0].arguments ).toEqual( { userId : 'usr_456' } );
    } );

    it( 'should handle rate limit 429 and throw RateLimitError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 429,
            statusText : 'Resource Exhausted',
            headers    : new Headers( { 'retry-after' : '60' } ),
            text       : async () => {return JSON.stringify( { error : { message : 'Resource has been exhausted' } } );}
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ]
        } ) ).rejects.toThrow( RateLimitError );
    } );

    it( 'should handle 500 error and throw ProviderError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 500,
            statusText : 'Internal Server Error',
            headers    : new Headers(),
            text       : async () => {return JSON.stringify( { error : { message : 'Backend failure' } } );}
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ]
        } ) ).rejects.toThrow( ProviderError );
    } );

    it( 'should stream SSE chunks from Gemini streamGenerateContent', async () => 
    {
        const chunk1 = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n';
        const chunk2 = 'data: {"candidates":[{"content":{"parts":[{"text":" World"}]}}],"usageMetadata":{"totalTokenCount":12}}\n\n';

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( chunk1 + chunk2 ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } as unknown as Response );

        const adapter = new GeminiProviderAdapter( {
            provider : 'gemini',
            model    : 'gemini-2.5-flash',
            apiKey   : 'mock-gemini-key'
        } );

        const chunks = [];

        for await ( const chunk of adapter.stream( { messages : [ { role : 'user', content : 'Hi' } ] } ) )
        {
            chunks.push( chunk );
        }

        expect( chunks ).toHaveLength( 2 );
        expect( chunks[0].deltaContent ).toBe( 'Hello' );
        expect( chunks[1].deltaContent ).toBe( ' World' );
        expect( chunks[1].usage?.totalTokens ).toBe( 12 );
    } );
} );
