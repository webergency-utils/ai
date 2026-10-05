import type { ModelStreamChunk } from './types.js';

export type SSEEvent =
    {
        event? : string
        data   : string
        id?    : string
    }

export interface SSEDecoder
{
    push( chunk: string ): SSEEvent[]
    flush(): SSEEvent[]
}

/**
 * Incremental SSE decoder. Event state persists across `push` calls so splits
 * between network reads do not drop fields or events.
 */
export function createSSEDecoder(): SSEDecoder
{
    let buffer = '';
    let currentEvent: Partial<SSEEvent> = {};

    const finishEvent = (): SSEEvent | undefined => 
    {
        if( currentEvent.data === undefined )
        {
            currentEvent = {};

            return undefined;
        }

        const event: SSEEvent = 
            {
                data  : currentEvent.data,
                event : currentEvent.event,
                id    : currentEvent.id
            };

        currentEvent = {};

        return event;
    };

    const processLine = ( line: string, out: SSEEvent[] ): void => 
    {
        const trimmed = line.trimEnd();

        if( trimmed === '' )
        {
            const event = finishEvent();

            if( event )
            {
                out.push( event );
            }

            return;
        }

        if( trimmed.startsWith( ':' ) )
        {
            return;
        }

        const colonIndex = trimmed.indexOf( ':' );

        if( colonIndex === -1 )
        {
            return;
        }

        const field = trimmed.slice( 0, colonIndex );
        let fieldValue = trimmed.slice( colonIndex + 1 );

        if( fieldValue.startsWith( ' ' ) )
        {
            fieldValue = fieldValue.slice( 1 );
        }

        if( field === 'data' )
        {
            currentEvent.data = currentEvent.data !== undefined 
                ? `${currentEvent.data}\n${fieldValue}` 
                : fieldValue;
        }
        else if( field === 'event' )
        {
            currentEvent.event = fieldValue;
        }
        else if( field === 'id' )
        {
            currentEvent.id = fieldValue;
        }
    };

    return {
        push( chunk: string ): SSEEvent[]
        {
            buffer += chunk;
            const lines = buffer.split( '\n' );
            buffer = lines.pop() ?? '';
            const out: SSEEvent[] = [];

            for( const line of lines )
            {
                processLine( line, out );
            }

            return out;
        },

        flush(): SSEEvent[]
        {
            const out: SSEEvent[] = [];

            if( buffer.length > 0 )
            {
                processLine( buffer, out );
                buffer = '';
            }

            const trailing = finishEvent();

            if( trailing )
            {
                out.push( trailing );
            }

            return out;
        }
    };
}

export async function* parseSSEStream( stream: ReadableStream<Uint8Array> ): AsyncGenerator<SSEEvent, void, unknown>
{
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const sse = createSSEDecoder();

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

            for( const event of sse.push( text ) )
            {
                yield event;
            }
        }

        const tail = decoder.decode();

        if( tail )
        {
            for( const event of sse.push( tail ) )
            {
                yield event;
            }
        }

        for( const event of sse.flush() )
        {
            yield event;
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
            // Already closed or locked.
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

export function createStreamChunk(
    delta: string, 
    extra?: Partial<ModelStreamChunk>
): ModelStreamChunk
{
    return {
        deltaContent : delta,
        ...extra
    };
}
