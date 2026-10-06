import type { Span } from './types.js';

export interface ParsedTraceparent
{
    version : string
    traceId : string
    spanId  : string
    /** Raw 2-hex trace flags. */
    flags   : string
    sampled : boolean
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const HEX2_RE = /^[0-9a-f]{2}$/;

export function isValidTraceId( value: unknown ): value is string
{
    return typeof value === 'string' && TRACE_ID_RE.test( value ) && value !== '0'.repeat( 32 );
}

export function isValidSpanId( value: unknown ): value is string
{
    return typeof value === 'string' && SPAN_ID_RE.test( value ) && value !== '0'.repeat( 16 );
}

/**
 * Formats a W3C `traceparent` header (`00-<trace-id>-<span-id>-<flags>`) for a span.
 * Returns `undefined` when the span's ids are not W3C-shaped (custom ids), so callers can skip the header.
 */
export function toTraceparent( span: Pick<Span, 'traceId' | 'id'>, sampled: boolean = true ): string | undefined
{
    if( !isValidTraceId( span.traceId ) || !isValidSpanId( span.id ) )
    {
        return undefined;
    }

    return `00-${span.traceId}-${span.id}-${sampled ? '01' : '00'}`;
}

/**
 * Strict W3C `traceparent` parser. Rejects (returns `undefined`) anything malformed: wrong shape or casing,
 * version `ff`, all-zero ids, and extra fields on version `00`. Future versions may append fields.
 */
export function fromTraceparent( header: string | null | undefined ): ParsedTraceparent | undefined
{
    if( typeof header !== 'string' || header.length < 55 || header.length > 512 )
    {
        return undefined;
    }

    const parts = header.split( '-' );

    if( parts.length < 4 )
    {
        return undefined;
    }

    const [ version, traceId, spanId, flags ] = parts as [ string, string, string, string ];

    if( !HEX2_RE.test( version ) || version === 'ff' || !HEX2_RE.test( flags ) )
    {
        return undefined;
    }

    if( version === '00' && ( parts.length !== 4 || header.length !== 55 ) )
    {
        return undefined;
    }

    if( !isValidTraceId( traceId ) || !isValidSpanId( spanId ) )
    {
        return undefined;
    }

    return { version, traceId, spanId, flags, sampled : ( parseInt( flags, 16 ) & 1 ) === 1 };
}

/** Builds a `traceparent` from an MCP-style `_meta` (`traceId` + `parentSpanId`), or `undefined` if absent/invalid. */
export function traceparentFromMeta( meta: unknown ): string | undefined
{
    if( !meta || typeof meta !== 'object' )
    {
        return undefined;
    }

    const { traceId, parentSpanId } = meta as { traceId?: unknown, parentSpanId?: unknown };

    if( !isValidTraceId( traceId ) || !isValidSpanId( parentSpanId ) )
    {
        return undefined;
    }

    return `00-${traceId}-${parentSpanId}-01`;
}
