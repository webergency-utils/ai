import type { UsageMetrics } from '../core/types.js';
import { 
    type ModelPricing, 
    type PricingIdentity, 
    type PricingResolution,
    PricingRegistry, 
    defaultPricingRegistry 
} from './pricing.js';

export interface SpendDetails
{
    model            : string
    provider?        : string
    inputCost        : number
    outputCost       : number
    cacheReadCost?   : number
    cacheWriteCost?  : number
    reasoningCost?   : number
    totalCost        : number
    currency         : 'USD'
    usage            : UsageMetrics
    unpriced?        : true
    free?            : true
    pricingKey?      : string
    gaps?            : string[]
}

export interface CalculateSpendOptions
{
    provider?      : string
    baseUrl?       : string
    customPricing? : ModelPricing
    /**
     * Service tier / residency multipliers are not priced — recorded as gaps (R52).
     */
    serviceTier?   : Array<'batch' | 'flex' | 'priority' | 'data_residency' | string>
}

export interface NormalizedUsage
{
    uncachedPromptTokens : number
    cachedReadTokens     : number
    cachedWriteTokens    : number
    cachedWrite1hTokens  : number
    outputTokens         : number
    /** Extra billable output (e.g. Gemini thoughts) not already in completionTokens */
    extraOutputTokens    : number
}

export function normalizeUsage( usage: UsageMetrics, provider?: string ): NormalizedUsage
{
    const raw = ( usage.raw && typeof usage.raw === 'object' ) 
        ? usage.raw as Record<string, unknown> 
        : undefined;
    const cachedRead = usage.cachedPromptReadTokens ?? 0;
    const cachedWrite = usage.cachedPromptWriteTokens ?? 0;

    let cachedWrite1h = 0;

    if( raw )
    {
        const creation = raw.cache_creation as Record<string, unknown> | undefined;
        const ephemeral1h = Number( 
            creation?.ephemeral_1h_input_tokens 
            ?? raw.cache_creation_ephemeral_1h_tokens 
            ?? 0 
        );

        if( Number.isFinite( ephemeral1h ) && ephemeral1h > 0 )
        {
            cachedWrite1h = ephemeral1h;
        }
    }

    let uncachedPromptTokens = usage.promptTokens;

    // OpenAI / DeepSeek: prompt_tokens includes cached_tokens.
    const promptIncludesCache = Boolean( 
        raw && ( 'prompt_tokens_details' in raw || provider === 'openai' || provider === 'deepseek' || provider === 'groq' )
    );

    // Gemini: promptTokenCount typically includes cachedContentTokenCount.
    const geminiIncludesCache = Boolean( 
        raw && ( 'cachedContentTokenCount' in raw || provider === 'gemini' ) 
        && cachedRead > 0 
    );

    if( ( promptIncludesCache || geminiIncludesCache ) && cachedRead > 0 )
    {
        uncachedPromptTokens = Math.max( 0, usage.promptTokens - cachedRead );
    }

    let extraOutputTokens = 0;
    const thoughts = Number( raw?.thoughtsTokenCount ?? 0 );

    if( Number.isFinite( thoughts ) && thoughts > 0 )
    {
        // Gemini thoughts are separate from candidatesTokenCount (R27).
        extraOutputTokens = thoughts;
    }

    return {
        uncachedPromptTokens,
        cachedReadTokens    : cachedRead,
        cachedWriteTokens   : Math.max( 0, cachedWrite - cachedWrite1h ),
        cachedWrite1hTokens : cachedWrite1h,
        outputTokens        : usage.completionTokens,
        extraOutputTokens
    };
}

function selectTierRates( 
    pricing: ModelPricing, 
    promptTokens: number 
): Pick<ModelPricing, 'inputPerMillion' | 'outputPerMillion' | 'cacheReadPerMillion' | 'cacheWritePerMillion'>
{
    if( !pricing.tiers || pricing.tiers.length === 0 )
    {
        return pricing;
    }

    const sorted = [ ...pricing.tiers ].sort( ( a, b ) => 
    {
        const au = a.upToPromptTokens ?? Number.POSITIVE_INFINITY;
        const bu = b.upToPromptTokens ?? Number.POSITIVE_INFINITY;

        return au - bu;
    } );

    for( const tier of sorted )
    {
        const upTo = tier.upToPromptTokens;

        if( upTo === null || promptTokens <= upTo )
        {
            return {
                inputPerMillion      : tier.inputPerMillion,
                outputPerMillion     : tier.outputPerMillion,
                cacheReadPerMillion  : tier.cacheReadPerMillion ?? pricing.cacheReadPerMillion,
                cacheWritePerMillion : tier.cacheWritePerMillion ?? pricing.cacheWritePerMillion
            };
        }
    }

    return pricing;
}

export class SpendCalculator
{
    readonly #registry: PricingRegistry;

    constructor( registry: PricingRegistry = defaultPricingRegistry )
    {
        this.#registry = registry;
    }

    public get registry(): PricingRegistry
    {
        return this.#registry;
    }

    public resolvePricing( identity: PricingIdentity ): PricingResolution
    {
        return this.#registry.resolve( identity );
    }

    public calculate( 
        model: string, 
        usage: UsageMetrics, 
        customPricing?: ModelPricing,
        options?: CalculateSpendOptions 
    ): SpendDetails
    {
        const provider = options?.provider;
        const gaps: string[] = [];

        if( options?.serviceTier )
        {
            for( const tier of options.serviceTier )
            {
                gaps.push( `unpriced_service_tier:${tier}` );
            }
        }

        if( customPricing )
        {
            return this.#bill( model, usage, customPricing, {
                provider,
                pricingKey : 'custom',
                gaps
            } );
        }

        const resolution = this.#registry.resolve( {
            provider : provider ?? 'unknown',
            model,
            baseUrl  : options?.baseUrl
        } );

        if( resolution.status === 'unpriced' )
        {
            return {
                model,
                provider,
                inputCost  : 0,
                outputCost : 0,
                totalCost  : 0,
                currency   : 'USD',
                usage,
                unpriced   : true,
                gaps       : gaps.length > 0 ? gaps : undefined
            };
        }

        if( resolution.status === 'free' )
        {
            return {
                model,
                provider,
                inputCost  : 0,
                outputCost : 0,
                totalCost  : 0,
                currency   : 'USD',
                usage,
                free       : true,
                pricingKey : resolution.key,
                gaps       : gaps.length > 0 ? gaps : undefined
            };
        }

        return this.#bill( model, usage, resolution.pricing, {
            provider,
            pricingKey : resolution.key,
            gaps
        } );
    }

    #bill( 
        model: string, 
        usage: UsageMetrics, 
        pricing: ModelPricing,
        meta: { provider?: string, pricingKey?: string, gaps: string[] }
    ): SpendDetails
    {
        const normalized = normalizeUsage( usage, meta.provider ?? pricing.provider );
        const rates = selectTierRates( 
            pricing, 
            normalized.uncachedPromptTokens + normalized.cachedReadTokens 
        );

        const inputCost = ( normalized.uncachedPromptTokens * rates.inputPerMillion ) / 1_000_000;
        const billableOutput = normalized.outputTokens + normalized.extraOutputTokens;
        const outputCost = ( billableOutput * rates.outputPerMillion ) / 1_000_000;

        let cacheReadCost: number | undefined;

        if( normalized.cachedReadTokens > 0 )
        {
            const rate = rates.cacheReadPerMillion ?? ( rates.inputPerMillion * 0.5 );
            cacheReadCost = ( normalized.cachedReadTokens * rate ) / 1_000_000;
        }

        let cacheWriteCost: number | undefined;
        const write5mRate = pricing.cacheWrite5mPerMillion 
            ?? pricing.cacheWritePerMillion 
            ?? ( rates.inputPerMillion * 1.25 );
        const write1hRate = pricing.cacheWrite1hPerMillion ?? ( rates.inputPerMillion * 2 );

        if( normalized.cachedWriteTokens > 0 || normalized.cachedWrite1hTokens > 0 )
        {
            cacheWriteCost = 
                ( ( normalized.cachedWriteTokens * write5mRate ) / 1_000_000 )
                + ( ( normalized.cachedWrite1hTokens * write1hRate ) / 1_000_000 );
        }

        // OpenAI/DeepSeek reasoning tokens are already inside completionTokens — do not add again (R27).
        let reasoningCost: number | undefined;
        const reasoning = usage.reasoningTokens ?? 0;
        const reasoningIncludedInCompletion = Boolean( 
            usage.raw 
            && typeof usage.raw === 'object' 
            && 'completion_tokens_details' in ( usage.raw as object ) 
        );

        if( 
            reasoning > 0 
            && pricing.reasoningPerMillion !== undefined 
            && !reasoningIncludedInCompletion 
            && normalized.extraOutputTokens === 0 
        )
        {
            reasoningCost = ( reasoning * pricing.reasoningPerMillion ) / 1_000_000;
        }

        const totalCost = inputCost + 
            outputCost + 
            ( cacheReadCost ?? 0 ) + 
            ( cacheWriteCost ?? 0 ) + 
            ( reasoningCost ?? 0 );

        return {
            model,
            provider   : meta.provider ?? pricing.provider,
            inputCost,
            outputCost,
            cacheReadCost,
            cacheWriteCost,
            reasoningCost,
            totalCost,
            currency   : 'USD',
            usage,
            pricingKey : meta.pricingKey,
            gaps       : meta.gaps.length > 0 ? meta.gaps : undefined
        };
    }
}

export const defaultSpendCalculator = new SpendCalculator();

export function calculateSpend( 
    model: string, 
    usage: UsageMetrics, 
    customPricing?: ModelPricing,
    options?: CalculateSpendOptions 
): SpendDetails
{
    return defaultSpendCalculator.calculate( model, usage, customPricing, options );
}
