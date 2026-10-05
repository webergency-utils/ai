import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProviderAdapter } from '../../src/providers/openai.js';
import { AnthropicProviderAdapter } from '../../src/providers/anthropic.js';
import { GeminiProviderAdapter } from '../../src/providers/gemini.js';
import { OllamaProviderAdapter } from '../../src/providers/ollama.js';
import { DeepSeekProviderAdapter } from '../../src/providers/deepseek.js';
import { GroqProviderAdapter } from '../../src/providers/groq.js';
import { MistralProviderAdapter } from '../../src/providers/mistral.js';
import {
    CapabilityError,
    InvalidInputError,
    ProviderError,
    generateStructured,
    isStrictCompatible,
    toGeminiSchema,
    type ModelStreamChunk,
    type WarningEvent
} from '../../src/core/index.js';
import { jsonResponse, sseResponse } from '../helpers/http.js';

const labelSchema = { type : 'object', properties : { label : { type : 'string' } }, required : [ 'label' ] };
const strictSchema = { ...labelSchema, additionalProperties : false };
const userMsg = [ { role : 'user' as const, content : 'classify' } ];

function lastBody(): Record<string, any>
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;

    return JSON.parse( ( call[ 1 ] as RequestInit ).body as string );
}

const openaiReply = ( content: string, finish = 'stop' ): Response =>
{
    return jsonResponse( { choices : [ { message : { content }, finish_reason : finish } ], usage : { prompt_tokens : 1, completion_tokens : 1, total_tokens : 2 } } );
};

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

describe( 'structured output', () =>
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

    describe( 'capability gate', () =>
    {
        it( 'Ollama configured without schema support fails before HTTP naming structuredOutput (AE1)', async () =>
        {
            const ollama = new OllamaProviderAdapter( { provider : 'ollama', model : 'old', capabilities : { structuredOutput : false } } );
            const promise = ollama.generate( { messages : userMsg, outputSchema : labelSchema } );

            await expect( promise ).rejects.toBeInstanceOf( CapabilityError );
            await expect( promise ).rejects.toThrow( /structuredOutput/ );
            await expect( promise ).rejects.toThrow( /ollama/ );
            expect( fetch ).not.toHaveBeenCalled();
        } );

        it( 'stream fails the same way', async () =>
        {
            const ollama = new OllamaProviderAdapter( { provider : 'ollama', model : 'old', capabilities : { structuredOutput : false } } );

            await expect( collect( ollama.stream( { messages : userMsg, outputSchema : labelSchema } ) ) )
                .rejects.toThrow( /structuredOutput/ );
            expect( fetch ).not.toHaveBeenCalled();
        } );

        it( 'rejects outputMode without outputSchema', async () =>
        {
            await expect( openai().generate( { messages : userMsg, outputMode : 'json' } ) )
                .rejects.toBeInstanceOf( InvalidInputError );
        } );
    } );

    describe( 'OpenAI family', () =>
    {
        it( 'maps a strict-compatible schema to strict json_schema and returns validated structured (AE2)', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( openaiReply( '{"label":"spam"}' ) );

            const res = await generateStructured<{ label: string }>( openai(), { messages : userMsg, outputSchema : strictSchema } );

            expect( res.structured.label ).toBe( 'spam' );
            expect( lastBody().response_format ).toEqual( {
                type        : 'json_schema',
                json_schema : { name : 'response', strict : true, schema : strictSchema }
            } );
        } );

        it( 'sends strict:false when the schema is not strict-compatible', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( openaiReply( '{"label":"x"}' ) );

            await openai().generate( { messages : userMsg, outputSchema : labelSchema } );

            expect( lastBody().response_format.json_schema.strict ).toBe( false );
        } );

        it( 'throws InvalidInputError with the failing path on schema mismatch', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( openaiReply( '{"label":5}' ) );

            const promise = openai().generate( { messages : userMsg, outputSchema : labelSchema } );

            await expect( promise ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( promise ).rejects.toThrow( /label/ );
        } );

        it( 'throws ProviderError for non-JSON text, empty content, and truncated output', async () =>
        {
            vi.mocked( fetch )
                .mockResolvedValueOnce( openaiReply( 'sure! {"label":' ) )
                .mockResolvedValueOnce( openaiReply( '' ) )
                .mockResolvedValueOnce( openaiReply( '{"label":"a', 'length' ) );

            for( let i = 0; i < 3; i++ )
            {
                await expect( openai().generate( { messages : userMsg, outputSchema : labelSchema, retry : false } ) )
                    .rejects.toBeInstanceOf( ProviderError );
            }
        } );

        it( 'does not parse structured output when the model answers with tool calls', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                choices : [ { message : { content : null, tool_calls : [ { id : 'c', type : 'function', function : { name : 'f', arguments : '{}' } } ] }, finish_reason : 'tool_calls' } ]
            } ) );

            const res = await openai().generate( { messages : userMsg, outputSchema : labelSchema } );

            expect( res.structured ).toBeUndefined();
            expect( res.toolCalls ).toHaveLength( 1 );
        } );

        it( 'json mode uses json_object plus a schema instruction', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( openaiReply( '{"label":"a"}' ) );

            const res = await openai().generate( { messages : userMsg, outputSchema : labelSchema, outputMode : 'json' } );
            const body = lastBody();

            expect( res.structured ).toEqual( { label : 'a' } );
            expect( body.response_format ).toEqual( { type : 'json_object' } );
            expect( body.messages[ 0 ].role ).toBe( 'system' );
            expect( body.messages[ 0 ].content ).toContain( '"label"' );
        } );

        it( 'DeepSeek downgrades to json_object and emits a warning', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( openaiReply( '{"label":"a"}' ) );

            const deepseek = new DeepSeekProviderAdapter( { provider : 'deepseek', model : 'deepseek-chat', apiKey : 'k' } );
            const warnings: WarningEvent[] = [];

            deepseek.onWarning( ( w ) => {warnings.push( w );} );

            const res = await deepseek.generate( { messages : userMsg, outputSchema : labelSchema } );

            expect( res.structured ).toEqual( { label : 'a' } );
            expect( lastBody().response_format ).toEqual( { type : 'json_object' } );
            expect( warnings.map( ( w ) => {return w.code;} ) ).toEqual( [ 'STRUCTURED_OUTPUT_DOWNGRADE' ] );
        } );

        it( 'Groq and Mistral use json_schema', async () =>
        {
            vi.mocked( fetch )
                .mockResolvedValueOnce( openaiReply( '{"label":"a"}' ) )
                .mockResolvedValueOnce( openaiReply( '{"label":"a"}' ) );

            await new GroqProviderAdapter( { provider : 'groq', model : 'm', apiKey : 'k' } ).generate( { messages : userMsg, outputSchema : strictSchema } );
            expect( lastBody().response_format.type ).toBe( 'json_schema' );

            await new MistralProviderAdapter( { provider : 'mistral', model : 'm', apiKey : 'k' } ).generate( { messages : userMsg, outputSchema : strictSchema } );
            expect( lastBody().response_format.type ).toBe( 'json_schema' );
        } );

        it( 'stream validates once at the end and yields structured on the terminal chunk', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( sse(
                { choices : [ { delta : { content : '{"lab' } } ] },
                { choices : [ { delta : { content : 'el":"ham"}' } } ] },
                { choices : [ { delta : {}, finish_reason : 'stop' } ] },
                '[DONE]'
            ) ) );

            const chunks = await collect( openai().stream( { messages : userMsg, outputSchema : labelSchema } ) );

            expect( chunks[ chunks.length - 1 ].structured ).toEqual( { label : 'ham' } );
            expect( chunks.slice( 0, -1 ).every( ( c ) => {return !( 'structured' in c );} ) ).toBe( true );
        } );

        it( 'stream raises on malformed JSON, schema mismatch, and missing terminator', async () =>
        {
            vi.mocked( fetch )
                .mockResolvedValueOnce( sseResponse( sse( { choices : [ { delta : { content : '{"label"' }, finish_reason : 'stop' } ] }, '[DONE]' ) ) )
                .mockResolvedValueOnce( sseResponse( sse( { choices : [ { delta : { content : '{"label":1}' }, finish_reason : 'stop' } ] }, '[DONE]' ) ) )
                .mockResolvedValueOnce( sseResponse( sse( { choices : [ { delta : { content : '{"label":"a"}' }, finish_reason : 'stop' } ] } ) ) );

            const run = (): Promise<ModelStreamChunk[]> => {return collect( openai().stream( { messages : userMsg, outputSchema : labelSchema } ) );};

            await expect( run() ).rejects.toBeInstanceOf( ProviderError );
            await expect( run() ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( run() ).rejects.toThrow( /terminator/ );
        } );
    } );

    describe( 'Anthropic', () =>
    {
        const anthropic = (): AnthropicProviderAdapter => {return new AnthropicProviderAdapter( { provider : 'anthropic', model : 'c', apiKey : 'k' } );};

        it( 'forces a synthetic tool and surfaces its input as structured, hiding the tool call', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                content     : [ { type : 'tool_use', id : 't', name : 'structured_output', input : { label : 'ok' } } ],
                stop_reason : 'tool_use'
            } ) );

            const res = await anthropic().generate( { messages : userMsg, outputSchema : labelSchema } );
            const body = lastBody();

            expect( res.structured ).toEqual( { label : 'ok' } );
            expect( res.toolCalls ).toBeUndefined();
            expect( res.finishReason ).toBe( 'stop' );
            expect( body.tool_choice ).toEqual( { type : 'tool', name : 'structured_output' } );
            expect( body.tools[ 0 ].input_schema ).toEqual( labelSchema );
        } );

        it( 'rejects combining outputSchema with tools before HTTP', async () =>
        {
            await expect( anthropic().generate( {
                messages     : userMsg,
                outputSchema : labelSchema,
                tools        : [ { name : 'f', description : 'f', parameters : { type : 'object', properties : {} } } ]
            } ) ).rejects.toBeInstanceOf( InvalidInputError );
            expect( fetch ).not.toHaveBeenCalled();
        } );

        it( 'validates the tool input against the schema', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                content     : [ { type : 'tool_use', id : 't', name : 'structured_output', input : { label : 3 } } ],
                stop_reason : 'tool_use'
            } ) );

            await expect( anthropic().generate( { messages : userMsg, outputSchema : labelSchema, retry : false } ) )
                .rejects.toBeInstanceOf( InvalidInputError );
        } );

        it( 'stream turns the synthetic tool deltas into text and yields structured at the end', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( sseResponse( [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
                'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"structured_output"}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"label\\":"}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"yes\\"}"}}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            ] ) );

            const chunks = await collect( anthropic().stream( { messages : userMsg, outputSchema : labelSchema } ) );
            const last = chunks[ chunks.length - 1 ];

            expect( last.structured ).toEqual( { label : 'yes' } );
            expect( last.toolCalls ).toBeUndefined();
            expect( chunks.some( ( c ) => {return c.deltaToolCall;} ) ).toBe( false );
        } );
    } );

    describe( 'Gemini', () =>
    {
        it( 'sets responseMimeType and a sanitized responseSchema', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                candidates : [ { content : { parts : [ { text : '{"label":"g"}' } ] }, finishReason : 'STOP' } ]
            } ) );

            const adapter = new GeminiProviderAdapter( { provider : 'gemini', model : 'g', apiKey : 'k' } );
            const res = await adapter.generate( { messages : userMsg, outputSchema : { ...labelSchema, additionalProperties : false, $schema : 'x' } } );
            const config = lastBody().generationConfig;

            expect( res.structured ).toEqual( { label : 'g' } );
            expect( config.responseMimeType ).toBe( 'application/json' );
            expect( config.responseSchema ).toEqual( labelSchema );
        } );

        it( 'json mode sets only the mime type', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                candidates : [ { content : { parts : [ { text : '{"label":"g"}' } ] }, finishReason : 'STOP' } ]
            } ) );

            const adapter = new GeminiProviderAdapter( { provider : 'gemini', model : 'g', apiKey : 'k' } );

            await adapter.generate( { messages : userMsg, outputSchema : labelSchema, outputMode : 'json' } );

            expect( lastBody().generationConfig ).toEqual( { responseMimeType : 'application/json' } );
        } );
    } );

    describe( 'Ollama', () =>
    {
        it( 'passes the schema as format and validates the reply', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { message : { role : 'assistant', content : '{"label":"o"}' }, done : true, done_reason : 'stop' } ) );

            const ollama = new OllamaProviderAdapter( { provider : 'ollama', model : 'm' } );
            const res = await ollama.generate( { messages : userMsg, outputSchema : labelSchema } );

            expect( res.structured ).toEqual( { label : 'o' } );
            expect( lastBody().format ).toEqual( labelSchema );
        } );

        it( 'json mode sends format "json"', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { message : { role : 'assistant', content : '{"label":"o"}' }, done : true } ) );

            await new OllamaProviderAdapter( { provider : 'ollama', model : 'm' } ).generate( { messages : userMsg, outputSchema : labelSchema, outputMode : 'json' } );

            expect( lastBody().format ).toBe( 'json' );
        } );
    } );

    describe( 'schema helpers', () =>
    {
        it( 'isStrictCompatible requires closed objects with all keys required, recursively', () =>
        {
            expect( isStrictCompatible( strictSchema ) ).toBe( true );
            expect( isStrictCompatible( labelSchema ) ).toBe( false );
            expect( isStrictCompatible( { type : 'object', properties : { a : { type : 'object', properties : { b : { type : 'string' } }, required : [ 'b' ] } }, required : [ 'a' ], additionalProperties : false } ) ).toBe( false );
            expect( isStrictCompatible( { type : 'string' } ) ).toBe( true );
        } );

        it( 'toGeminiSchema drops unsupported keys, folds null unions, and rewrites const', () =>
        {
            expect( toGeminiSchema( {
                $schema    : 'x',
                type       : 'object',
                properties : {
                    a : { type : [ 'string', 'null' ], default : 'x' },
                    b : { const : 'k', type : 'string' },
                    c : { type : 'array', items : { type : 'integer', minimum : 1 } }
                },
                required             : [ 'a' ],
                additionalProperties : false
            } ) ).toEqual( {
                type       : 'object',
                properties : {
                    a : { type : 'string', nullable : true },
                    b : { type : 'string', enum : [ 'k' ] },
                    c : { type : 'array', items : { type : 'integer', minimum : 1 } }
                },
                required : [ 'a' ]
            } );
        } );

        it( 'generateStructured fails when the model answered with tool calls', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                choices : [ { message : { content : null, tool_calls : [ { id : 'c', type : 'function', function : { name : 'f', arguments : '{}' } } ] }, finish_reason : 'tool_calls' } ]
            } ) );

            await expect( generateStructured( openai(), { messages : userMsg, outputSchema : labelSchema } ) )
                .rejects.toBeInstanceOf( ProviderError );
        } );
    } );
} );
