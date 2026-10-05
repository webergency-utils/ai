import type { ModelPricing, PricingRegistry } from './pricing.js';

export interface PricingSource
{
    readonly name : string
    fetchPricing(): Promise<Record<string, ModelPricing>>
}

export interface OpenRouterPricingSourceOptions
{
    baseUrl? : string
    apiKey?  : string
}

export class OpenRouterPricingSource implements PricingSource
{
    readonly name = 'openrouter';
    readonly #baseUrl: string;
    readonly #apiKey?: string;

    constructor( options: OpenRouterPricingSourceOptions = {} )
    {
        this.#baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
        this.#apiKey = options.apiKey;
    }

    public async fetchPricing(): Promise<Record<string, ModelPricing>>
    {
        const headers: Record<string, string> = {
            'Accept' : 'application/json'
        };

        if( this.#apiKey )
        {
            headers[ 'Authorization' ] = `Bearer ${ this.#apiKey }`;
        }

        const response = await fetch( `${ this.#baseUrl }/models`, {
            method : 'GET',
            headers
        } );

        if( !response.ok )
        {
            throw new Error( `Failed to fetch OpenRouter models: ${ response.status } ${ response.statusText }` );
        }

        const body = await response.json() as {
            data?: Array<{
                id: string
                pricing?: {
                    prompt?: string
                    completion?: string
                    request?: string
                    image?: string
                }
            }>
        };

        const result: Record<string, ModelPricing> = {};

        if( !Array.isArray( body?.data ) ){return result;}

        for( const item of body.data )
        {
            if( !item.id || !item.pricing ){continue;}

            const promptPerToken = parseFloat( item.pricing.prompt ?? '0' );
            const completionPerToken = parseFloat( item.pricing.completion ?? '0' );

            if( isNaN( promptPerToken ) || isNaN( completionPerToken ) ){continue;}

            const pricing: ModelPricing = 
                {
                    inputPerMillion  : promptPerToken * 1_000_000,
                    outputPerMillion : completionPerToken * 1_000_000
                };

            // Register canonical identifier (e.g. "openai/gpt-4o")
            result[ item.id.toLowerCase() ] = pricing;

            // Also register short identifier if namespaced (e.g. "gpt-4o")
            const slashIndex = item.id.indexOf( '/' );

            if( slashIndex !== -1 )
            {
                const shortId = item.id.slice( slashIndex + 1 ).toLowerCase();

                if( !result[ shortId ] )
                {
                    result[ shortId ] = pricing;
                }
            }
        }

        return result;
    }
}

export interface LiteLLMPricingSourceOptions
{
    url? : string
}

export class LiteLLMPricingSource implements PricingSource
{
    readonly name = 'litellm';
    readonly #url: string;

    constructor( options: LiteLLMPricingSourceOptions = {} )
    {
        this.#url = options.url ?? 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
    }

    public async fetchPricing(): Promise<Record<string, ModelPricing>>
    {
        const response = await fetch( this.#url, {
            method  : 'GET',
            headers : { 'Accept' : 'application/json' }
        } );

        if( !response.ok )
        {
            throw new Error( `Failed to fetch LiteLLM model catalog: ${ response.status } ${ response.statusText }` );
        }

        const data = await response.json() as Record<string, {
            input_cost_per_token?            : number
            output_cost_per_token?           : number
            cache_read_input_token_cost?     : number
            cache_creation_input_token_cost? : number
            output_cost_per_reasoning_token? : number
        }>;

        const result: Record<string, ModelPricing> = {};

        for( const [ model, spec ] of Object.entries( data ) )
        {
            if( typeof spec !== 'object' || spec === null ){continue;}
            if( typeof spec.input_cost_per_token !== 'number' || typeof spec.output_cost_per_token !== 'number' ){continue;}

            const pricing: ModelPricing = 
                {
                    inputPerMillion  : spec.input_cost_per_token * 1_000_000,
                    outputPerMillion : spec.output_cost_per_token * 1_000_000
                };

            if( typeof spec.cache_read_input_token_cost === 'number' )
            {
                pricing.cacheReadPerMillion = spec.cache_read_input_token_cost * 1_000_000;
            }

            if( typeof spec.cache_creation_input_token_cost === 'number' )
            {
                pricing.cacheWritePerMillion = spec.cache_creation_input_token_cost * 1_000_000;
            }

            if( typeof spec.output_cost_per_reasoning_token === 'number' )
            {
                pricing.reasoningPerMillion = spec.output_cost_per_reasoning_token * 1_000_000;
            }

            result[ model.toLowerCase() ] = pricing;
        }

        return result;
    }
}

export interface CustomHttpPricingSourceOptions
{
    url        : string
    name?      : string
    headers?   : Record<string, string>
    transform? : ( raw: unknown ) => Record<string, ModelPricing>
}

export class CustomHttpPricingSource implements PricingSource
{
    readonly name: string;
    readonly #url: string;
    readonly #headers?: Record<string, string>;
    readonly #transform?: ( raw: unknown ) => Record<string, ModelPricing>;

    constructor( options: CustomHttpPricingSourceOptions )
    {
        this.name = options.name ?? 'custom-http';
        this.#url = options.url;
        this.#headers = options.headers;
        this.#transform = options.transform;
    }

    public async fetchPricing(): Promise<Record<string, ModelPricing>>
    {
        const response = await fetch( this.#url, {
            method  : 'GET',
            headers : this.#headers
        } );

        if( !response.ok )
        {
            throw new Error( `Custom pricing source request failed: ${ response.status } ${ response.statusText }` );
        }

        const json = await response.json();

        if( this.#transform )
        {
            return this.#transform( json );
        }

        return json as Record<string, ModelPricing>;
    }
}

export interface PricingSyncOptions
{
    registry    : PricingRegistry
    source      : PricingSource
    intervalMs? : number
    autoStart?  : boolean
    onError?    : ( error: unknown ) => void
}

export class PricingSyncService
{
    readonly #registry: PricingRegistry;
    readonly #source: PricingSource;
    readonly #onError?: ( error: unknown ) => void;
    #intervalMs?: number;
    #timer?: NodeJS.Timeout;

    constructor( options: PricingSyncOptions )
    {
        this.#registry = options.registry;
        this.#source = options.source;
        this.#intervalMs = options.intervalMs;
        this.#onError = options.onError;

        if( options.autoStart && this.#intervalMs && this.#intervalMs > 0 )
        {
            this.startAutoSync( this.#intervalMs );
        }
    }

    public async sync(): Promise<void>
    {
        try
        {
            const pricing = await this.#source.fetchPricing();

            this.#registry.updateMany( pricing );
        }
        catch( error: unknown )
        {
            if( this.#onError )
            {
                this.#onError( error );
            }
            else
            {
                throw error;
            }
        }
    }

    public startAutoSync( intervalMs?: number ): void
    {
        this.stopAutoSync();

        const ms = intervalMs ?? this.#intervalMs;

        if( !ms || ms <= 0 )
        {
            throw new Error( 'A positive intervalMs is required to start auto-sync' );
        }

        this.#intervalMs = ms;

        this.#timer = setInterval( () =>
        {
            this.sync().catch( ( err ) =>
            {
                if( this.#onError ){this.#onError( err );}
            } );
        }, ms );

        if( typeof this.#timer?.unref === 'function' )
        {
            this.#timer.unref();
        }
    }

    public stopAutoSync(): void
    {
        if( this.#timer )
        {
            clearInterval( this.#timer );
            this.#timer = undefined;
        }
    }
}
