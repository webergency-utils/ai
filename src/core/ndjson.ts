export interface NDJSONDecoder
{
    push( chunk: string ): string[]
    flush(): string[]
}

/**
 * Incremental newline-delimited JSON line splitter.
 * Keeps a carry buffer so multi-byte characters and lines split across reads stay intact.
 */
export function createNDJSONDecoder(): NDJSONDecoder
{
    let buffer = '';

    return {
        push( chunk: string ): string[]
        {
            buffer += chunk;
            const lines = buffer.split( '\n' );
            buffer = lines.pop() ?? '';
            const out: string[] = [];

            for( const line of lines )
            {
                const trimmed = line.trim();

                if( trimmed )
                {
                    out.push( trimmed );
                }
            }

            return out;
        },

        flush(): string[]
        {
            const trimmed = buffer.trim();
            buffer = '';

            if( !trimmed )
            {
                return [];
            }

            return [ trimmed ];
        }
    };
}

export async function* parseNDJSONStream( 
    stream: ReadableStream<Uint8Array> 
): AsyncGenerator<string, void, unknown>
{
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const ndjson = createNDJSONDecoder();

    try
    {
        while( true )
        {
            const { done, value } = await reader.read();

            if( done )
            {
                break;
            }

            const text = decoder.decode( value, { stream : true } );

            for( const line of ndjson.push( text ) )
            {
                yield line;
            }
        }

        const tail = decoder.decode();

        if( tail )
        {
            for( const line of ndjson.push( tail ) )
            {
                yield line;
            }
        }

        for( const line of ndjson.flush() )
        {
            yield line;
        }
    }
    finally
    {
        try
        {
            await reader.cancel();
        }
        catch
        {
            // Already closed.
        }

        try
        {
            reader.releaseLock();
        }
        catch
        {
            // Already released.
        }
    }
}
