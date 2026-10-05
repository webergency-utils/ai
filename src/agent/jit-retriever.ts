import type { IVectorStore, VectorRecord } from '../storage/vector.js';
import type { Tool } from './tool.js';
import type { EmbeddingOptions, EmbeddingProtocol } from '../core/embeddings.js';
import { ProviderError } from '../core/error.js';

export type EmbedderFn = ( text: string ) => Promise<number[]>;

/**
 * Adapts an {@link EmbeddingProtocol} to the retriever's `embedder` hook.
 * Usage: `new JITToolRetriever( { vectorStore, embedder: createEmbedder( createEmbeddingModel( config ) ) } )`.
 */
export function createEmbedder( model: EmbeddingProtocol, options: EmbeddingOptions = {} ): EmbedderFn
{
    return async ( text: string ): Promise<number[]> =>
    {
        const response = await model.embed( text, options );
        const vector = response.vectors[ 0 ];

        if( !vector )
        {
            throw new ProviderError( model.provider, 'Embedding response contained no vector', 502 );
        }

        return vector;
    };
}

export interface JITToolRetrieverOptions
{
    vectorStore : IVectorStore
    embedder?   : EmbedderFn
    dimensions? : number
}

export class JITToolRetriever
{
    readonly #vectorStore: IVectorStore;
    readonly #embedder?: EmbedderFn;
    readonly #dimensions: number;
    readonly #tools = new Map<string, Tool>();

    constructor( options: JITToolRetrieverOptions )
    {
        this.#vectorStore = options.vectorStore;
        this.#embedder = options.embedder;
        this.#dimensions = options.dimensions ?? 64;
    }

    public addTool( tool: Tool ): void
    {
        this.#tools.set( tool.name, tool );
    }

    public registerTools( tools: Tool[] ): void
    {
        for( const tool of tools )
        {
            this.addTool( tool );
        }
    }

    public async indexTools(): Promise<void>
    {
        const records: VectorRecord[] = [];

        for( const tool of this.#tools.values() )
        {
            const textToEmbed = `${tool.name}: ${tool.description}`;
            const values = await this.embedText( textToEmbed );

            records.push( 
                {
                    id       : tool.name,
                    values,
                    content  : tool.description,
                    metadata : { name : tool.name }
                } );
        }

        await this.#vectorStore.upsert( records );
    }

    public async retrieveTools( query: string, limit: number = 5 ): Promise<Tool[]>
    {
        // If total tools is small, return all directly
        if( this.#tools.size <= limit )
        {
            return Array.from( this.#tools.values() );
        }

        const queryVector = await this.embedText( query );
        const queryResults = await this.#vectorStore.query( queryVector, limit );
        const matched: Tool[] = [];

        for( const qr of queryResults )
        {
            const tool = this.#tools.get( qr.id );

            if( tool )
            {
                matched.push( tool );
            }
        }

        return matched;
    }

    public getTools(): Tool[]
    {
        return Array.from( this.#tools.values() );
    }

    private async embedText( text: string ): Promise<number[]>
    {
        if( this.#embedder )
        {
            return this.#embedder( text );
        }

        return this.defaultEmbed( text );
    }

    private defaultEmbed( text: string ): number[]
    {
        const vec = new Array<number>( this.#dimensions ).fill( 0 );
        const words = text.toLowerCase().split( /\W+/ ).filter( Boolean );

        if( words.length === 0 )
        {
            return vec;
        }

        for( const word of words )
        {
            let hash = 0;

            for( let i = 0; i < word.length; i++ )
            {
                hash = ( ( hash << 5 ) - hash ) + word.charCodeAt( i );
                hash |= 0;
            }

            const idx = Math.abs( hash ) % this.#dimensions;
            vec[idx] += 1;
        }

        let sumSq = 0;

        for( const v of vec )
        {
            sumSq += v * v;
        }

        const norm = Math.sqrt( sumSq );

        if( norm === 0 )
        {
            return vec;
        }

        return vec.map( ( v ) => {return v / norm;} );
    }
}
