import type { 
    Span, 
    SpanAttributeValue, 
    SpanKind, 
    Trace, 
    SerializedTrace,
    TraceWarningEvent
} from './types.js';

export interface OTLPAnyValue
{
    stringValue? : string
    boolValue?   : boolean
    intValue?    : string
    doubleValue? : number
    arrayValue?  : { values: OTLPAnyValue[] }
    kvlistValue? : { values: OTLPKeyValue[] }
}

export interface OTLPKeyValue
{
    key   : string
    value : OTLPAnyValue
}

export interface OTLPStatus
{
    code     : number
    message? : string
}

export interface OTLPEvent
{
    timeUnixNano : string
    name         : string
    attributes   : OTLPKeyValue[]
}

export interface OTLPSpan
{
    traceId           : string
    spanId            : string
    parentSpanId?     : string
    traceState?       : string
    /** W3C trace flags plus OTLP parent-is-remote bits (0x100 = known, 0x200 = remote). */
    flags?            : number
    name              : string
    kind              : number
    startTimeUnixNano : string
    endTimeUnixNano   : string
    attributes        : OTLPKeyValue[]
    events?           : OTLPEvent[]
    status            : OTLPStatus
}

export interface OTLPScopeSpans
{
    scope : {
        name     : string
        version? : string
    }
    spans : OTLPSpan[]
}

export interface OTLPResourceSpans
{
    resource : {
        attributes : OTLPKeyValue[]
    }
    scopeSpans : OTLPScopeSpans[]
}

export interface OTLPExportTraceServiceRequest
{
    resourceSpans : OTLPResourceSpans[]
}

export interface OTLPExportOptions
{
    serviceName?        : string
    serviceVersion?     : string
    /** Extra resource attributes; `service.name` / `service.version` always come from the dedicated options. */
    resourceAttributes? : Record<string, SpanAttributeValue>
    /** Receives encoding warnings (`TRACE_ATTRIBUTE_INVALID`). Without it they are dropped. */
    onWarning?          : ( event: TraceWarningEvent ) => void
    /** Clock used to close unfinished spans; defaults to the trace end time, then `Date.now()`. */
    now?                : () => number
}

/** Max characters of `exception.stacktrace` placed on an exception event. */
export const MAX_STACKTRACE_CHARS = 4096;

export interface JSONExportOptions
{
    pretty? : boolean
}

/**
 * Exports a Trace tree to a plain JSON string.
 */
export function exportTraceToJSON( trace: Trace, options: JSONExportOptions = {} ): string
{
    const serialized: SerializedTrace = 
        {
            traceId       : trace.traceId,
            threadId      : trace.threadId,
            agentId       : trace.agentId,
            startTime     : trace.startTime,
            endTime       : trace.endTime,
            durationMs    : trace.durationMs,
            rootSpan      : trace.rootSpan.toJSON(),
            totalSpendUSD : trace.totalSpendUSD,
            categorySpend : trace.categorySpend
        };

    return JSON.stringify( serialized, null, options.pretty ? 2 : undefined );
}

/**
 * Maps a generic span kind to OpenTelemetry SpanKind enum values:
 * 0 = UNSPECIFIED, 1 = INTERNAL, 2 = SERVER, 3 = CLIENT, 4 = PRODUCER, 5 = CONSUMER
 */
function mapSpanKindToOTLP( kind: SpanKind ): number
{
    switch ( kind )
    {
        case 'agent':
        case 'tool':
        case 'custom':
            return 1; // SPAN_KIND_INTERNAL

        case 'model':
        case 'storage':
        case 'mcp':
            return 3; // SPAN_KIND_CLIENT

        default:
            return 1; // SPAN_KIND_INTERNAL
    }
}

interface EncodeContext
{
    traceId : string
    now     : number
    warn    : ( spanName: string, key: string, value: unknown ) => void
}

/**
 * Converts an attribute to an OTLP typed AnyValue.
 * Returns `undefined` for values that cannot be represented (non-finite numbers), never `NaN`/`Infinity`,
 * which `JSON.stringify` would turn into `null` and produce an invalid OTLP value.
 */
function toOTLPAnyValue( value: SpanAttributeValue ): OTLPAnyValue | undefined
{
    if( typeof value === 'string' )
    {
        return { stringValue : value };
    }

    if( typeof value === 'boolean' )
    {
        return { boolValue : value };
    }

    if( typeof value === 'number' )
    {
        if( !Number.isFinite( value ) ){return undefined;}

        if( Number.isSafeInteger( value ) )
        {
            return { intValue : value.toString() };
        }

        return { doubleValue : value };
    }

    if( Array.isArray( value ) )
    {
        const values: OTLPAnyValue[] = [];

        for( const item of value )
        {
            const converted = toOTLPAnyValue( item );

            if( !converted ){return undefined;}

            values.push( converted );
        }

        return { arrayValue : { values } };
    }

    return { stringValue : String( value ) };
}

/** Epoch milliseconds (possibly fractional) to a nanosecond decimal string. */
function toUnixNano( ms: number ): string
{
    const whole = Math.floor( ms );
    const frac = Math.round( ( ms - whole ) * 1_000_000 );

    return ( BigInt( whole ) * 1_000_000n + BigInt( frac ) ).toString();
}

function pushAttribute( out: OTLPKeyValue[], span: Span, key: string, value: unknown, ctx: EncodeContext ): void
{
    const converted = toOTLPAnyValue( value as SpanAttributeValue );

    if( !converted )
    {
        ctx.warn( span.name, key, value );

        return;
    }

    out.push( { key, value : converted } );
}

function encodeAttributes( span: Span, attributes: Record<string, SpanAttributeValue>, ctx: EncodeContext ): OTLPKeyValue[]
{
    const out: OTLPKeyValue[] = [];

    for( const [ k, v ] of Object.entries( attributes ) )
    {
        pushAttribute( out, span, k, v, ctx );
    }

    return out;
}

function encodeSpan( span: Span, ctx: EncodeContext ): OTLPSpan
{
    const startMs = Number.isFinite( span.startTime ) ? span.startTime : ctx.now;
    const unfinished = span.endTime === undefined;
    const rawEnd = span.endTime !== undefined && Number.isFinite( span.endTime ) ? span.endTime : Math.max( ctx.now, startMs );
    const endMs = Math.max( rawEnd, startMs );

    const attributes = encodeAttributes( span, span.attributes, ctx );
    const addMissing = ( key: string, value: OTLPAnyValue ): void => 
    {
        if( !attributes.some( ( a ) => {return a.key === key;} ) )
        {
            attributes.push( { key, value } );
        }
    };

    if( unfinished )
    {
        addMissing( 'trace.span.unfinished', { boolValue : true } );
    }

    if( span.spendUSD > 0 )
    {
        // Spend is always a decimal amount; keep it a double even for whole-dollar values.
        if( Number.isFinite( span.spendUSD ) )
        {
            attributes.push( { key : 'spend.usd', value : { doubleValue : span.spendUSD } } );
        }
        else
        {
            ctx.warn( span.name, 'spend.usd', span.spendUSD );
        }
    }

    for( const [ k, v ] of Object.entries( span.metrics ) )
    {
        if( v === undefined ){continue;}

        if( typeof v !== 'number' )
        {
            ctx.warn( span.name, `metrics.${k}`, v );
            continue;
        }

        pushAttribute( attributes, span, `metrics.${k}`, v, ctx );
    }

    const isError = span.status === 'error' || unfinished;
    const events: OTLPEvent[] = [];

    for( const event of span.events ?? [] )
    {
        events.push( {
            timeUnixNano : toUnixNano( Number.isFinite( event.time ) ? event.time : startMs ),
            name         : event.name,
            attributes   : event.attributes ? encodeAttributes( span, event.attributes, ctx ) : []
        } );
    }

    let message: string | undefined;

    if( span.status === 'error' )
    {
        const details = span.errorDetails;
        const errorType = details?.name ?? 'Error';

        message = details?.message;
        addMissing( 'error.type', { stringValue : errorType } );

        const exceptionAttributes: OTLPKeyValue[] = 
            [
                { key : 'exception.type', value : { stringValue : errorType } },
                { key : 'exception.message', value : { stringValue : details?.message ?? '' } }
            ];

        if( details?.stack )
        {
            exceptionAttributes.push( { key : 'exception.stacktrace', value : { stringValue : details.stack.slice( 0, MAX_STACKTRACE_CHARS ) } } );
        }

        events.push( {
            timeUnixNano : toUnixNano( endMs ),
            name         : 'exception',
            attributes   : exceptionAttributes
        } );
    }
    else if( unfinished )
    {
        message = 'unfinished';
        addMissing( 'error.type', { stringValue : 'unfinished' } );
    }

    const otlpSpan: OTLPSpan = 
        {
            traceId           : ctx.traceId,
            spanId            : span.id,
            ...( span.parentSpanId ? { parentSpanId : span.parentSpanId } : {} ),
            flags             : 0x101,
            name              : span.name,
            kind              : mapSpanKindToOTLP( span.kind ),
            startTimeUnixNano : toUnixNano( startMs ),
            endTimeUnixNano   : toUnixNano( endMs ),
            attributes,
            ...( events.length > 0 ? { events } : {} ),
            status : 
            {
                code : isError ? 2 : 1, // 1 = OK, 2 = ERROR
                ...( message !== undefined ? { message } : {} )
            }
        };

    return otlpSpan;
}

/**
 * Recursively flattens a span tree into a flat array of OTLPSpan structures (parents before children).
 */
function flattenSpansToOTLP( span: Span, out: OTLPSpan[], ctx: EncodeContext ): void
{
    out.push( encodeSpan( span, ctx ) );

    for( const child of span.children )
    {
        flattenSpansToOTLP( child, out, ctx );
    }
}

function resourceAttributes( options: OTLPExportOptions ): OTLPKeyValue[]
{
    const serviceName = options.serviceName ?? '@webergency-utils/ai';
    const serviceVersion = options.serviceVersion ?? '0.1.0';
    const out: OTLPKeyValue[] = 
        [
            { key : 'service.name', value : { stringValue : serviceName } },
            { key : 'service.version', value : { stringValue : serviceVersion } }
        ];

    for( const [ k, v ] of Object.entries( options.resourceAttributes ?? {} ) )
    {
        if( k === 'service.name' || k === 'service.version' ){continue;}

        const converted = toOTLPAnyValue( v );

        if( converted )
        {
            out.push( { key : k, value : converted } );
        }
    }

    return out;
}

/**
 * Exports several completed Traces under one resource (one `resourceSpans` entry, one scope).
 * Used by batching transports; spans of every trace keep their own `traceId`.
 */
export function exportTracesToOTLP( 
    traces: Trace[], 
    options: OTLPExportOptions = {} 
): OTLPExportTraceServiceRequest
{
    const spans: OTLPSpan[] = [];

    for( const trace of traces )
    {
        const ctx: EncodeContext = 
            {
                traceId : trace.traceId,
                now     : trace.endTime ?? options.now?.() ?? Date.now(),
                warn    : ( spanName, key, value ) => 
                {
                    options.onWarning?.( 
                        {
                            code    : 'TRACE_ATTRIBUTE_INVALID',
                            message : `Dropped non-finite or unsupported attribute '${key}' on span '${spanName}'`,
                            details : { traceId : trace.traceId, span : spanName, key, value : typeof value === 'number' ? String( value ) : typeof value }
                        } );
                }
            };

        flattenSpansToOTLP( trace.rootSpan, spans, ctx );
    }

    return {
        resourceSpans : 
        [
            {
                resource : { attributes : resourceAttributes( options ) },
                scopeSpans : 
                [
                    {
                        scope : 
                        {
                            name    : '@webergency-utils/ai',
                            version : '0.1.0'
                        },
                        spans
                    }
                ]
            }
        ]
    };
}

/**
 * Exports a completed Trace to the standard OpenTelemetry OTLP Protobuf-JSON schema.
 */
export function exportTraceToOTLP( 
    trace: Trace, 
    options: OTLPExportOptions = {} 
): OTLPExportTraceServiceRequest
{
    return exportTracesToOTLP( [ trace ], options );
}
