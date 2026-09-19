export interface ModelPricing
{
    inputPerMillion       : number
    outputPerMillion      : number
    cacheReadPerMillion?  : number
    cacheWritePerMillion? : number
    reasoningPerMillion?  : number
}

export interface PricingChangeEvent
{
    model     : string
    previous? : ModelPricing
    current   : ModelPricing
}

export type PricingChangeListener = ( event: PricingChangeEvent ) => void;

export type PricingUpdater = () => Promise<Record<string, ModelPricing>> | Record<string, ModelPricing>;

export const DEFAULT_PRICING: Record<string, ModelPricing> = 
    {
    // OpenAI Models
        'gpt-4o' : 
    {
        inputPerMillion     : 2.50,
        outputPerMillion    : 10.00,
        cacheReadPerMillion : 1.25
    },
        'gpt-4o-mini' : 
    {
        inputPerMillion     : 0.15,
        outputPerMillion    : 0.60,
        cacheReadPerMillion : 0.075
    },
        'o1' : 
    {
        inputPerMillion     : 15.00,
        outputPerMillion    : 60.00,
        cacheReadPerMillion : 7.50
    },
        'o3-mini' : 
    {
        inputPerMillion     : 1.10,
        outputPerMillion    : 4.40,
        cacheReadPerMillion : 0.55
    },

        // Anthropic Models
        'claude-3-7-sonnet-20250219' : 
    {
        inputPerMillion      : 3.00,
        outputPerMillion     : 15.00,
        cacheReadPerMillion  : 0.30,
        cacheWritePerMillion : 3.75
    },
        'claude-3-5-sonnet-20241022' : 
    {
        inputPerMillion      : 3.00,
        outputPerMillion     : 15.00,
        cacheReadPerMillion  : 0.30,
        cacheWritePerMillion : 3.75
    },
        'claude-3-5-haiku-20241022' : 
    {
        inputPerMillion      : 0.80,
        outputPerMillion     : 4.00,
        cacheReadPerMillion  : 0.08,
        cacheWritePerMillion : 1.00
    },
        'claude-3-opus-20240229' : 
    {
        inputPerMillion      : 15.00,
        outputPerMillion     : 75.00,
        cacheReadPerMillion  : 1.50,
        cacheWritePerMillion : 18.75
    },

        // Gemini Models
        'gemini-2.5-flash' : 
    {
        inputPerMillion     : 0.075,
        outputPerMillion    : 0.30,
        cacheReadPerMillion : 0.01875
    },
        'gemini-2.5-pro' : 
    {
        inputPerMillion     : 1.25,
        outputPerMillion    : 5.00,
        cacheReadPerMillion : 0.3125
    },
        'gemini-2.0-flash' : 
    {
        inputPerMillion     : 0.10,
        outputPerMillion    : 0.40,
        cacheReadPerMillion : 0.025
    },

        // DeepSeek Models
        'deepseek-chat' : 
    {
        inputPerMillion     : 0.14,
        outputPerMillion    : 0.28,
        cacheReadPerMillion : 0.014
    },
        'deepseek-reasoner' : 
    {
        inputPerMillion     : 0.55,
        outputPerMillion    : 2.19,
        cacheReadPerMillion : 0.14
    },

        // Groq Models
        'llama-3.3-70b-versatile' : 
    {
        inputPerMillion  : 0.59,
        outputPerMillion : 0.79
    }
    };

export class PricingRegistry
{
    readonly #prices    = new Map<string, ModelPricing>();
    readonly #listeners = new Set<PricingChangeListener>();

    constructor()
    {
        for( const [ model, pricing ] of Object.entries( DEFAULT_PRICING ) )
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
            || prev.reasoningPerMillion !== pricing.reasoningPerMillion;

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

    public get( model: string ): ModelPricing | undefined
    {
        const norm = model.toLowerCase();

        if( this.#prices.has( norm ) )
        {
            return this.#prices.get( norm );
        }

        // Prefix/family match (e.g. 'claude-3-7-sonnet' matches 'claude-3-7-sonnet-20250219')
        for( const [ key, pricing ] of this.#prices.entries() )
        {
            if( norm.startsWith( key ) || key.startsWith( norm ) )
            {
                return pricing;
            }
        }

        return undefined;
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
