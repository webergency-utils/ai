import type { ModelRequestAttemptInfo, UsageMetrics } from './types.js';
import { InvalidInputError, ProviderError } from './error.js';

export type EmbeddingOptions =
    {
        signal?        : AbortSignal
        /** W3C `traceparent` of the calling span; only sent when the adapter config enables `propagateTraceContext`. */
        traceparent?   : string
        timeoutMs?     : number
        /** false disables retries; object overrides maxRetries for this call */
        retry?         : false | { maxRetries? : number }
        onAttempt?     : ( info: ModelRequestAttemptInfo ) => void
        /** Requested output dimensionality where the provider supports truncation. */
        dimensions?    : number
        /** Provider task hint (e.g. Gemini `taskType`). */
        taskType?      : string
    }

export type EmbeddingResponse =
    {
        /** One vector per input, in input order. */
        vectors       : number[][]
        model         : string
        usage?        : UsageMetrics
        /** True when the provider returned no usage; metering records a gap, never zero cost. */
        usageMissing? : true
        raw           : unknown
    }

export interface EmbeddingProtocol
{
    readonly provider : string
    readonly model    : string

    embed( input: string | string[], options?: EmbeddingOptions ): Promise<EmbeddingResponse>
}

/** Normalizes `embed` input to a non-empty list of strings; rejects anything else loudly. */
export function normalizeEmbeddingInput( input: string | string[] ): string[]
{
    const list = typeof input === 'string' ? [ input ] : input;

    if( !Array.isArray( list ) || list.length === 0 )
    {
        throw new InvalidInputError( 'embed() requires a string or a non-empty array of strings' );
    }

    for( let i = 0; i < list.length; i++ )
    {
        if( typeof list[ i ] !== 'string' )
        {
            throw new InvalidInputError( `embed() input[${i}] must be a string` );
        }
    }

    return list;
}

/** Verifies provider vectors: right count, numeric, finite, one shared dimension. */
export function assertEmbeddingVectors( 
    provider: string, 
    vectors: unknown, 
    expectedCount: number 
): number[][]
{
    if( !Array.isArray( vectors ) || vectors.length !== expectedCount )
    {
        throw new ProviderError( 
            provider, 
            `Expected ${expectedCount} embedding vector(s), got ${Array.isArray( vectors ) ? vectors.length : typeof vectors}`, 
            502 
        );
    }

    let dimension = -1;

    for( let i = 0; i < vectors.length; i++ )
    {
        const vector = vectors[ i ] as unknown;

        if( !Array.isArray( vector ) || vector.length === 0 || !vector.every( ( v ) => {return typeof v === 'number' && Number.isFinite( v );} ) )
        {
            throw new ProviderError( provider, `Embedding vector ${i} is not a non-empty array of finite numbers`, 502 );
        }

        if( dimension === -1 )
        {
            dimension = vector.length;
        }
        else if( vector.length !== dimension )
        {
            throw new ProviderError( 
                provider, 
                `Embedding vector ${i} has dimension ${vector.length}, expected ${dimension}`, 
                502 
            );
        }
    }

    return vectors as number[][];
}
