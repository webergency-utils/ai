import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { RateLimitError, ProviderError } from '../../src/core/error.js';
import type { ModelRequest } from '../../src/core/types.js';

describe( 'OpenAIProviderAdapter', () => 
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

    it( 'should generate a standard completion with usage and raw payload', async () => 
    {
        const mockResponseData = 
            {
                id : 'chatcmpl-test-123',
                choices : 
            [
                {
                    message : 
                    {
                        role    : 'assistant',
                        content : 'Hello there!'
                    },
                    finish_reason : 'stop'
                }
            ],
                usage : 
            {
                prompt_tokens             : 15,
                completion_tokens         : 8,
                total_tokens              : 23,
                completion_tokens_details : { reasoning_tokens : 4 },
                prompt_tokens_details     : { cached_tokens : 5 }
            }
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        const req: ModelRequest = 
            {
                messages : 
            [
                { role : 'user', content : 'Hi!' }
            ]
            };

        const res = await adapter.generate( req );

        expect( res.content ).toBe( 'Hello there!' );
        expect( res.role ).toBe( 'assistant' );
        expect( res.finishReason ).toBe( 'stop' );
        expect( res.raw ).toEqual( mockResponseData );
        expect( res.usage ).toEqual( {
            promptTokens           : 15,
            completionTokens       : 8,
            totalTokens            : 23,
            reasoningTokens        : 4,
            cachedPromptReadTokens : 5,
            raw                    : mockResponseData.usage
        } );

        expect( globalThis.fetch ).toHaveBeenCalledWith(
            'https://api.openai.com/v1/chat/completions',
            expect.objectContaining( {
                method  : 'POST',
                headers : expect.objectContaining( {
                    Authorization : 'Bearer sk-mock-key'
                } )
            } )
        );
    } );

    it( 'should parse tool calls correctly from model response', async () => 
    {
        const mockResponseData = 
            {
                choices : 
            [
                {
                    message : 
                    {
                        role    : 'assistant',
                        content : null,
                        tool_calls : 
                        [
                            {
                                id   : 'call_abc123',
                                type : 'function',
                                function : 
                                {
                                    name      : 'get_weather',
                                    arguments : '{"city":"Prague"}'
                                }
                            }
                        ]
                    },
                    finish_reason : 'tool_calls'
                }
            ]
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        const res = await adapter.generate( {
            messages : [ { role : 'user', content : 'Weather in Prague?' } ]
        } );

        expect( res.finishReason ).toBe( 'tool_calls' );
        expect( res.toolCalls ).toHaveLength( 1 );
        expect( res.toolCalls![0] ).toEqual( {
            id        : 'call_abc123',
            name      : 'get_weather',
            arguments : { city : 'Prague' }
        } );
    } );

    it( 'should handle rate limit 429 error and throw RateLimitError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 429,
            statusText : 'Too Many Requests',
            headers    : new Headers( { 'retry-after' : '10' } ),
            text       : async () => {return JSON.stringify( { error : { message : 'Quota exceeded' } } );}
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ],
            retry    : false
        } ) ).rejects.toThrow( RateLimitError );
    } );

    it( 'should handle provider 500 error and throw ProviderError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 500,
            statusText : 'Internal Server Error',
            headers    : new Headers(),
            text       : async () => {return JSON.stringify( { error : { message : 'Internal server failure' } } );}
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ],
            retry    : false
        } ) ).rejects.toThrow( ProviderError );
    } );

    it( 'should stream SSE chunks with content deltas and tool deltas', async () => 
    {
        const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';
        const chunk2 = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\""}},{"index":1,"id":"call_2","function":{"name":"lookup","arguments":"{\\"id\\""}}]},"finish_reason":null}]}\n\n';
        const chunk2b = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"cats\\"}"}},{"index":1,"function":{"arguments":":7}"}}]},"finish_reason":null}]}\n\n';
        const chunk3 = 'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';
        const chunkDone = 'data: [DONE]\n\n';

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( chunk1 + chunk2 + chunk2b + chunk3 + chunkDone ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        const chunks = [];

        for await ( const chunk of adapter.stream( { messages : [ { role : 'user', content : 'Hi' } ] } ) )
        {
            chunks.push( chunk );
        }

        expect( chunks ).toHaveLength( 7 );
        expect( chunks[0].deltaContent ).toBe( 'Hello' );
        expect( chunks[1].deltaToolCall ).toEqual( {
            index     : 0,
            id        : 'call_1',
            name      : 'search',
            arguments : '{"q"'
        } );
        expect( chunks[2].deltaToolCall ).toEqual( {
            index     : 1,
            id        : 'call_2',
            name      : 'lookup',
            arguments : '{"id"'
        } );
        expect( chunks[5].finishReason ).toBe( 'stop' );
        expect( chunks[5].usage?.totalTokens ).toBe( 15 );
        expect( chunks[6].toolCalls ).toEqual( [
            { id : 'call_1', name : 'search', arguments : { q : 'cats' } },
            { id : 'call_2', name : 'lookup', arguments : { id : 7 } }
        ] );
    } );

    it( 'throws when the stream ends without [DONE] (AE14)', async () => 
    {
        const chunk1 = 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( chunk1 ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } );

        const adapter = new OpenAIProviderAdapter( {
            provider : 'openai',
            model    : 'gpt-4o',
            apiKey   : 'sk-mock-key'
        } );

        await expect( ( async () => 
        {
            for await ( const _chunk of adapter.stream( { messages : [ { role : 'user', content : 'Hi' } ] } ) )
            {
                // consume
            }
        } )() ).rejects.toThrow( /without \[DONE\]/ );
    } );
} );
