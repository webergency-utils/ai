import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { OllamaProviderAdapter } from '../../src/providers/ollama.js';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { InvalidInputError, ProviderError, assembleStream } from '../../src/core/index.js';
import type { ModelStreamChunk, ToolDefinition } from '../../src/core/index.js';
import { jsonResponse, sseResponse, streamResponse, chunkedStream } from '../helpers/http.js';

const tools: ToolDefinition[] = [
    { name : 'search', description : 's', parameters : { type : 'object', properties : { q : { type : 'string' } }, required : [ 'q' ] } },
    { name : 'lookup', description : 'l', parameters : { type : 'object', properties : { id : { type : 'number' } }, required : [ 'id' ] } }
];

async function collect( iterable: AsyncIterable<ModelStreamChunk> ): Promise<ModelStreamChunk[]>
{
    const out: ModelStreamChunk[] = [];

    for await ( const chunk of iterable )
    {
        out.push( chunk );
    }

    return out;
}

function sse( ...events: unknown[] ): string[]
{
    return events.map( ( e ) => {return typeof e === 'string' ? `data: ${e}\n\n` : `data: ${JSON.stringify( e )}\n\n`;} );
}

describe( 'tool-call parsing', () =>
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

    const openai = (): OpenAIProviderAdapter => {return new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );};

    it( 'OpenAI generate throws ProviderError on malformed tool JSON (AE4)', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            choices : [ { message : { content : null, tool_calls : [ { id : 'c', type : 'function', function : { name : 'search', arguments : '{not json' } } ] }, finish_reason : 'tool_calls' } ]
        } ) );

        const promise = openai().generate( { messages : [ { role : 'user', content : 'x' } ], retry : false } );

        await expect( promise ).rejects.toBeInstanceOf( ProviderError );
        await expect( promise ).rejects.toThrow( /\{not json/ );
    } );

    it( 'OpenAI stream assembles split fragments across byte boundaries, chunk and terminal agree', async () =>
    {
        const events = sse(
            { choices : [ { delta : { tool_calls : [ { index : 0, id : 'c1', function : { name : 'search', arguments : '{"q"' } }, { index : 1, id : 'c2', function : { name : 'lookup', arguments : '{"id"' } } ] } } ] },
            { choices : [ { delta : { tool_calls : [ { index : 0, function : { arguments : ':"cats"}' } }, { index : 1, function : { arguments : ':3}' } } ] } } ] },
            { choices : [ { delta : {}, finish_reason : 'tool_calls' } ] },
            '[DONE]'
        ).join( '' );

        vi.mocked( fetch ).mockResolvedValueOnce( streamResponse( chunkedStream( events, [ 40, 133, 210 ] ) ) );

        const chunks = await collect( openai().stream( { messages : [ { role : 'user', content : 'x' } ], tools } ) );
        const terminal = chunks[ chunks.length - 1 ];

        expect( terminal.toolCalls ).toEqual( [
            { id : 'c1', name : 'search', arguments : { q : 'cats' } },
            { id : 'c2', name : 'lookup', arguments : { id : 3 } }
        ] );

        const reassembled = await assembleStream( chunks.slice( 0, -1 ) );

        expect( reassembled.toolCalls ).toEqual( terminal.toolCalls );
    } );

    it( 'OpenAI stream fails on truncated tool JSON instead of yielding partial keys', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( sse(
            { choices : [ { delta : { tool_calls : [ { index : 0, id : 'c1', function : { name : 'search', arguments : '{"q"' } } ] } } ] },
            '[DONE]'
        ) ) );

        await expect( collect( openai().stream( { messages : [ { role : 'user', content : 'x' } ] } ) ) )
            .rejects.toBeInstanceOf( ProviderError );
    } );

    it( 'OpenAI stream throws InvalidInputError naming the tool on schema mismatch', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( sse(
            { choices : [ { delta : { tool_calls : [ { index : 0, id : 'c1', function : { name : 'lookup', arguments : '{"id":"nope"}' } } ] } } ] },
            '[DONE]'
        ) ) );

        const promise = collect( openai().stream( { messages : [ { role : 'user', content : 'x' } ], tools } ) );

        await expect( promise ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( promise ).rejects.toThrow( /lookup/ );
    } );

    it( 'Anthropic stream assembles multi-index input_json_delta and matches the terminal chunk', async () =>
    {
        const events = [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"search"}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu2","name":"lookup"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\": \\"ca"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\": 9}"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ts\\"}"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ];

        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( events ) );

        const adapter = new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );
        const chunks = await collect( adapter.stream( { messages : [ { role : 'user', content : 'x' } ], tools } ) );
        const terminal = chunks[ chunks.length - 1 ];

        expect( terminal.toolCalls ).toEqual( [
            { id : 'tu1', name : 'search', arguments : { q : 'cats' } },
            { id : 'tu2', name : 'lookup', arguments : { id : 9 } }
        ] );
        expect( ( await assembleStream( chunks.slice( 0, -1 ) ) ).toolCalls ).toEqual( terminal.toolCalls );
    } );

    it( 'Anthropic generate rejects a non-object tool input', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            content     : [ { type : 'tool_use', id : 'a', name : 'search', input : [ 1 ] } ],
            stop_reason : 'tool_use'
        } ) );

        const adapter = new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );

        await expect( adapter.generate( { messages : [ { role : 'user', content : 'x' } ], retry : false } ) )
            .rejects.toBeInstanceOf( ProviderError );
    } );

    it( 'Ollama generate fails on malformed string arguments and keeps object arguments', async () =>
    {
        const adapter = new OllamaProviderAdapter( { provider : 'ollama', model : 'm' } );

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            message : { role : 'assistant', content : '', tool_calls : [ { function : { name : 'search', arguments : '{bad' } } ] },
            done    : true
        } ) );

        await expect( adapter.generate( { messages : [ { role : 'user', content : 'x' } ], retry : false } ) )
            .rejects.toBeInstanceOf( ProviderError );

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            message : { role : 'assistant', content : '', tool_calls : [ { function : { name : 'search', arguments : { q : 'a' } } } ] },
            done    : true
        } ) );

        const res = await adapter.generate( { messages : [ { role : 'user', content : 'x' } ], retry : false } );

        expect( res.toolCalls?.[ 0 ].arguments ).toEqual( { q : 'a' } );
    } );

    it( 'Gemini stream validates assembled tool args against request tools', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( sse(
            { candidates : [ { content : { parts : [ { functionCall : { name : 'lookup', args : { id : 'x' } } } ] }, finishReason : 'STOP' } ] }
        ) ) );

        const adapter = new GeminiProviderAdapter( { provider : 'gemini', model : 'g', apiKey : 'k' } );

        await expect( collect( adapter.stream( { messages : [ { role : 'user', content : 'x' } ], tools } ) ) )
            .rejects.toBeInstanceOf( InvalidInputError );
    } );
} );
