import type { UsageMetrics } from '../core/types.js';
import { type ModelPricing, PricingRegistry, defaultPricingRegistry } from './pricing.js';

export interface SpendDetails
{
    model            : string
    inputCost        : number
    outputCost       : number
    cacheReadCost?   : number
    cacheWriteCost?  : number
    reasoningCost?   : number
    totalCost        : number
    currency         : 'USD'
    usage            : UsageMetrics
}

export class SpendCalculator
{
    readonly #registry: PricingRegistry;

    constructor( registry: PricingRegistry = defaultPricingRegistry )
    {
        this.#registry = registry;
    }

    public calculate( 
        model: string, 
        usage: UsageMetrics, 
        customPricing?: ModelPricing 
    ): SpendDetails
    {
        const pricing = customPricing ?? this.#registry.get( model );

        if( !pricing )
        {
            return {
                model,
                inputCost  : 0,
                outputCost : 0,
                totalCost  : 0,
                currency   : 'USD',
                usage
            };
        }

        const cachedRead = usage.cachedPromptReadTokens ?? 0;
        const cachedWrite = usage.cachedPromptWriteTokens ?? 0;
        const reasoning = usage.reasoningTokens ?? 0;

        let uncachedPromptTokens = usage.promptTokens;

        // In OpenAI prompt_tokens includes cached_tokens in prompt_tokens_details
        if( usage.raw && typeof usage.raw === 'object' && 'prompt_tokens_details' in usage.raw )
        {
            uncachedPromptTokens = Math.max( 0, usage.promptTokens - cachedRead );
        }

        const inputCost = ( uncachedPromptTokens * pricing.inputPerMillion ) / 1_000_000;
        const outputCost = ( usage.completionTokens * pricing.outputPerMillion ) / 1_000_000;

        let cacheReadCost: number | undefined;

        if( cachedRead > 0 )
        {
            const rate = pricing.cacheReadPerMillion ?? ( pricing.inputPerMillion * 0.5 );
            cacheReadCost = ( cachedRead * rate ) / 1_000_000;
        }

        let cacheWriteCost: number | undefined;

        if( cachedWrite > 0 )
        {
            const rate = pricing.cacheWritePerMillion ?? ( pricing.inputPerMillion * 1.25 );
            cacheWriteCost = ( cachedWrite * rate ) / 1_000_000;
        }

        let reasoningCost: number | undefined;

        if( reasoning > 0 && pricing.reasoningPerMillion !== undefined )
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
            inputCost,
            outputCost,
            cacheReadCost,
            cacheWriteCost,
            reasoningCost,
            totalCost,
            currency : 'USD',
            usage
        };
    }
}

export const defaultSpendCalculator = new SpendCalculator();

export function calculateSpend( 
    model: string, 
    usage: UsageMetrics, 
    customPricing?: ModelPricing 
): SpendDetails
{
    return defaultSpendCalculator.calculate( model, usage, customPricing );
}
