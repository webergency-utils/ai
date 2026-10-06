import { InvalidInputError } from '../core/error.js';

function fail( path: string, reason: string ): never
{
    throw new InvalidInputError( `Value at '${path}' cannot be stored as JSON: ${reason}`, { path, reason } );
}

function walk( value: unknown, path: string, stack: Set<object>, allowUndefined: boolean ): void
{
    if( value === null ){return;}

    switch ( typeof value )
    {
        case 'string':
        case 'boolean':
            return;
        case 'number':
            if( !Number.isFinite( value ) ){fail( path, `non-finite number (${value})` );}

            return;
        case 'undefined':
            if( !allowUndefined ){fail( path, 'undefined' );}

            return;
        case 'bigint':
            return fail( path, 'bigint' );
        case 'function':
            return fail( path, 'function' );
        case 'symbol':
            return fail( path, 'symbol' );
    }

    const obj = value as object;

    if( stack.has( obj ) ){fail( path, 'circular reference' );}

    stack.add( obj );

    if( Array.isArray( obj ) )
    {
        for( let i = 0; i < obj.length; i++ )
        {
            if( !( i in obj ) ){fail( `${path}[${i}]`, 'sparse array hole' );}

            walk( obj[i], `${path}[${i}]`, stack, false );
        }
    }
    else
    {
        const proto = Object.getPrototypeOf( obj );

        if( proto !== Object.prototype && proto !== null )
        {
            fail( path, obj instanceof Date ? 'Date' : `non-plain object (${obj.constructor?.name ?? 'unknown'})` );
        }

        for( const [ k, v ] of Object.entries( obj ) )
        {
            walk( v, `${path}.${k}`, stack, true );
        }
    }

    stack.delete( obj );
}

/**
 * Throws `InvalidInputError` naming the offending path when `value` would not survive a JSON round trip unchanged.
 * `undefined` object properties are tolerated (JSON drops them); everywhere else `undefined` is rejected.
 */
export function assertJsonSafe( value: unknown, label: string = 'value' ): void
{
    walk( value, label, new Set<object>(), false );
}

/** Serializes after validating, so the stored text always round-trips. */
export function toJson( value: unknown, label: string = 'value' ): string
{
    assertJsonSafe( value, label );

    return JSON.stringify( value );
}

/** Filters are scalar equality maps; anything else is rejected uniformly across backends. */
export function assertScalarFilter( filter: Record<string, unknown> | undefined, label: string = 'filter' ): void
{
    if( !filter ){return;}

    for( const [ k, v ] of Object.entries( filter ) )
    {
        const ok = v === null || typeof v === 'string' || typeof v === 'boolean' || ( typeof v === 'number' && Number.isFinite( v ) );

        if( !ok ){fail( `${label}.${k}`, 'only scalar equality filters (string, finite number, boolean, null) are supported' );}
    }
}
