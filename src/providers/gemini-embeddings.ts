import { BaseEmbeddingAdapter } from './embeddings-base.js';
import type { EmbeddingOptions, EmbeddingResponse } from '../core/embeddings.js';
import { assertEmbeddingVectors } from '../core/embeddings.js';
import type { ModelConfig } from '../core/types.js';
import { ProviderError } from '../core/error.js';

interface GeminiEmbeddingResponse
{
    embeddings? : Array<{ values? : number[] }>
}

/** Uses `batchEmbedContents` for every call (a batch of one covers the single-input case). */
export class GeminiEmbeddingAdapter extends BaseEmbeddingAdapter
{
    readonly #baseUrl : string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    }

    protected async embedBatch( inputs: string[], options: EmbeddingOptions ): Promise<EmbeddingResponse>
    {
        const apiKey = this.getApiKey( 'GEMINI_API_KEY' );
        const modelName = this.model.startsWith( 'models/' ) ? this.model : `models/${this.model}`;
        const requests = inputs.map( ( text ) => 
        {
            return {
                model   : modelName,
                content : { parts : [ { text } ] },
                ...( options.taskType ? { taskType : options.taskType } : {} ),
                ...( options.dimensions !== undefined ? { outputDimensionality : options.dimensions } : {} )
            };
        } );

        const response = await this.request( {
            url  : `${this.#baseUrl}/${modelName}:batchEmbedContents`,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'   : 'application/json',
                    'x-goog-api-key' : apiKey
                },
                body : JSON.stringify( { requests } )
            },
            ...this.embeddingTransport( options )
        } );

        const data = await response.json() as GeminiEmbeddingResponse;

        if( !Array.isArray( data.embeddings ) )
        {
            throw new ProviderError( this.provider, 'Embeddings response has no embeddings array', 502, data );
        }

        return {
            vectors      : assertEmbeddingVectors( this.provider, data.embeddings.map( ( item ) => {return item.values;} ), inputs.length ),
            model        : this.model,
            usageMissing : true,
            raw          : data
        };
    }
}
