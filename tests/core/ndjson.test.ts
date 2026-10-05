import { describe, it, expect } from 'vitest';
import { createNDJSONDecoder, parseNDJSONStream } from '../../src/core/ndjson.js';
import { chunkedStream } from '../helpers/http.js';

async function collect( stream: ReadableStream<Uint8Array> )
{
    const lines = [];

    for await ( const line of parseNDJSONStream( stream ) )
    {
        lines.push( line );
    }

    return lines;
}

describe( 'parseNDJSONStream', () => 
{
    const payload = '{"a":1}\n{"b":2}\n{"done":true}';

    it( 'delivers the final line without a trailing newline', async () => 
    {
        const lines = await collect( chunkedStream( payload, [] ) );

        expect( lines ).toEqual( [ '{"a":1}', '{"b":2}', '{"done":true}' ] );
    } );

    it( 'matches whole-payload output for every two-way split', async () => 
    {
        const bytes = new TextEncoder().encode( payload );
        const whole = await collect( chunkedStream( payload, [] ) );

        for( let i = 1; i < bytes.length; i++ )
        {
            const split = await collect( chunkedStream( payload, [ i ] ) );

            expect( split, `split at ${i}` ).toEqual( whole );
        }
    } );
} );

describe( 'createNDJSONDecoder', () => 
{
    it( 'push + flush yields every line', () => 
    {
        const decoder = createNDJSONDecoder();
        const out = [
            ...decoder.push( '{"x":1}\n{"y"' ),
            ...decoder.push( ':2}' ),
            ...decoder.flush()
        ];

        expect( out ).toEqual( [ '{"x":1}', '{"y":2}' ] );
    } );
} );
