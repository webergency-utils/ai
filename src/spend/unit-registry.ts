import { SpendCategory, StandardUnitType, CategorySpendInput } from './types.js';

export interface UnitCostRule
{
    category     : SpendCategory
    subcategory? : string
    unitType?    : StandardUnitType
    ratePerUnit  : number
    description? : string
}

export interface UnitCostChangeEvent
{
    key       : string
    previous? : number
    current   : number
}

export type UnitCostChangeListener = ( event: UnitCostChangeEvent ) => void;

export const DEFAULT_UNIT_PRICING: Record<string, number> = 
    {
        'storage:vector_query'     : 0.0001,
        'storage:vector_write'     : 0.00025,
        'storage:doc_read'         : 0.000005,
        'storage:doc_write'        : 0.00002,
        'storage:file_transfer_mb' : 0.00002,
        'storage:bytes'            : 0.00000000002,
        'compute:sandbox_sec'      : 0.00005,
        'compute:seconds'          : 0.00005,
        'compute:durationMs'       : 0.00000005,
        'network:bytes'            : 0.00000000009,
        'network:egress_mb'        : 0.00009,
        'mcp:call'                 : 0.0005,
        'tools:call'               : 0.0001
    };

export class UnitCostRegistry
{
    readonly #rates     = new Map<string, number>();
    readonly #listeners = new Set<UnitCostChangeListener>();

    constructor( initialRates?: Record<string, number> )
    {
        for( const [ key, rate ] of Object.entries( DEFAULT_UNIT_PRICING ) )
        {
            this.#rates.set( key.toLowerCase(), rate );
        }

        if( initialRates )
        {
            this.updateMany( initialRates );
        }
    }

    public on( event: 'change', listener: UnitCostChangeListener ): () => void
    {
        this.#listeners.add( listener );

        return () => this.off( event, listener );
    }

    public off( event: 'change', listener: UnitCostChangeListener ): void
    {
        this.#listeners.delete( listener );
    }

    public register( keyOrCategory: string, subcategoryOrRate: string | number, maybeRate?: number, unitType?: string ): void
    {
        let key: string;
        let rate: number;

        if( typeof subcategoryOrRate === 'number' )
        {
            key = keyOrCategory.toLowerCase();
            rate = subcategoryOrRate;
        }
        else
        {
            const cat = keyOrCategory.toLowerCase();
            const sub = subcategoryOrRate.toLowerCase();

            key = unitType ? `${cat}:${sub}:${unitType.toLowerCase()}` : `${cat}:${sub}`;
            rate = maybeRate ?? 0;
        }

        const prev = this.#rates.get( key );

        this.#rates.set( key, rate );

        if( prev !== rate )
        {
            for( const listener of this.#listeners )
            {
                listener( {
                    key,
                    previous : prev,
                    current  : rate
                } );
            }
        }
    }

    public registerRule( rule: UnitCostRule ): void
    {
        const cat = rule.category.toLowerCase();
        let key = cat;

        if( rule.subcategory && rule.unitType )
        {
            key = `${cat}:${rule.subcategory.toLowerCase()}:${rule.unitType.toLowerCase()}`;
        }
        else if( rule.subcategory )
        {
            key = `${cat}:${rule.subcategory.toLowerCase()}`;
        }
        else if( rule.unitType )
        {
            key = `${cat}:${rule.unitType.toLowerCase()}`;
        }

        this.register( key, rule.ratePerUnit );
    }

    public updateMany( rates: Record<string, number> | Map<string, number> ): void
    {
        const entries = rates instanceof Map ? rates.entries() : Object.entries( rates );

        for( const [ key, rate ] of entries )
        {
            this.register( key, rate );
        }
    }

    public get( key: string ): number | undefined
    {
        return this.#rates.get( key.toLowerCase() );
    }

    public getRate( category: SpendCategory, subcategory?: string, unitType?: string ): number | undefined
    {
        const cat = category.toLowerCase();
        const sub = subcategory?.toLowerCase();
        const unit = unitType?.toLowerCase();

        if( sub && unit )
        {
            const fullKey = `${cat}:${sub}:${unit}`;

            if( this.#rates.has( fullKey ) ){return this.#rates.get( fullKey );}
        }

        if( sub )
        {
            const subKey = `${cat}:${sub}`;

            if( this.#rates.has( subKey ) ){return this.#rates.get( subKey );}
        }

        if( unit )
        {
            const unitKey = `${cat}:${unit}`;

            if( this.#rates.has( unitKey ) ){return this.#rates.get( unitKey );}
        }

        if( this.#rates.has( cat ) )
        {
            return this.#rates.get( cat );
        }

        return undefined;
    }

    public resolveCost( entry: CategorySpendInput ): number
    {
        if( entry.costUSD !== undefined )
        {
            return entry.costUSD;
        }

        if( entry.units === undefined || entry.units <= 0 )
        {
            return 0;
        }

        const rate = this.getRate( entry.category, entry.subcategory, entry.unitType );

        if( rate !== undefined )
        {
            return rate * entry.units;
        }

        return 0;
    }

    public getAll(): Record<string, number>
    {
        const result: Record<string, number> = {};

        for( const [ key, rate ] of this.#rates.entries() )
        {
            result[ key ] = rate;
        }

        return result;
    }
}

export const defaultUnitCostRegistry = new UnitCostRegistry();
