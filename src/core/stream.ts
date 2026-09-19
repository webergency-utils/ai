import type { ModelStreamChunk } from './types.js';

export type SSEEvent =
    {
        event? : string
        data   : string
        id?    : string
    }

export async function* parseSSEStream( stream: ReadableStream<Uint8Array> ): AsyncGenerator<SSEEvent, void, unknown>
{
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try
    {
        while( true )
        {
            const { done, value } = await reader.read();

            if( done )
            {
                break;
            }

            buffer += decoder.decode( value, { stream : true } );
            const lines = buffer.split( '\n' );
            buffer = lines.pop() ?? '';

            let currentEvent: Partial<SSEEvent> = {};

            for( const line of lines )
            {
                const trimmed = line.trimEnd();

                if( trimmed === '' )
                {
                    if( currentEvent.data !== undefined )
                    {
                        yield {
                            data  : currentEvent.data,
                            event : currentEvent.event,
                            id    : currentEvent.id
                        };
                        currentEvent = {};
                    }
                    continue;
                }

                if( trimmed.startsWith( ':' ) )
                {
                    // Comment / heartbeat line
                    continue;
                }

                const colonIndex = trimmed.indexOf( ':' );

                if( colonIndex === -1 )
                {
                    continue;
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
            }
        }

        if( buffer.trim() !== '' )
        {
            const trimmed = buffer.trim();

            if( trimmed.startsWith( 'data:' ) )
            {
                const val = trimmed.slice( 5 ).trimStart();
                yield { data : val };
            }
        }
    }
    finally
    {
        reader.releaseLock();
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
