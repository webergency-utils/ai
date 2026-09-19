import type { UsageMetrics } from '../core/types.js';
import { BudgetExceededError } from '../core/error.js';
import type { ModelPricing } from './pricing.js';
import { type SpendDetails, SpendCalculator, defaultSpendCalculator } from './calculator.js';

export interface SpendTrackerOptions
{
    maxBudgetUSD? : number
    calculator?   : SpendCalculator
}

export class SpendTracker
{
    readonly #maxBudgetUSD?: number;
    readonly #calculator: SpendCalculator;
    readonly #records: SpendDetails[] = [];
    readonly #subTrackers = new Map<string, SpendTracker>();
    #totalSpendUSD = 0;

    constructor( options: SpendTrackerOptions = {} )
    {
        this.#maxBudgetUSD = options.maxBudgetUSD;
        this.#calculator = options.calculator ?? defaultSpendCalculator;
    }

    public get totalSpendUSD(): number
    {
        return this.#totalSpendUSD;
    }

    public get records(): SpendDetails[]
    {
        return [ ...this.#records ];
    }

    public record( 
        model: string, 
        usage: UsageMetrics, 
        customPricing?: ModelPricing 
    ): SpendDetails
    {
        const details = this.#calculator.calculate( model, usage, customPricing );
        this.#totalSpendUSD += details.totalCost;
        this.#records.push( details );

        if( this.#maxBudgetUSD !== undefined && this.#totalSpendUSD > this.#maxBudgetUSD )
        {
            throw new BudgetExceededError( this.#totalSpendUSD, this.#maxBudgetUSD );
        }

        return details;
    }

    public getThreadTracker( threadId: string, maxBudgetUSD?: number ): SpendTracker
    {
        let tracker = this.#subTrackers.get( threadId );

        if( !tracker )
        {
            tracker = new SpendTracker( 
                {
                    maxBudgetUSD : maxBudgetUSD ?? this.#maxBudgetUSD,
                    calculator   : this.#calculator
                } );
            this.#subTrackers.set( threadId, tracker );
        }

        return tracker;
    }

    public reset(): void
    {
        this.#totalSpendUSD = 0;
        this.#records.length = 0;
        this.#subTrackers.clear();
    }
}
