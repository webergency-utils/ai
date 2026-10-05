import type { LanguageModel } from '../core/protocol.js';
import type { EmbeddingProtocol } from '../core/embeddings.js';
import type { ModelConfig } from '../core/types.js';
import { CapabilityError, ProviderError } from '../core/error.js';
import { OpenAIProviderAdapter } from './openai.js';
import { AnthropicProviderAdapter } from './anthropic.js';
import { GeminiProviderAdapter } from './gemini.js';
import { GroqProviderAdapter } from './groq.js';
import { OllamaProviderAdapter } from './ollama.js';
import { DeepSeekProviderAdapter } from './deepseek.js';
import { MistralProviderAdapter } from './mistral.js';
import { OpenAIEmbeddingAdapter } from './openai-embeddings.js';
import { GeminiEmbeddingAdapter } from './gemini-embeddings.js';
import { OllamaEmbeddingAdapter } from './ollama-embeddings.js';

export type ProviderFactory = ( config: ModelConfig ) => LanguageModel;

function configCacheKey( config: ModelConfig ): string
{
    const keys = Object.keys( config ).sort();

    return JSON.stringify( config, keys );
}

export class ModelRegistry
{
    readonly #factories = new Map<string, ProviderFactory>();
    readonly #cache     = new Map<string, LanguageModel>();

    constructor()
    {
        this.registerDefaults();
    }

    public register( providerId: string, factory: ProviderFactory ): void
    {
        this.#factories.set( providerId.toLowerCase(), factory );
    }

    public has( providerId: string ): boolean
    {
        return this.#factories.has( providerId.toLowerCase() );
    }

    public create( config: ModelConfig ): LanguageModel
    {
        const providerId = config.provider.toLowerCase();
        const factory = this.#factories.get( providerId );

        if( !factory )
        {
            throw new ProviderError( 
                config.provider, 
                `Provider '${config.provider}' is not registered in ModelRegistry` 
            );
        }

        const cacheKey = configCacheKey( config );

        if( this.#cache.has( cacheKey ) )
        {
            return this.#cache.get( cacheKey )!;
        }

        const adapter = factory( config );
        this.#cache.set( cacheKey, adapter );

        return adapter;
    }

    public resolve( providerId: string, config: Omit<ModelConfig, 'provider'> ): LanguageModel
    {
        return this.create( {
            ...config,
            provider : providerId
        } );
    }

    public clearCache(): void
    {
        this.#cache.clear();
    }

    private registerDefaults(): void
    {
        this.register( 'openai', ( config ) => 
        {
            return new OpenAIProviderAdapter( config );
        } );

        this.register( 'anthropic', ( config ) => 
        {
            return new AnthropicProviderAdapter( config );
        } );

        this.register( 'gemini', ( config ) => 
        {
            return new GeminiProviderAdapter( config );
        } );

        this.register( 'groq', ( config ) => 
        {
            return new GroqProviderAdapter( config );
        } );

        this.register( 'ollama', ( config ) => 
        {
            return new OllamaProviderAdapter( config );
        } );

        this.register( 'deepseek', ( config ) => 
        {
            return new DeepSeekProviderAdapter( config );
        } );

        this.register( 'mistral', ( config ) => 
        {
            return new MistralProviderAdapter( config );
        } );
    }
}

export const defaultRegistry = new ModelRegistry();

export function createModel( config: ModelConfig ): LanguageModel
{
    return defaultRegistry.create( config );
}

export type EmbeddingProviderFactory = ( config: ModelConfig ) => EmbeddingProtocol;

/**
 * Parallel registry for embedding providers. Chat providers without an embeddings
 * API (anthropic, groq, deepseek, mistral) fail with a capability error naming `embeddings`.
 */
export class EmbeddingRegistry
{
    readonly #factories = new Map<string, EmbeddingProviderFactory>();
    readonly #cache     = new Map<string, EmbeddingProtocol>();

    constructor()
    {
        this.register( 'openai', ( config ) => {return new OpenAIEmbeddingAdapter( config );} );
        this.register( 'gemini', ( config ) => {return new GeminiEmbeddingAdapter( config );} );
        this.register( 'ollama', ( config ) => {return new OllamaEmbeddingAdapter( config );} );
    }

    public register( providerId: string, factory: EmbeddingProviderFactory ): void
    {
        this.#factories.set( providerId.toLowerCase(), factory );
    }

    public has( providerId: string ): boolean
    {
        return this.#factories.has( providerId.toLowerCase() );
    }

    public create( config: ModelConfig ): EmbeddingProtocol
    {
        const providerId = config.provider.toLowerCase();
        const factory = this.#factories.get( providerId );

        if( !factory )
        {
            if( defaultRegistry.has( providerId ) )
            {
                throw new CapabilityError( 
                    config.provider, 
                    'embeddings', 
                    `provider '${config.provider}' has no embeddings support; use baseUrl with an OpenAI-compatible 'openai' embedding config` 
                );
            }

            throw new ProviderError( 
                config.provider, 
                `Provider '${config.provider}' is not registered in EmbeddingRegistry` 
            );
        }

        const cacheKey = configCacheKey( config );
        const cached = this.#cache.get( cacheKey );

        if( cached )
        {
            return cached;
        }

        const adapter = factory( config );
        this.#cache.set( cacheKey, adapter );

        return adapter;
    }

    public clearCache(): void
    {
        this.#cache.clear();
    }
}

export const defaultEmbeddingRegistry = new EmbeddingRegistry();

export function createEmbeddingModel( config: ModelConfig ): EmbeddingProtocol
{
    return defaultEmbeddingRegistry.create( config );
}
