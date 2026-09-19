import { randomBytes } from 'node:crypto';

/**
 * Generates a 16-byte (32 hex characters) trace ID compatible with W3C TraceContext and OTLP.
 */
export function generateTraceId(): string
{
    return randomBytes( 16 ).toString( 'hex' );
}

/**
 * Generates an 8-byte (16 hex characters) span ID compatible with W3C TraceContext and OTLP.
 */
export function generateSpanId(): string
{
    return randomBytes( 8 ).toString( 'hex' );
}
