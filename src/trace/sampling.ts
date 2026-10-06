import { AIError } from '../core/error.js';
import type { Span, Trace } from './types.js';

export interface TraceSamplingOptions
{
    /** Custom decision. Must be fast and synchronous. Combined with `sampleRate` by AND. */
    sampler?           : ( trace: Trace ) => boolean
    /** Fraction of traces to keep, 0-1, deterministic by `traceId`. Default 1. */
    sampleRate?        : number
    /** Keep every trace that contains an errored span regardless of the rate. Default true. */
    alwaysSampleErrors?: boolean
}

/** Maps a trace id to [0, 1) deterministically (the low 52 bits for hex ids, FNV-1a otherwise). */
export function traceIdToUnit( traceId: string ): number
{
    const tail = traceId.slice( -13 );

    if( /^[0-9a-f]{13}$/i.test( tail ) )
    {
        return parseInt( tail, 16 ) / 2 ** 52;
    }

    let hash = 0x811c9dc5;

    for( let i = 0; i < traceId.length; i++ )
    {
        hash ^= traceId.charCodeAt( i );
        hash = Math.imul( hash, 0x01000193 ) >>> 0;
    }

    return hash / 2 ** 32;
}

/** True when `traceId` falls inside the kept fraction `rate`. */
export function sampleByRate( traceId: string, rate: number ): boolean
{
    if( rate >= 1 )
    {
        return true;
    }

    if( rate <= 0 )
    {
        return false;
    }

    return traceIdToUnit( traceId ) < rate;
}

export function hasErrorSpan( span: Span ): boolean
{
    if( span.status === 'error' )
    {
        return true;
    }

    for( const child of span.children )
    {
        if( hasErrorSpan( child ) )
        {
            return true;
        }
    }

    return false;
}

export function assertSamplingOptions( options: TraceSamplingOptions | undefined, owner: string ): void
{
    const rate = options?.sampleRate;

    if( rate !== undefined && ( typeof rate !== 'number' || !Number.isFinite( rate ) || rate < 0 || rate > 1 ) )
    {
        throw new AIError( `${owner}: sampleRate must be a number between 0 and 1`, 'TRACE_SAMPLING_CONFIG' );
    }

    if( options?.sampler !== undefined && typeof options.sampler !== 'function' )
    {
        throw new AIError( `${owner}: sampler must be a function`, 'TRACE_SAMPLING_CONFIG' );
    }
}

/**
 * Builds the keep/drop decision. Errored traces always win when `alwaysSampleErrors` (default).
 * A throwing sampler keeps the trace (telemetry loss is the worse failure) and reports through `onError`.
 */
export function createSampler( 
    options: TraceSamplingOptions = {}, 
    onError?: ( error: unknown ) => void 
): ( trace: Trace ) => boolean
{
    const { sampler, sampleRate = 1, alwaysSampleErrors = true } = options;

    return ( trace ) => 
    {
        if( alwaysSampleErrors && hasErrorSpan( trace.rootSpan ) )
        {
            return true;
        }

        if( !sampleByRate( trace.traceId, sampleRate ) )
        {
            return false;
        }

        if( sampler )
        {
            try
            {
                return sampler( trace );
            }
            catch( error )
            {
                onError?.( error );

                return true;
            }
        }

        return true;
    };
}
