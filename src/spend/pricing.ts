export interface PricingTier
{
    /** Inclusive upper bound on prompt tokens for this tier; omit / null for open-ended. */
    upToPromptTokens : number | null
    inputPerMillion  : number
    outputPerMillion : number
    cacheReadPerMillion?  : number
    cacheWritePerMillion? : number
}

export interface ModelPricing
{
    inputPerMillion       : number
    outputPerMillion      : number
    cacheReadPerMillion?  : number
    /** Default / 5-minute Anthropic cache-write rate */
    cacheWritePerMillion? : number
    cacheWrite5mPerMillion? : number
    cacheWrite1hPerMillion? : number
    reasoningPerMillion?  : number
    /** ISO date (YYYY-MM-DD) when this price becomes effective */
    effectiveFrom?        : string
    tiers?                : PricingTier[]
    /** Declared free class (e.g. default local Ollama) */
    free?                 : boolean
    provider?             : string
}

export interface PricingIdentity
{
    provider  : string
    model     : string
    baseUrl?  : string
}

export type PricingResolution =
    | { status : 'priced', pricing : ModelPricing, key : string }
    | { status : 'free', pricing : ModelPricing, key : string }
    | { status : 'unpriced', reason : 'unknown_model' | 'custom_base_url' }

export interface PricingChangeEvent
{
    model     : string
    previous? : ModelPricing
    current   : ModelPricing
}

export type PricingChangeListener = ( event: PricingChangeEvent ) => void;

export type PricingUpdater = () => Promise<Record<string, ModelPricing>> | Record<string, ModelPricing>;

export const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = 
    {
        openai    : 'https://api.openai.com/v1',
        anthropic : 'https://api.anthropic.com',
        gemini    : 'https://generativelanguage.googleapis.com/v1beta',
        groq      : 'https://api.groq.com/openai/v1',
        deepseek  : 'https://api.deepseek.com',
        mistral   : 'https://api.mistral.ai/v1',
        ollama    : 'http://127.0.0.1:11434'
    };

/** Recognized snapshot / date suffixes for prefix price matching (R25, R51). */
const RECOGNIZED_SUFFIX = /^(-\d{4}-\d{2}-\d{2}|-\d{8}|-latest|-preview(?:-\d+)?)$/i;

export function isRecognizedModelSuffix( remainder: string ): boolean
{
    if( !remainder )
    {
        return true;
    }

    return RECOGNIZED_SUFFIX.test( remainder );
}

export function pricingKey( provider: string, model: string ): string
{
    return `${provider.toLowerCase()}:${model.toLowerCase()}`;
}

export function normalizeBaseUrl( url: string ): string
{
    let end = url.length;

    while( end > 0 && url.charCodeAt( end - 1 ) === 47 /* '/' */ )
    {
        end -= 1;
    }

    return url.slice( 0, end ).toLowerCase();
}

export function isDefaultProviderBaseUrl( provider: string, baseUrl?: string ): boolean
{
    if( baseUrl === undefined || baseUrl === '' )
    {
        return true;
    }

    const defaults = DEFAULT_PROVIDER_BASE_URLS[ provider.toLowerCase() ];

    if( !defaults )
    {
        return false;
    }

    return normalizeBaseUrl( baseUrl ) === normalizeBaseUrl( defaults );
}

/**
 * Built-in prices for supported providers (R33 / R52).
 * Keys are `provider:model`. Bare model aliases are also registered for lookup.
 * DeepSeek entries use peak (cache-miss) rates.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = 
    {
        'openai:gpt-4o' : {
            provider            : 'openai',
            inputPerMillion     : 2.50,
            outputPerMillion    : 10.00,
            cacheReadPerMillion : 1.25
        },
        'openai:gpt-4o-mini' : {
            provider            : 'openai',
            inputPerMillion     : 0.15,
            outputPerMillion    : 0.60,
            cacheReadPerMillion : 0.075
        },
        'openai:o1' : {
            provider            : 'openai',
            inputPerMillion     : 15.00,
            outputPerMillion    : 60.00,
            cacheReadPerMillion : 7.50
        },
        'openai:o3-mini' : {
            provider            : 'openai',
            inputPerMillion     : 1.10,
            outputPerMillion    : 4.40,
            cacheReadPerMillion : 0.55
        },

        'anthropic:claude-3-7-sonnet-20250219' : {
            provider               : 'anthropic',
            inputPerMillion        : 3.00,
            outputPerMillion       : 15.00,
            cacheReadPerMillion    : 0.30,
            cacheWritePerMillion   : 3.75,
            cacheWrite5mPerMillion : 3.75,
            cacheWrite1hPerMillion : 6.00
        },
        'anthropic:claude-3-5-sonnet-20241022' : {
            provider               : 'anthropic',
            inputPerMillion        : 3.00,
            outputPerMillion       : 15.00,
            cacheReadPerMillion    : 0.30,
            cacheWritePerMillion   : 3.75,
            cacheWrite5mPerMillion : 3.75,
            cacheWrite1hPerMillion : 6.00
        },
        'anthropic:claude-3-5-haiku-20241022' : {
            provider               : 'anthropic',
            inputPerMillion        : 0.80,
            outputPerMillion       : 4.00,
            cacheReadPerMillion    : 0.08,
            cacheWritePerMillion   : 1.00,
            cacheWrite5mPerMillion : 1.00,
            cacheWrite1hPerMillion : 1.60
        },
        'anthropic:claude-3-opus-20240229' : {
            provider               : 'anthropic',
            inputPerMillion        : 15.00,
            outputPerMillion       : 75.00,
            cacheReadPerMillion    : 1.50,
            cacheWritePerMillion   : 18.75,
            cacheWrite5mPerMillion : 18.75,
            cacheWrite1hPerMillion : 30.00
        },

        'gemini:gemini-2.5-flash' : {
            provider            : 'gemini',
            inputPerMillion     : 0.15,
            outputPerMillion    : 0.60,
            cacheReadPerMillion : 0.0375
        },
        'gemini:gemini-2.5-pro' : {
            provider            : 'gemini',
            inputPerMillion     : 1.25,
            outputPerMillion    : 10.00,
            cacheReadPerMillion : 0.315,
            tiers               : [
                {
                    upToPromptTokens    : 200_000,
                    inputPerMillion     : 1.25,
                    outputPerMillion    : 10.00,
                    cacheReadPerMillion : 0.315
                },
                {
                    upToPromptTokens    : null,
                    inputPerMillion     : 2.50,
                    outputPerMillion    : 15.00,
                    cacheReadPerMillion : 0.625
                }
            ]
        },
        'gemini:gemini-2.0-flash' : {
            provider            : 'gemini',
            inputPerMillion     : 0.10,
            outputPerMillion    : 0.40,
            cacheReadPerMillion : 0.025
        },

        // DeepSeek peak (cache-miss) rates (R52)
        'deepseek:deepseek-chat' : {
            provider            : 'deepseek',
            inputPerMillion     : 0.27,
            outputPerMillion    : 1.10,
            cacheReadPerMillion : 0.07
        },
        'deepseek:deepseek-reasoner' : {
            provider            : 'deepseek',
            inputPerMillion     : 0.55,
            outputPerMillion    : 2.19,
            cacheReadPerMillion : 0.14
        },

        'groq:llama-3.3-70b-versatile' : {
            provider         : 'groq',
            inputPerMillion  : 0.59,
            outputPerMillion : 0.79
        },

        'ollama:*' : {
            provider         : 'ollama',
            free             : true,
            inputPerMillion  : 0,
            outputPerMillion : 0
        }
    };

function expandDefaultAliases( prices: Record<string, ModelPricing> ): Record<string, ModelPricing>
{
    const out: Record<string, ModelPricing> = { ...prices };

    for( const [ key, pricing ] of Object.entries( prices ) )
    {
        const colon = key.indexOf( ':' );

        if( colon > 0 )
        {
            const bare = key.slice( colon + 1 );

            if( bare !== '*' && out[ bare ] === undefined )
            {
                out[ bare ] = pricing;
            }
        }
    }

    return out;
}

const EXPANDED_DEFAULTS = expandDefaultAliases( DEFAULT_PRICING );

export class PricingRegistry
{
    readonly #prices    = new Map<string, ModelPricing>();
    readonly #listeners = new Set<PricingChangeListener>();

    constructor()
    {
        for( const [ model, pricing ] of Object.entries( EXPANDED_DEFAULTS ) )
        {
            this.#prices.set( model.toLowerCase(), pricing );
        }
    }

    public on( event: 'change', listener: PricingChangeListener ): () => void
    {
        this.#listeners.add( listener );

        return () => this.off( event, listener );
    }

    public off( event: 'change', listener: PricingChangeListener ): void
    {
        this.#listeners.delete( listener );
    }

    public register( model: string, pricing: ModelPricing ): void
    {
        const norm = model.toLowerCase();
        const prev = this.#prices.get( norm );

        this.#prices.set( norm, pricing );

        const hasChanged = !prev
            || prev.inputPerMillion !== pricing.inputPerMillion
            || prev.outputPerMillion !== pricing.outputPerMillion
            || prev.cacheReadPerMillion !== pricing.cacheReadPerMillion
            || prev.cacheWritePerMillion !== pricing.cacheWritePerMillion
            || prev.cacheWrite5mPerMillion !== pricing.cacheWrite5mPerMillion
            || prev.cacheWrite1hPerMillion !== pricing.cacheWrite1hPerMillion
            || prev.reasoningPerMillion !== pricing.reasoningPerMillion
            || prev.free !== pricing.free;

        if( hasChanged )
        {
            for( const listener of this.#listeners )
            {
                listener( {
                    model    : norm,
                    previous : prev,
                    current  : pricing
                } );
            }
        }
    }

    public updateMany( prices: Record<string, ModelPricing> | Map<string, ModelPricing> ): void
    {
        const entries = prices instanceof Map ? prices.entries() : Object.entries( prices );

        for( const [ model, pricing ] of entries )
        {
            this.register( model, pricing );
        }
    }

    public getAll(): Record<string, ModelPricing>
    {
        const result: Record<string, ModelPricing> = {};

        for( const [ model, pricing ] of this.#prices.entries() )
        {
            result[ model ] = pricing;
        }

        return result;
    }

    /**
     * Exact name, then longest priced prefix whose remainder is a recognized
     * snapshot/date suffix (R25, R51). Unlisted siblings are not matched.
     */
    public get( model: string ): ModelPricing | undefined
    {
        const norm = model.toLowerCase();

        if( this.#prices.has( norm ) )
        {
            return this.#prices.get( norm );
        }

        let bestKey: string | undefined;
        let bestPricing: ModelPricing | undefined;

        for( const [ key, pricing ] of this.#prices.entries() )
        {
            if( key.includes( ':' ) && !norm.includes( ':' ) )
            {
                // Prefer bare-model / provider:model handled via resolve().
                continue;
            }

            if( !norm.startsWith( key ) || key.length === 0 )
            {
                continue;
            }

            const remainder = norm.slice( key.length );

            if( !isRecognizedModelSuffix( remainder ) )
            {
                continue;
            }

            if( !bestKey || key.length > bestKey.length )
            {
                bestKey = key;
                bestPricing = pricing;
            }
        }

        return bestPricing;
    }

    public resolve( identity: PricingIdentity ): PricingResolution
    {
        const provider = identity.provider.toLowerCase();
        const model = identity.model.toLowerCase();
        const customBase = identity.baseUrl !== undefined 
            && identity.baseUrl !== '' 
            && !isDefaultProviderBaseUrl( provider, identity.baseUrl );

        if( provider === 'ollama' && !customBase )
        {
            const free = this.#prices.get( 'ollama:*' ) ?? {
                provider         : 'ollama',
                free             : true,
                inputPerMillion  : 0,
                outputPerMillion : 0
            };

            return { status : 'free', pricing : free, key : 'ollama:*' };
        }

        if( customBase )
        {
            const scoped = `${pricingKey( provider, model )}@${normalizeBaseUrl( identity.baseUrl! )}`;

            if( this.#prices.has( scoped ) )
            {
                const pricing = this.#prices.get( scoped )!;

                return pricing.free 
                    ? { status : 'free', pricing, key : scoped }
                    : { status : 'priced', pricing, key : scoped };
            }

            return { status : 'unpriced', reason : 'custom_base_url' };
        }

        const fullKey = pricingKey( provider, model );

        if( this.#prices.has( fullKey ) )
        {
            const pricing = this.#prices.get( fullKey )!;

            return pricing.free 
                ? { status : 'free', pricing, key : fullKey }
                : { status : 'priced', pricing, key : fullKey };
        }

        // Longest provider-scoped prefix with recognized suffix.
        let bestKey: string | undefined;
        let bestPricing: ModelPricing | undefined;
        const prefix = `${provider}:`;

        for( const [ key, pricing ] of this.#prices.entries() )
        {
            if( !key.startsWith( prefix ) )
            {
                continue;
            }

            const modelKey = key.slice( prefix.length );

            if( modelKey === '*' )
            {
                continue;
            }

            if( !model.startsWith( modelKey ) )
            {
                continue;
            }

            const remainder = model.slice( modelKey.length );

            if( !isRecognizedModelSuffix( remainder ) )
            {
                continue;
            }

            if( !bestKey || modelKey.length > ( bestKey.slice( prefix.length ).length ) )
            {
                bestKey = key;
                bestPricing = pricing;
            }
        }

        if( bestPricing && bestKey )
        {
            return bestPricing.free 
                ? { status : 'free', pricing : bestPricing, key : bestKey }
                : { status : 'priced', pricing : bestPricing, key : bestKey };
        }

        // Bare-model fallback for callers that omit provider (legacy calculateSpend).
        const bare = this.get( model );

        if( bare )
        {
            return bare.free 
                ? { status : 'free', pricing : bare, key : model }
                : { status : 'priced', pricing : bare, key : model };
        }

        return { status : 'unpriced', reason : 'unknown_model' };
    }
}

export interface LocalPricingRegistryOptions
{
    initialPricing?    : Record<string, ModelPricing>
    updater?           : PricingUpdater
    refreshIntervalMs? : number
    autoStart?         : boolean
    onError?           : ( error: unknown ) => void
}

export class LocalPricingRegistry extends PricingRegistry
{
    #updater?           : PricingUpdater;
    #refreshTimer?      : NodeJS.Timeout;
    #refreshIntervalMs? : number;
    readonly #onError?  : ( error: unknown ) => void;

    constructor( options: LocalPricingRegistryOptions = {} )
    {
        super();

        if( options.initialPricing )
        {
            this.updateMany( options.initialPricing );
        }

        this.#updater = options.updater;
        this.#onError = options.onError;
        this.#refreshIntervalMs = options.refreshIntervalMs;

        if( options.autoStart && this.#refreshIntervalMs && this.#refreshIntervalMs > 0 )
        {
            this.startAutoRefresh( this.#refreshIntervalMs );
        }
    }

    public setUpstreamUpdater( updater: PricingUpdater ): void
    {
        this.#updater = updater;
    }

    public update( model: string, pricing: ModelPricing ): void
    {
        this.register( model, pricing );
    }

    public async refresh(): Promise<void>
    {
        if( !this.#updater ){return;}

        try
        {
            const updated = await this.#updater();

            if( updated )
            {
                this.updateMany( updated );
            }
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

    public startAutoRefresh( intervalMs?: number ): void
    {
        this.stopAutoRefresh();

        const ms = intervalMs ?? this.#refreshIntervalMs;

        if( !ms || ms <= 0 )
        {
            throw new Error( 'A positive refreshIntervalMs is required to start auto-refresh' );
        }

        this.#refreshIntervalMs = ms;

        this.#refreshTimer = setInterval( () => 
        {
            this.refresh().catch( ( err ) => 
            {
                if( this.#onError ){this.#onError( err );}
            } );
        }, ms );

        if( typeof this.#refreshTimer?.unref === 'function' )
        {
            this.#refreshTimer.unref();
        }
    }

    public stopAutoRefresh(): void
    {
        if( this.#refreshTimer )
        {
            clearInterval( this.#refreshTimer );
            this.#refreshTimer = undefined;
        }
    }
}

export const defaultPricingRegistry = new PricingRegistry();
