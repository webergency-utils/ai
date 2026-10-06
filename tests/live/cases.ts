/**
 * Shared case table for the live suite (`tests/live`) and the recorded replay suite
 * (`tests/providers/recorded`). Cases assert shape and invariants, never exact model text, so the
 * same function validates real provider output and its recorded copy.
 */
import { expect } from 'vitest';
import { createEmbeddingModel, createModel } from '../../src/providers/registry.js';
import type { EmbeddingProtocol } from '../../src/core/embeddings.js';
import type { LanguageModel } from '../../src/core/protocol.js';
import type { ChatMessage, ModelCapabilities, ModelConfig, ModelStreamChunk, ToolDefinition } from '../../src/core/types.js';
import type { LiveProviderSpec } from './gating.js';

/** 1x1 transparent PNG. */
export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export type CaseId = 'generate' | 'stream' | 'tools' | 'structured' | 'embeddings' | 'multimodal-image';

export interface CaseContext
{
    model       : LanguageModel
    embeddings? : EmbeddingProtocol
}

export interface LiveCase
{
    id       : CaseId
    title    : string
    /** Whether this provider/model combination is expected to support the case. */
    applies  : ( capabilities: ModelCapabilities | undefined, spec: LiveProviderSpec ) => boolean
    run      : ( context: CaseContext ) => Promise<void>
}

export function buildConfig( spec: LiveProviderSpec, apiKey?: string, model: string = spec.model ): ModelConfig
{
    return {
        provider   : spec.id,
        model,
        ...( apiKey ? { apiKey } : {} ),
        ...( spec.baseUrl ? { baseUrl : spec.baseUrl } : {} ),
        // Recorded runs must replay one request per interaction, so no hidden retries.
        maxRetries : 0,
        timeoutMs  : 60_000
    };
}

export function buildContext( spec: LiveProviderSpec, apiKey?: string, model: string = spec.model, embeddingModel: string | undefined = spec.embeddingModel ): CaseContext
{
    return {
        model      : createModel( buildConfig( spec, apiKey, model ) ),
        embeddings : embeddingModel && [ 'openai', 'gemini', 'ollama' ].includes( spec.id )
            ? createEmbeddingModel( buildConfig( spec, apiKey, embeddingModel ) )
            : undefined
    };
}

async function collect( stream: AsyncIterable<ModelStreamChunk> ): Promise<ModelStreamChunk[]>
{
    const chunks: ModelStreamChunk[] = [];

    for await ( const chunk of stream )
    {
        chunks.push( chunk );
    }

    return chunks;
}

const weatherTool: ToolDefinition =
    {
        name        : 'get_weather',
        description : 'Get the current weather for a city.',
        parameters  : { type : 'object', properties : { city : { type : 'string', description : 'City name' } }, required : [ 'city' ] }
    };

const labelSchema = { type : 'object', properties : { label : { type : 'string', enum : [ 'positive', 'negative', 'neutral' ] } }, required : [ 'label' ], additionalProperties : false };

export const CASES: LiveCase[] =
    [
        {
            id      : 'generate',
            title   : 'plain generate',
            applies : () => true,
            async run( { model } )
            {
                const response = await model.generate( { messages : [ { role : 'user', content : 'Reply with the single word: pong' } ], maxTokens : 64 } );

                expect( response.role ).toBe( 'assistant' );
                expect( response.content.trim().length ).toBeGreaterThan( 0 );
                expect( [ 'stop', 'length' ] ).toContain( response.finishReason );

                if( !response.usageMissing )
                {
                    expect( response.usage?.totalTokens ).toBeGreaterThan( 0 );
                }
            }
        },
        {
            id      : 'stream',
            title   : 'streaming',
            applies : () => true,
            async run( { model } )
            {
                const chunks = await collect( model.stream( { messages : [ { role : 'user', content : 'Count from 1 to 3.' } ], maxTokens : 64 } ) );
                const text = chunks.map( ( c ) => c.deltaContent ).join( '' );

                expect( chunks.length ).toBeGreaterThan( 1 );
                expect( text.trim().length ).toBeGreaterThan( 0 );
                expect( chunks.some( ( c ) => c.finishReason !== undefined ) ).toBe( true );
                expect( chunks.at( -1 )!.finishReason ).toBeDefined();
            }
        },
        {
            id      : 'tools',
            title   : 'tool call round trip',
            applies : () => true,
            async run( { model } )
            {
                const messages: ChatMessage[] = [ { role : 'user', content : 'What is the weather in Prague? Use the get_weather tool.' } ];
                const first = await model.generate( { messages, tools : [ weatherTool ], toolChoice : 'required', maxTokens : 128 } );

                expect( first.toolCalls?.length ).toBeGreaterThan( 0 );
                const call = first.toolCalls![0]!;
                expect( call.name ).toBe( 'get_weather' );
                expect( typeof call.arguments.city ).toBe( 'string' );
                expect( call.id.length ).toBeGreaterThan( 0 );

                const second = await model.generate(
                    {
                        messages : [
                            ...messages,
                            { role : 'assistant', content : first.content, toolCalls : first.toolCalls },
                            { role : 'tool', content : JSON.stringify( { temperatureC : 18, condition : 'cloudy' } ), toolCallId : call.id, name : call.name }
                        ],
                        tools     : [ weatherTool ],
                        maxTokens : 128
                    } );

                expect( second.content.trim().length ).toBeGreaterThan( 0 );
            }
        },
        {
            id      : 'structured',
            title   : 'structured output',
            applies : ( caps ) => caps?.structuredOutput === true,
            async run( { model } )
            {
                const response = await model.generate(
                    {
                        messages     : [ { role : 'user', content : 'Classify the sentiment of: "I love this library".' } ],
                        outputSchema : labelSchema,
                        maxTokens    : 128
                    } );

                const structured = response.structured as { label?: unknown };

                expect( typeof structured.label ).toBe( 'string' );
                expect( [ 'positive', 'negative', 'neutral' ] ).toContain( structured.label );
            }
        },
        {
            id      : 'embeddings',
            title   : 'embeddings',
            applies : ( _caps, spec ) => spec.embeddingModel !== undefined && [ 'openai', 'gemini', 'ollama' ].includes( spec.id ),
            async run( { embeddings } )
            {
                expect( embeddings ).toBeDefined();
                const response = await embeddings!.embed( [ 'hello world', 'goodbye world' ] );

                expect( response.vectors ).toHaveLength( 2 );
                expect( response.vectors[0]!.length ).toBeGreaterThan( 0 );
                expect( response.vectors[1]!.length ).toBe( response.vectors[0]!.length );
                expect( response.vectors[0]!.every( ( n ) => Number.isFinite( n ) ) ).toBe( true );
            }
        },
        {
            id      : 'multimodal-image',
            title   : 'image input',
            applies : ( caps ) => caps?.multimodal?.image === true,
            async run( { model } )
            {
                const response = await model.generate(
                    {
                        messages  : [ { role : 'user', content : 'Describe this image in one short sentence.', attachments : [ { type : 'image', mimeType : 'image/png', data : TINY_PNG_BASE64 } ] } ],
                        maxTokens : 128
                    } );

                expect( response.content.trim().length ).toBeGreaterThan( 0 );
            }
        }
    ];

export function caseById( id: string ): LiveCase
{
    const found = CASES.find( ( c ) => c.id === id );

    if( !found )
    {
        throw new Error( `unknown case "${ id }"` );
    }

    return found;
}
