import type { CategorySpendBreakdown, CategorySpendInput } from '../spend/types.js';
import type { 
    Span, 
    SpanAttributeValue, 
    SpanErrorDetails, 
    SpanKind, 
    SpanMetrics, 
    SpanOptions, 
    SpanRollup, 
    SpanStatus, 
    SerializedSpan 
} from './types.js';
import { generateSpanId, generateTraceId } from './id.js';

export interface SpanImplOptions extends SpanOptions
{
    id?      : string
    traceId? : string
    status?  : SpanStatus
}

export class SpanImpl implements Span
{
    public readonly id            : string;
    public readonly traceId       : string;
    public parentSpanId?          : string;
    public readonly name          : string;
    public readonly kind          : SpanKind;
    public readonly startTime     : number;
    public endTime?               : number;
    public durationMs?            : number;
    public status                 : SpanStatus;
    public errorDetails?          : SpanErrorDetails;
    public readonly attributes    : Record<string, SpanAttributeValue>;
    public readonly metrics       : SpanMetrics;
    public spendUSD               : number;
    public readonly categorySpend : CategorySpendBreakdown;
    public readonly children      : Span[];
    public rollup?                : SpanRollup;

    constructor( name: string, options: SpanImplOptions = {} )
    {
        this.name = name;
        this.id = options.id ?? generateSpanId();
        this.traceId = options.traceId ?? generateTraceId();
        this.parentSpanId = options.parentSpanId;
        this.kind = options.kind ?? 'custom';
        this.startTime = options.startTime ?? Date.now();
        this.status = options.status ?? 'ok';
        this.attributes = { ...( options.attributes ?? {} ) };
        this.metrics = { ...( options.metrics ?? {} ) };
        this.spendUSD = 0;
        this.categorySpend = 
        {
            model   : 0,
            storage : 0,
            compute : 0,
            network : 0,
            mcp     : 0,
            tools   : 0,
            custom  : 0
        };
        this.children = [];
    }

    public setAttribute( key: string, value: SpanAttributeValue ): void
    {
        this.attributes[key] = value;
    }

    public setAttributes( attributes: Record<string, SpanAttributeValue> ): void
    {
        Object.assign( this.attributes, attributes );
    }

    public recordMetric( key: string, value: number ): void
    {
        this.metrics[key] = ( this.metrics[key] ?? 0 ) + value;
    }

    public addMetrics( metrics: Partial<SpanMetrics> ): void
    {
        for( const [ k, v ] of Object.entries( metrics ) )
        {
            if( v !== undefined )
            {
                this.metrics[k] = ( this.metrics[k] ?? 0 ) + v;
            }
        }
    }

    public recordSpend( entry: CategorySpendInput ): void
    {
        const cost = entry.costUSD ?? 0;
        this.spendUSD += cost;
        this.categorySpend[entry.category] += cost;

        if( entry.units !== undefined && entry.unitType )
        {
            this.recordMetric( entry.unitType, entry.units );
        }
    }

    public addChild( child: Span ): void
    {
        if( 'parentSpanId' in child && !child.parentSpanId )
        {
            ( child as { parentSpanId?: string } ).parentSpanId = this.id;
        }

        this.children.push( child );
    }

    public end( endTime?: number ): void
    {
        this.endTime = endTime ?? Date.now();
        this.durationMs = Math.max( 0, this.endTime - this.startTime );
    }

    public toJSON(): SerializedSpan
    {
        return {
            id            : this.id,
            traceId       : this.traceId,
            parentSpanId  : this.parentSpanId,
            name          : this.name,
            kind          : this.kind,
            startTime     : this.startTime,
            endTime       : this.endTime,
            durationMs    : this.durationMs,
            status        : this.status,
            errorDetails  : this.errorDetails,
            attributes    : { ...this.attributes },
            metrics       : { ...this.metrics },
            spendUSD      : this.spendUSD,
            categorySpend : { ...this.categorySpend },
            children      : this.children.map( ( c ) => {return c.toJSON();} ),
            rollup        : this.rollup ? structuredClone( this.rollup ) : undefined
        };
    }

    public static fromSerialized( data: SerializedSpan ): SpanImpl
    {
        const span = new SpanImpl( data.name, 
            {
                id           : data.id,
                traceId      : data.traceId,
                parentSpanId : data.parentSpanId,
                kind         : data.kind,
                startTime    : data.startTime,
                status       : data.status,
                attributes   : data.attributes,
                metrics      : data.metrics
            } );

        span.endTime = data.endTime;
        span.durationMs = data.durationMs;
        span.errorDetails = data.errorDetails;
        span.spendUSD = data.spendUSD;
        Object.assign( span.categorySpend, data.categorySpend );

        if( data.rollup )
        {
            span.rollup = structuredClone( data.rollup );
        }

        if( Array.isArray( data.children ) )
        {
            for( const childData of data.children )
            {
                span.addChild( SpanImpl.fromSerialized( childData ) );
            }
        }

        return span;
    }
}
