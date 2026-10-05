import { BaseEmbeddingAdapter } from './embeddings-base.js';
import type { EmbeddingOptions, EmbeddingResponse } from '../core/embeddings.js';
import { assertEmbeddingVectors } from '../core/embeddings.js';
import type { ModelConfig } from '../core/types.js';
import { ProviderError } from '../core/error.js';

interface OllamaEmbeddingResponse
{
    model?             : string
    embeddings?        : number[][]
    prompt_eval_count? : number
}

/** Uses the batch-capable `/api/embed` endpoint. */
export class OllamaEmbeddingAdapter extends BaseEmbeddingAdapter
{
    readonly #baseUrl : string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'http://127.0.0.1:11434';
    }

    protected async embedBatch( inputs: string[], options: EmbeddingOptions ): Promise<EmbeddingResponse>
    {
        const payload: Record<string, unknown> = { model : this.model, input : inputs };

        if( options.dimensions !== undefined )
        {
            payload.dimensions = options.dimensions;
        }

        const response = await this.request( {
            url  : `${this.#baseUrl}/api/embed`,
            init : {
                method  : 'POST',
                headers : { 'Content-Type' : 'application/json' },
                body    : JSON.stringify( payload )
            },
            ...this.embeddingTransport( options )
        } );

        const data = await response.json() as OllamaEmbeddingResponse;

        if( !Array.isArray( data.embeddings ) )
        {
            throw new ProviderError( this.provider, 'Embeddings response has no embeddings array', 502, data );
        }

        const vectors = assertEmbeddingVectors( this.provider, data.embeddings, inputs.length );
        const promptTokens = data.prompt_eval_count;

        return {
            vectors,
            model : data.model ?? this.model,
            raw   : data,
            ...( promptTokens !== undefined 
                ? { usage : { promptTokens, completionTokens : 0, totalTokens : promptTokens, raw : data as Record<string, unknown> } } 
                : { usageMissing : true as const } )
        };
    }
}
