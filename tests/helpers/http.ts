/**
 * Shared HTTP fixtures for provider tests.
 * Builds real Response objects (with headers) and chunked ReadableStreams.
 */

export interface MockJsonResponseOptions
{
    status?  : number
    headers? : Record<string, string>
}

export function jsonResponse( 
    body: unknown, 
    options: MockJsonResponseOptions = {} 
): Response
{
    const status = options.status ?? 200;
    const headers = new Headers( {
        'content-type' : 'application/json',
        ...( options.headers ?? {} )
    } );

    return new Response( JSON.stringify( body ), { status, headers } );
}

export function textResponse( 
    body: string, 
    options: MockJsonResponseOptions = {} 
): Response
{
    const status = options.status ?? 200;
    const headers = new Headers( {
        'content-type' : 'text/plain',
        ...( options.headers ?? {} )
    } );

    return new Response( body, { status, headers } );
}

export function sseResponse( 
    events: string[], 
    options: MockJsonResponseOptions = {} 
): Response
{
    const status = options.status ?? 200;
    const headers = new Headers( {
        'content-type' : 'text/event-stream',
        ...( options.headers ?? {} )
    } );
    const payload = events.join( '' );

    return new Response( payload, { status, headers } );
}

/**
 * ReadableStream that yields `payload` split into chunks at the given byte offsets.
 * Offsets are exclusive end indices into the UTF-8 byte sequence; the remainder is a final chunk.
 */
export function chunkedStream( 
    payload: string, 
    splitAt: number[] = [] 
): ReadableStream<Uint8Array>
{
    const bytes = new TextEncoder().encode( payload );
    const cuts = [ ...new Set( splitAt.filter( ( n ) => {return n > 0 && n < bytes.length;} ) ) ].sort( ( a, b ) => {return a - b;} );
    const ranges: Uint8Array[] = [];
    let start = 0;

    for( const cut of cuts )
    {
        ranges.push( bytes.subarray( start, cut ) );
        start = cut;
    }

    ranges.push( bytes.subarray( start ) );

    let index = 0;

    return new ReadableStream( {
        pull( controller )
        {
            if( index >= ranges.length )
            {
                controller.close();

                return;
            }

            controller.enqueue( ranges[index++] );
        }
    } );
}

export function streamResponse( 
    stream: ReadableStream<Uint8Array>, 
    options: MockJsonResponseOptions & { contentType?: string } = {} 
): Response
{
    const status = options.status ?? 200;
    const headers = new Headers( {
        'content-type' : options.contentType ?? 'text/event-stream',
        ...( options.headers ?? {} )
    } );

    return new Response( stream, { status, headers } );
}
