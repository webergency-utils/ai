export interface ModelPricing
{
    inputPerMillion       : number
    outputPerMillion      : number
    cacheReadPerMillion?  : number
    cacheWritePerMillion? : number
    reasoningPerMillion?  : number
}

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
    readonly #prices = new Map<string, ModelPricing>();

    constructor()
    {
        for( const [ model, pricing ] of Object.entries( DEFAULT_PRICING ) )
        {
            this.#prices.set( model.toLowerCase(), pricing );
        }
    }

    public register( model: string, pricing: ModelPricing ): void
    {
        this.#prices.set( model.toLowerCase(), pricing );
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

export const defaultPricingRegistry = new PricingRegistry();
