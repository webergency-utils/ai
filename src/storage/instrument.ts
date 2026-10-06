import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import type { CategorySpendInput } from '../spend/types.js';

export type StorageKind = 'doc' | 'vector' | 'cache' | 'file';

export interface StorageInstrumentOptions
{
    tracker?        : SpendTracker
    storagePricing? : UnitCostRegistry
}

/**
 * Shared span + spend wrapper used by every storage implementation.
 * Spans are named `storage:<kind>:<op>`; spend is attributed to the per-call context when present, otherwise to the store tracker.
 */
export class StorageInstrument
{
    readonly #kind            : StorageKind;
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( kind: StorageKind, options: StorageInstrumentOptions = {} )
    {
        this.#kind = kind;
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    /** Runs `fn` inside a `storage:<kind>:<op>` span when the context supports spans. `fn` receives the context spend must go to. */
    public async run<T>(
        op: string,
        context: ExecutionContext | undefined,
        attributes: Record<string, string | number | boolean> | undefined,
        fn: ( ctx?: ExecutionContext ) => Promise<T>
    ): Promise<T>
    {
        if( !context?.withSpan ){return fn( context );}

        return context.withSpan(
            `storage:${this.#kind}:${op}`,
            async ( span, childCtx ) =>
            {
                for( const [ k, v ] of Object.entries( attributes ?? {} ) )
                {
                    span.setAttribute( `storage.${k}`, v );
                }

                return fn( childCtx );
            },
            { kind : 'storage' }
        );
    }

    /** Reports one `storage` spend entry, resolving the cost from the pricing registry when configured. */
    public spend( subcategory: string, units: number, unitType: string, context?: ExecutionContext ): void
    {
        const entry: CategorySpendInput = { category : 'storage', subcategory, units, unitType };

        if( this.#storagePricing )
        {
            const resolved = this.#storagePricing.resolveCost( entry );

            if( resolved > 0 )
            {
                entry.costUSD = resolved;
            }
        }

        if( context ){context.reportSpend( entry );}
        else if( this.#tracker ){this.#tracker.recordCategorySpend( entry );}
    }
}
