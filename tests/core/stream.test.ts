import { describe, it, expect } from 'vitest';
import { parseSSEStream, createSSEDecoder } from '../../src/core/stream.js';
import { chunkedStream } from '../helpers/http.js';

async function collect( stream: ReadableStream<Uint8Array> )
{
    const events = [];

    for await ( const event of parseSSEStream( stream ) )
    {
        events.push( event );
    }

    return events;
}

describe( 'parseSSEStream', () => 
{
    const twoEvents = 'data: {"a":1}\n\ndata: {"b":2}\n\n';

    it( 'delivers an event when data and blank terminator arrive in different reads (AE1)', async () => 
    {
        // Split after the first data line, before the blank terminator.
        const splitAt = 'data: {"a":1}\n'.length;
        const events = await collect( chunkedStream( twoEvents, [ splitAt ] ) );

        expect( events ).toEqual( [
            { data : '{"a":1}', event : undefined, id : undefined },
            { data : '{"b":2}', event : undefined, id : undefined }
        ] );
    } );

    it( 'preserves event field when it arrives in an earlier read than data', async () => 
    {
        const payload = 'event: endpoint\ndata: /messages\n\n';
        const splitAt = 'event: endpoint\n'.length;
        const events = await collect( chunkedStream( payload, [ splitAt ] ) );

        expect( events ).toEqual( [
            { data : '/messages', event : 'endpoint', id : undefined }
        ] );
    } );

    it( 'matches whole-payload output for every two-way split', async () => 
    {
        const bytes = new TextEncoder().encode( twoEvents );
        const whole = await collect( chunkedStream( twoEvents, [] ) );

        for( let i = 1; i < bytes.length; i++ )
        {
            const split = await collect( chunkedStream( twoEvents, [ i ] ) );

            expect( split, `split at ${i}` ).toEqual( whole );
        }
    } );

    it( 'flushes a final data line without trailing blank', async () => 
    {
        const events = await collect( chunkedStream( 'data: final\n', [] ) );

        expect( events ).toEqual( [
            { data : 'final', event : undefined, id : undefined }
        ] );
    } );
} );

describe( 'createSSEDecoder', () => 
{
    it( 'push + flush equals parseSSEStream for a multi-event payload', () => 
    {
        const payload = 'id: 1\nevent: msg\ndata: hello\n\ndata: world\n\n';
        const decoder = createSSEDecoder();
        const mid = Math.floor( payload.length / 2 );
        const out = [
            ...decoder.push( payload.slice( 0, mid ) ),
            ...decoder.push( payload.slice( mid ) ),
            ...decoder.flush()
        ];

        expect( out ).toEqual( [
            { data : 'hello', event : 'msg', id : '1' },
            { data : 'world', event : undefined, id : undefined }
        ] );
    } );
} );
