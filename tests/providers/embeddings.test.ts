import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createEmbeddingModel,
    EmbeddingRegistry,
    MeteredEmbeddingModel,
    OpenAIEmbeddingAdapter,
    GeminiEmbeddingAdapter,
    OllamaEmbeddingAdapter
} from '../../src/providers/index.js';
import { createEmbedder } from '../../src/agent/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { CapabilityError, InvalidInputError, ProviderError, RateLimitError } from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

function lastCall(): { url: string, body: Record<string, any>, headers: Record<string, string> }
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;
    const init = call[ 1 ] as RequestInit;

    return { url : String( call[ 0 ] ), body : JSON.parse( init.body as string ), headers : init.headers as Record<string, string> };
}

describe( 'embeddings', () =>
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

    describe( 'OpenAI', () =>
    {
        const model = (): ReturnType<typeof createEmbeddingModel> =>
        {
            return createEmbeddingModel( { provider : 'openai', model : 'text-embedding-3-small', apiKey : 'k' } );
        };

        it( 'embeds a batch, reorders by index, and reports usage (AE7)', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
                model : 'text-embedding-3-small',
                data  : [ { index : 1, embedding : [ 0.3, 0.4 ] }, { index : 0, embedding : [ 0.1, 0.2 ] } ],
                usage : { prompt_tokens : 4, total_tokens : 4 }
            } ) );

            const res = await model().embed( [ 'a', 'b' ], { dimensions : 2 } );
            const call = lastCall();

            expect( res.vectors ).toEqual( [ [ 0.1, 0.2 ], [ 0.3, 0.4 ] ] );
            expect( res.usage ).toMatchObject( { promptTokens : 4, completionTokens : 0, totalTokens : 4 } );
            expect( res.usageMissing ).toBeUndefined();
            expect( call.url ).toBe( 'https://api.openai.com/v1/embeddings' );
            expect( call.body ).toEqual( { model : 'text-embedding-3-small', input : [ 'a', 'b' ], encoding_format : 'float', dimensions : 2 } );
            expect( call.headers.Authorization ).toBe( 'Bearer k' );
        } );

        it( 'accepts a single string and flags missing usage', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 1, 2, 3 ] } ] } ) );

            const res = await model().embed( 'hello' );

            expect( lastCall().body.input ).toEqual( [ 'hello' ] );
            expect( res.vectors ).toHaveLength( 1 );
            expect( res.usageMissing ).toBe( true );
        } );

        it( 'rejects empty or non-string input before HTTP', async () =>
        {
            await expect( model().embed( [] ) ).rejects.toBeInstanceOf( InvalidInputError );
            await expect( model().embed( [ 'a', 5 as unknown as string ] ) ).rejects.toBeInstanceOf( InvalidInputError );
            expect( fetch ).not.toHaveBeenCalled();
        } );

        it( 'fails loudly on count, dimension, and shape mismatches', async () =>
        {
            vi.mocked( fetch )
                .mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 1 ] } ] } ) )
                .mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 1, 2 ] }, { index : 1, embedding : [ 1 ] } ] } ) )
                .mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 'x' ] } ] } ) )
                .mockResolvedValueOnce( jsonResponse( { nope : true } ) );

            await expect( model().embed( [ 'a', 'b' ] ) ).rejects.toBeInstanceOf( ProviderError );
            await expect( model().embed( [ 'a', 'b' ] ) ).rejects.toThrow( /dimension/ );
            await expect( model().embed( 'a' ) ).rejects.toBeInstanceOf( ProviderError );
            await expect( model().embed( 'a' ) ).rejects.toThrow( /no data/ );
        } );

        it( 'goes through the shared transport: retries 429 and honors retry:false', async () =>
        {
            vi.mocked( fetch )
                .mockResolvedValueOnce( jsonResponse( { error : { message : 'slow down' } }, { status : 429, headers : { 'retry-after-ms' : '1' } } ) )
                .mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 1 ] } ] } ) );

            const attempts: number[] = [];
            const res = await model().embed( 'a', { onAttempt : ( info ) => {attempts.push( info.attempt );} } );

            expect( res.vectors ).toEqual( [ [ 1 ] ] );
            expect( attempts ).toContain( 2 );

            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { error : { message : 'slow down' } }, { status : 429, headers : { 'retry-after-ms' : '1' } } ) );

            await expect( model().embed( 'a', { retry : false } ) ).rejects.toBeInstanceOf( RateLimitError );
        } );
    } );

    describe( 'Gemini', () =>
    {
        it( 'uses batchEmbedContents with prefixed model names', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { embeddings : [ { values : [ 1, 2 ] }, { values : [ 3, 4 ] } ] } ) );

            const adapter = createEmbeddingModel( { provider : 'gemini', model : 'text-embedding-004', apiKey : 'k' } );
            const res = await adapter.embed( [ 'a', 'b' ], { taskType : 'RETRIEVAL_DOCUMENT', dimensions : 2 } );
            const call = lastCall();

            expect( adapter ).toBeInstanceOf( GeminiEmbeddingAdapter );
            expect( res.vectors ).toEqual( [ [ 1, 2 ], [ 3, 4 ] ] );
            expect( res.usageMissing ).toBe( true );
            expect( call.url ).toBe( 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents' );
            expect( call.body.requests ).toEqual( [
                { model : 'models/text-embedding-004', content : { parts : [ { text : 'a' } ] }, taskType : 'RETRIEVAL_DOCUMENT', outputDimensionality : 2 },
                { model : 'models/text-embedding-004', content : { parts : [ { text : 'b' } ] }, taskType : 'RETRIEVAL_DOCUMENT', outputDimensionality : 2 }
            ] );
            expect( call.headers[ 'x-goog-api-key' ] ).toBe( 'k' );
        } );

        it( 'fails when the response lacks embeddings', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {} ) );

            await expect( createEmbeddingModel( { provider : 'gemini', model : 'e', apiKey : 'k' } ).embed( 'a' ) )
                .rejects.toBeInstanceOf( ProviderError );
        } );
    } );

    describe( 'Ollama', () =>
    {
        it( 'posts to /api/embed and maps prompt_eval_count to usage', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { model : 'nomic', embeddings : [ [ 0.5, 0.6 ] ], prompt_eval_count : 7 } ) );

            const adapter = createEmbeddingModel( { provider: 'ollama', model : 'nomic' } );
            const res = await adapter.embed( 'a' );

            expect( adapter ).toBeInstanceOf( OllamaEmbeddingAdapter );
            expect( lastCall().url ).toBe( 'http://127.0.0.1:11434/api/embed' );
            expect( lastCall().body ).toEqual( { model : 'nomic', input : [ 'a' ] } );
            expect( res.usage?.promptTokens ).toBe( 7 );
        } );

        it( 'flags usageMissing when the server omits counts', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { embeddings : [ [ 1 ] ] } ) );

            const res = await createEmbeddingModel( { provider : 'ollama', model : 'm' } ).embed( 'a' );

            expect( res.usageMissing ).toBe( true );
        } );
    } );

    describe( 'registry', () =>
    {
        it( 'names embeddings for chat-only providers and rejects unknown providers', () =>
        {
            for( const provider of [ 'anthropic', 'groq', 'deepseek', 'mistral' ] )
            {
                expect( () => createEmbeddingModel( { provider, model : 'm' } ) ).toThrow( CapabilityError );
                expect( () => createEmbeddingModel( { provider, model : 'm' } ) ).toThrow( /embeddings/ );
            }

            expect( () => createEmbeddingModel( { provider : 'nope', model : 'm' } ) ).toThrow( /not registered/ );
        } );

        it( 'caches by config and supports custom registration', () =>
        {
            const registry = new EmbeddingRegistry();
            const a = registry.create( { provider : 'ollama', model : 'm' } );

            expect( registry.create( { provider : 'ollama', model : 'm' } ) ).toBe( a );
            expect( registry.has( 'OpenAI' ) ).toBe( true );

            registry.register( 'custom', ( config ) => {return new OpenAIEmbeddingAdapter( config );} );
            expect( registry.has( 'custom' ) ).toBe( true );
        } );
    } );

    describe( 'metering', () =>
    {
        it( 'records usage through the tracker', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { data : [ { index : 0, embedding : [ 1 ] } ], usage : { prompt_tokens : 10, total_tokens : 10 } } ) );

            const tracker = new SpendTracker();
            const metered = new MeteredEmbeddingModel(
                createEmbeddingModel( { provider : 'openai', model : 'text-embedding-3-small', apiKey : 'k' } ),
                { tracker }
            );

            await metered.embed( 'a' );

            expect( tracker.records ).toHaveLength( 1 );
        } );

        it( 'records a spend gap when usage is missing', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { embeddings : [ { values : [ 1 ] } ] } ) );

            const tracker = new SpendTracker();
            const gapSpy = vi.spyOn( tracker, 'recordSpendGap' );
            const metered = new MeteredEmbeddingModel(
                createEmbeddingModel( { provider : 'gemini', model : 'e', apiKey : 'k' } ),
                { tracker }
            );

            await metered.embed( 'a' );

            expect( gapSpy ).toHaveBeenCalledOnce();
            expect( tracker.records ).toHaveLength( 0 );
        } );
    } );

    describe( 'JIT retriever integration', () =>
    {
        it( 'createEmbedder adapts an embedding model to the retriever hook', async () =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { embeddings : [ [ 0.1, 0.2, 0.3 ] ] } ) );

            const embed = createEmbedder( createEmbeddingModel( { provider : 'ollama', model : 'm' } ) );

            expect( await embed( 'text' ) ).toEqual( [ 0.1, 0.2, 0.3 ] );
        } );
    } );
} );
