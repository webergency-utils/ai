import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { RateLimitError, ProviderError } from '../../src/core/error.js';
import type { ModelRequest } from '../../src/core/types.js';

describe( 'AnthropicProviderAdapter', () => 
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

    it( 'should generate completion with prompt caching metrics and raw payload', async () => 
    {
        const mockResponseData = 
            {
                id   : 'msg_12345',
                type : 'message',
                role : 'assistant',
                content : 
            [
                {
                    type : 'text',
                    text : 'Claude response text'
                }
            ],
                stop_reason : 'end_turn',
                usage : 
            {
                input_tokens                : 400,
                output_tokens               : 50,
                cache_read_input_tokens     : 1600,
                cache_creation_input_tokens : 100
            }
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } as unknown as Response );

        const adapter = new AnthropicProviderAdapter( {
            provider : 'anthropic',
            model    : 'claude-3-7-sonnet-20250219',
            apiKey   : 'sk-ant-mock-key'
        } );

        const req: ModelRequest = 
            {
                messages     : [ { role : 'user', content : 'Explain quantum physics' } ],
                systemPrompt : 'You are an expert physicist.'
            };

        const res = await adapter.generate( req );

        expect( res.content ).toBe( 'Claude response text' );
        expect( res.role ).toBe( 'assistant' );
        expect( res.finishReason ).toBe( 'stop' );
        expect( res.raw ).toEqual( mockResponseData );
        expect( res.usage ).toEqual( {
            promptTokens            : 400,
            completionTokens        : 50,
            totalTokens             : 450,
            cachedPromptReadTokens  : 1600,
            cachedPromptWriteTokens : 100,
            raw                     : mockResponseData.usage
        } );

        expect( vi.mocked( fetch ) ).toHaveBeenCalledWith(
            'https://api.anthropic.com/v1/messages',
            expect.objectContaining( {
                method  : 'POST',
                headers : expect.objectContaining( {
                    'x-api-key'         : 'sk-ant-mock-key',
                    'anthropic-version' : '2023-06-01'
                } )
            } )
        );
    } );

    it( 'should parse tool use blocks from Claude response', async () => 
    {
        const mockResponseData = 
            {
                content : 
            [
                {
                    type : 'text',
                    text : 'Checking database...'
                },
                {
                    type  : 'tool_use',
                    id    : 'toolu_123',
                    name  : 'sql_query',
                    input : { query : 'SELECT * FROM users' }
                }
            ],
                stop_reason : 'tool_use'
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockResponseData;}
        } as unknown as Response );

        const adapter = new AnthropicProviderAdapter( {
            provider : 'anthropic',
            model    : 'claude-3-7-sonnet-20250219',
            apiKey   : 'sk-ant-mock-key'
        } );

        const res = await adapter.generate( {
            messages : [ { role : 'user', content : 'Find all users' } ]
        } );

        expect( res.content ).toBe( 'Checking database...' );
        expect( res.finishReason ).toBe( 'tool_calls' );
        expect( res.toolCalls ).toHaveLength( 1 );
        expect( res.toolCalls![0] ).toEqual( {
            id        : 'toolu_123',
            name      : 'sql_query',
            arguments : { query : 'SELECT * FROM users' }
        } );
    } );

    it( 'should handle rate limit 429 and throw RateLimitError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 429,
            statusText : 'Too Many Requests',
            headers    : new Headers( { 'retry-after' : '5' } ),
            text       : async () => {return JSON.stringify( { error : { message : 'Rate limit exceeded' } } );}
        } as unknown as Response );

        const adapter = new AnthropicProviderAdapter( {
            provider : 'anthropic',
            model    : 'claude-3-7-sonnet-20250219',
            apiKey   : 'sk-ant-mock-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ]
        } ) ).rejects.toThrow( RateLimitError );
    } );

    it( 'should handle 400 error and throw ProviderError', async () => 
    {
        vi.mocked( fetch ).mockResolvedValue( {
            ok         : false,
            status     : 400,
            statusText : 'Bad Request',
            headers    : new Headers(),
            text       : async () => {return JSON.stringify( { error : { message : 'Invalid schema' } } );}
        } as unknown as Response );

        const adapter = new AnthropicProviderAdapter( {
            provider : 'anthropic',
            model    : 'claude-3-7-sonnet-20250219',
            apiKey   : 'sk-ant-mock-key'
        } );

        await expect( adapter.generate( {
            messages : [ { role : 'user', content : 'test' } ]
        } ) ).rejects.toThrow( ProviderError );
    } );

    it( 'should stream Claude SSE events with thinking/delta and tool calls', async () => 
    {
        const evMessageStart = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n';
        const evBlockStart = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
        const evDeltaText = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world!"}}\n\n';
        const evToolStart = 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"calc"}}\n\n';
        const evToolDelta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n';
        const evMessageDelta = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n';
        const evMessageStop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( 
                    evMessageStart + 
                    evBlockStart + 
                    evDeltaText + 
                    evToolStart + 
                    evToolDelta + 
                    evMessageDelta + 
                    evMessageStop 
                ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } as unknown as Response );

        const adapter = new AnthropicProviderAdapter( {
            provider : 'anthropic',
            model    : 'claude-3-7-sonnet-20250219',
            apiKey   : 'sk-ant-mock-key'
        } );

        const chunks = [];

        for await ( const chunk of adapter.stream( { messages : [ { role : 'user', content : 'Calc 1+1' } ] } ) )
        {
            chunks.push( chunk );
        }

        expect( chunks.length ).toBeGreaterThanOrEqual( 3 );
        const textChunk = chunks.find( ( c ) => {return c.deltaContent === 'Hello world!';} );
        expect( textChunk ).toBeDefined();

        const toolDeltaChunk = chunks.find( ( c ) => {return c.deltaToolCall?.arguments === '{"a":1}';} );
        expect( toolDeltaChunk ).toBeDefined();
        expect( toolDeltaChunk?.deltaToolCall?.name ).toBe( 'calc' );

        const finalChunk = chunks.find( ( c ) => {return c.finishReason === 'tool_calls';} );
        expect( finalChunk ).toBeDefined();
        expect( finalChunk?.usage?.promptTokens ).toBe( 100 );
        expect( finalChunk?.usage?.completionTokens ).toBe( 30 );
        expect( finalChunk?.usage?.totalTokens ).toBe( 130 );
    } );
} );
