export const MAX_ERROR_BODY_CHARS = 200;

/** Reads at most `maxChars` of a response body for error reporting, then cancels the rest. */
export async function readTruncated( response: Response, maxChars: number = MAX_ERROR_BODY_CHARS ): Promise<string>
{
    if( !response.body )
    {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';

    try
    {
        while( text.length < maxChars )
        {
            const { done, value } = await reader.read();

            if( done )
            {
                break;
            }

            text += decoder.decode( value, { stream : true } );
        }
    }
    catch
    {
        // A broken body must not hide the HTTP status we are about to report.
    }
    finally
    {
        await reader.cancel().catch( () => {} );
    }

    return text.length > maxChars ? `${text.slice( 0, maxChars )}…` : text;
}
