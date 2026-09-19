import type { ModelProtocol } from '../core/protocol.js';
import type { ModelConfig } from '../core/types.js';
import { ProviderError } from '../core/error.js';
import { OpenAIProviderAdapter } from './openai.js';
import { AnthropicProviderAdapter } from './anthropic.js';
import { GeminiProviderAdapter } from './gemini.js';
import { GroqProviderAdapter } from './groq.js';
import { OllamaProviderAdapter } from './ollama.js';

export type ProviderFactory = ( config: ModelConfig ) => ModelProtocol;

export class ModelRegistry
{
    readonly #factories = new Map<string, ProviderFactory>();
    readonly #cache     = new Map<string, ModelProtocol>();

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

    public create( config: ModelConfig ): ModelProtocol
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

        const cacheKey = `${providerId}:${config.model}:${config.baseUrl ?? ''}`;

        if( this.#cache.has( cacheKey ) )
        {
            return this.#cache.get( cacheKey )!;
        }

        const adapter = factory( config );
        this.#cache.set( cacheKey, adapter );

        return adapter;
    }

    public resolve( providerId: string, config: Omit<ModelConfig, 'provider'> ): ModelProtocol
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
            return new OpenAIProviderAdapter( 
                {
                    ...config,
                    provider : 'deepseek',
                    baseUrl  : config.baseUrl ?? 'https://api.deepseek.com'
                } );
        } );

        this.register( 'mistral', ( config ) => 
        {
            return new OpenAIProviderAdapter( 
                {
                    ...config,
                    provider : 'mistral',
                    baseUrl  : config.baseUrl ?? 'https://api.mistral.ai/v1'
                } );
        } );
    }
}

export const defaultRegistry = new ModelRegistry();

export function createModel( config: ModelConfig ): ModelProtocol
{
    return defaultRegistry.create( config );
}
