import { BaseEmbeddingAdapter } from './embeddings-base.js';
import type { EmbeddingOptions, EmbeddingResponse } from '../core/embeddings.js';
import { assertEmbeddingVectors } from '../core/embeddings.js';
import type { ModelConfig } from '../core/types.js';
import { ProviderError } from '../core/error.js';

interface OpenAIEmbeddingResponse
{
    data?  : Array<{ index? : number, embedding? : number[] }>
    model? : string
    usage? : { prompt_tokens? : number, total_tokens? : number }
}

export class OpenAIEmbeddingAdapter extends BaseEmbeddingAdapter
{
    readonly #baseUrl : string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    }

    protected async embedBatch( inputs: string[], options: EmbeddingOptions ): Promise<EmbeddingResponse>
    {
        const apiKey = this.getApiKey( 'OPENAI_API_KEY' );
        const payload: Record<string, unknown> = 
            {
                model           : this.model,
                input           : inputs,
                encoding_format : 'float'
            };

        if( options.dimensions !== undefined )
        {
            payload.dimensions = options.dimensions;
        }

        const response = await this.request( {
            url  : `${this.#baseUrl}/embeddings`,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'  : 'application/json',
                    'Authorization' : `Bearer ${apiKey}`
                },
                body : JSON.stringify( payload )
            },
            ...this.embeddingTransport( options )
        } );

        const data = await response.json() as OpenAIEmbeddingResponse;

        if( !Array.isArray( data.data ) )
        {
            throw new ProviderError( this.provider, 'Embeddings response has no data array', 502, data );
        }

        const ordered = [ ...data.data ].sort( ( a, b ) => {return ( a.index ?? 0 ) - ( b.index ?? 0 );} );
        const vectors = assertEmbeddingVectors( this.provider, ordered.map( ( item ) => {return item.embedding;} ), inputs.length );
        const promptTokens = data.usage?.prompt_tokens ?? data.usage?.total_tokens;

        return {
            vectors,
            model : data.model ?? this.model,
            raw   : data,
            ...( promptTokens !== undefined 
                ? { 
                    usage : { 
                        promptTokens, 
                        completionTokens : 0, 
                        totalTokens      : data.usage?.total_tokens ?? promptTokens, 
                        raw              : data.usage as Record<string, unknown> 
                    } 
                } 
                : { usageMissing : true as const } )
        };
    }
}
