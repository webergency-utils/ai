import type { UsageMetrics } from '../core/types.js';
import { BudgetExceededError } from '../core/error.js';
import type { WarningEvent } from '../core/warning.js';
import type { ModelPricing } from './pricing.js';
import { type SpendDetails, SpendCalculator, defaultSpendCalculator } from './calculator.js';
import 
{ 
    type SpendCategory, 
    type CategorySpendInput, 
    type CategorySpendRecord, 
    type CategorySpendBreakdown 
} from './types.js';
import { UnitCostRegistry, defaultUnitCostRegistry } from './unit-registry.js';

export interface SpendTrackerOptions
{
    maxBudgetUSD?        : number
    categoryBudgets?     : Partial<Record<SpendCategory, number>>
    warningThreshold?    : number
    calculator?          : SpendCalculator
    unitPricingRegistry? : UnitCostRegistry
}

export interface SpendWarningEvent extends WarningEvent
{
    code         : 'budget_threshold' | 'unpriced_usage' | 'budget_exceeded' | string
    category     : SpendCategory | 'total'
    currentSpend : number
    budgetLimit  : number
    threshold    : number
    percentage   : number
}

export type SpendWarningListener = ( event: SpendWarningEvent ) => void;

export interface CategorySpendOptions
{
    threadId? : string
    agentId?  : string
}

export class SpendTracker
{
    readonly #maxBudgetUSD?: number;
    readonly #categoryBudgets?: Partial<Record<SpendCategory, number>>;
    readonly #warningThreshold: number;
    readonly #calculator: SpendCalculator;
    readonly #unitRegistry: UnitCostRegistry;
    readonly #records: SpendDetails[] = [];
    readonly #categoryRecords: CategorySpendRecord[] = [];
    readonly #categorySpend = new Map<SpendCategory, number>();
    readonly #subTrackers = new Map<string, SpendTracker>();
    readonly #warningListeners = new Set<SpendWarningListener>();
    #totalSpendUSD = 0;

    constructor( options: SpendTrackerOptions = {} )
    {
        this.#maxBudgetUSD = options.maxBudgetUSD;
        this.#categoryBudgets = options.categoryBudgets;
        this.#warningThreshold = options.warningThreshold ?? 0.8;
        this.#calculator = options.calculator ?? defaultSpendCalculator;
        this.#unitRegistry = options.unitPricingRegistry ?? defaultUnitCostRegistry;
    }

    public get totalSpendUSD(): number
    {
        return this.#totalSpendUSD;
    }

    public get records(): SpendDetails[]
    {
        return [ ...this.#records ];
    }

    public get categoryRecords(): CategorySpendRecord[]
    {
        return [ ...this.#categoryRecords ];
    }

    public get categorySpend(): CategorySpendBreakdown
    {
        return {
            model   : this.#categorySpend.get( 'model' ) ?? 0,
            storage : this.#categorySpend.get( 'storage' ) ?? 0,
            compute : this.#categorySpend.get( 'compute' ) ?? 0,
            network : this.#categorySpend.get( 'network' ) ?? 0,
            mcp     : this.#categorySpend.get( 'mcp' ) ?? 0,
            tools   : this.#categorySpend.get( 'tools' ) ?? 0,
            custom  : this.#categorySpend.get( 'custom' ) ?? 0
        };
    }

    public getCategorySpend( category: SpendCategory ): number
    {
        return this.#categorySpend.get( category ) ?? 0;
    }

    public on( event: 'warning', listener: SpendWarningListener ): () => void
    {
        this.#warningListeners.add( listener );

        return () => this.off( event, listener );
    }

    public off( event: 'warning', listener: SpendWarningListener ): void
    {
        this.#warningListeners.delete( listener );
    }

    public record( 
        model: string, 
        usage: UsageMetrics, 
        customPricing?: ModelPricing 
    ): SpendDetails
    {
        const details = this.#calculator.calculate( model, usage, customPricing );
        const prevTotal = this.#totalSpendUSD;
        const newTotal = prevTotal + details.totalCost;
        const prevCat = this.#categorySpend.get( 'model' ) ?? 0;
        const newCat = prevCat + details.totalCost;

        this.#totalSpendUSD = newTotal;
        this.#categorySpend.set( 'model', newCat );
        this.#records.push( details );

        this.#checkWarningsAndLimits( prevTotal, newTotal, 'model', prevCat, newCat );

        return details;
    }

    public recordCategorySpend( 
        entry: CategorySpendInput, 
        options?: CategorySpendOptions 
    ): CategorySpendRecord
    {
        const costUSD = entry.costUSD !== undefined
            ? entry.costUSD
            : this.#unitRegistry.resolveCost( entry );

        const record: CategorySpendRecord = 
            {
                id          : `spend_${Date.now()}_${Math.random().toString( 36 ).slice( 2, 9 )}`,
                timestamp   : Date.now(),
                category    : entry.category,
                subcategory : entry.subcategory,
                costUSD,
                units       : entry.units,
                unitType    : entry.unitType,
                threadId    : options?.threadId,
                agentId     : options?.agentId,
                metadata    : entry.metadata
            };

        const prevTotal = this.#totalSpendUSD;
        const newTotal = prevTotal + costUSD;
        const prevCat = this.#categorySpend.get( entry.category ) ?? 0;
        const newCat = prevCat + costUSD;

        this.#totalSpendUSD = newTotal;
        this.#categorySpend.set( entry.category, newCat );
        this.#categoryRecords.push( record );

        this.#checkWarningsAndLimits( prevTotal, newTotal, entry.category, prevCat, newCat );

        return record;
    }

    public getThreadTracker( 
        threadId: string, 
        optionsOrMaxBudget?: number | Partial<SpendTrackerOptions> 
    ): SpendTracker
    {
        let tracker = this.#subTrackers.get( threadId );

        if( !tracker )
        {
            let opts: SpendTrackerOptions;

            if( typeof optionsOrMaxBudget === 'number' )
            {
                opts = 
                    {
                        maxBudgetUSD        : optionsOrMaxBudget,
                        categoryBudgets     : this.#categoryBudgets,
                        warningThreshold    : this.#warningThreshold,
                        calculator          : this.#calculator,
                        unitPricingRegistry : this.#unitRegistry
                    };
            }
            else
            {
                opts = 
                    {
                        maxBudgetUSD        : optionsOrMaxBudget?.maxBudgetUSD ?? this.#maxBudgetUSD,
                        categoryBudgets     : optionsOrMaxBudget?.categoryBudgets ?? this.#categoryBudgets,
                        warningThreshold    : optionsOrMaxBudget?.warningThreshold ?? this.#warningThreshold,
                        calculator          : optionsOrMaxBudget?.calculator ?? this.#calculator,
                        unitPricingRegistry : optionsOrMaxBudget?.unitPricingRegistry ?? this.#unitRegistry
                    };
            }

            tracker = new SpendTracker( opts );
            this.#subTrackers.set( threadId, tracker );
        }

        return tracker;
    }

    public reset(): void
    {
        this.#totalSpendUSD = 0;
        this.#records.length = 0;
        this.#categoryRecords.length = 0;
        this.#categorySpend.clear();
        this.#subTrackers.clear();
    }

    #emitWarning( event: SpendWarningEvent ): void
    {
        for( const listener of this.#warningListeners )
        {
            listener( event );
        }
    }

    #checkWarningsAndLimits( 
        prevTotal: number, 
        newTotal: number, 
        category: SpendCategory, 
        prevCat: number, 
        newCat: number 
    ): void
    {
        const catLimit = this.#categoryBudgets?.[ category ];

        if( catLimit !== undefined && catLimit > 0 )
        {
            const warnCap = catLimit * this.#warningThreshold;

            if( prevCat < warnCap && newCat >= warnCap )
            {
                this.#emitWarning( {
                    code         : 'budget_threshold',
                    message      : `Category '${category}' spend reached ${this.#warningThreshold * 100}% of its budget`,
                    category,
                    currentSpend : newCat,
                    budgetLimit  : catLimit,
                    threshold    : this.#warningThreshold,
                    percentage   : ( newCat / catLimit ) * 100
                } );
            }

            if( newCat > catLimit )
            {
                throw new BudgetExceededError( newCat, catLimit, category );
            }
        }

        if( this.#maxBudgetUSD !== undefined && this.#maxBudgetUSD > 0 )
        {
            const warnCap = this.#maxBudgetUSD * this.#warningThreshold;

            if( prevTotal < warnCap && newTotal >= warnCap )
            {
                this.#emitWarning( {
                    code         : 'budget_threshold',
                    message      : `Total spend reached ${this.#warningThreshold * 100}% of its budget`,
                    category     : 'total',
                    currentSpend : newTotal,
                    budgetLimit  : this.#maxBudgetUSD,
                    threshold    : this.#warningThreshold,
                    percentage   : ( newTotal / this.#maxBudgetUSD ) * 100
                } );
            }

            if( newTotal > this.#maxBudgetUSD )
            {
                throw new BudgetExceededError( newTotal, this.#maxBudgetUSD );
            }
        }
    }
}
