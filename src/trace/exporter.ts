import type { 
    Span, 
    SpanAttributeValue, 
    SpanKind, 
    Trace, 
    SerializedTrace 
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

export interface OTLPSpan
{
    traceId           : string
    spanId            : string
    parentSpanId?     : string
    name              : string
    kind              : number
    startTimeUnixNano : string
    endTimeUnixNano   : string
    attributes        : OTLPKeyValue[]
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
    serviceName?    : string
    serviceVersion? : string
}

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

/**
 * Converts a JavaScript primitive attribute to an OTLP typed AnyValue.
 */
function toOTLPAnyValue( value: SpanAttributeValue ): OTLPAnyValue
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
        if( Number.isInteger( value ) )
        {
            return { intValue : value.toString() };
        }

        return { doubleValue : value };
    }

    return { stringValue : String( value ) };
}

/**
 * Recursively flattens a span tree into a flat array of OTLPSpan structures.
 */
function flattenSpansToOTLP( span: Span, out: OTLPSpan[], traceId?: string ): void
{
    const resolvedTraceId = traceId ?? span.traceId;
    const startTimeUnixNano = ( BigInt( span.startTime ) * 1_000_000n ).toString();
    const endTimeMs = span.endTime ?? ( span.durationMs ? span.startTime + span.durationMs : span.startTime );
    const endTimeUnixNano = ( BigInt( endTimeMs ) * 1_000_000n ).toString();

    const attributes: OTLPKeyValue[] = [];

    for( const [ k, v ] of Object.entries( span.attributes ) )
    {
        attributes.push( 
            {
                key   : k,
                value : toOTLPAnyValue( v )
            } );
    }

    // Add spend attributes if present
    if( span.spendUSD > 0 )
    {
        attributes.push( 
            {
                key   : 'spend.usd',
                value : { doubleValue : span.spendUSD }
            } );
    }

    // Add metric attributes
    for( const [ k, v ] of Object.entries( span.metrics ) )
    {
        if( typeof v === 'number' )
        {
            attributes.push( 
                {
                    key   : `metrics.${k}`,
                    value : Number.isInteger( v ) ? { intValue : v.toString() } : { doubleValue : v }
                } );
        }
    }

    const otlpSpan: OTLPSpan = 
        {
            traceId      : resolvedTraceId,
            spanId       : span.id,
            parentSpanId : span.parentSpanId,
            name         : span.name,
            kind         : mapSpanKindToOTLP( span.kind ),
            startTimeUnixNano,
            endTimeUnixNano,
            attributes,
            status : 
        {
            code    : span.status === 'error' ? 2 : 1, // 1 = OK, 2 = ERROR
            message : span.errorDetails?.message
        }
        };

    out.push( otlpSpan );

    for( const child of span.children )
    {
        flattenSpansToOTLP( child, out, resolvedTraceId );
    }
}

/**
 * Exports a completed Trace to the standard OpenTelemetry OTLP Protobuf-JSON schema.
 */
export function exportTraceToOTLP( 
    trace: Trace, 
    options: OTLPExportOptions = {} 
): OTLPExportTraceServiceRequest
{
    const spans: OTLPSpan[] = [];
    flattenSpansToOTLP( trace.rootSpan, spans, trace.traceId );

    const serviceName = options.serviceName ?? '@webergency-utils/ai';
    const serviceVersion = options.serviceVersion ?? '0.1.0';

    return {
        resourceSpans : 
        [
            {
                resource : 
                {
                    attributes : 
                    [
                        {
                            key   : 'service.name',
                            value : { stringValue : serviceName }
                        },
                        {
                            key   : 'service.version',
                            value : { stringValue : serviceVersion }
                        }
                    ]
                },
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
