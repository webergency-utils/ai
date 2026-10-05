import type { AttachmentType, MessageAttachment } from './types.js';
import { CapabilityError, InvalidInputError } from './error.js';

type WirePart = Record<string, unknown>;

/** Base64 of attachment bytes; `undefined` when the attachment is URL-only. */
export function attachmentBase64( attachment: MessageAttachment ): string | undefined
{
    const data = attachment.data;

    if( data === undefined || data === null || data === '' )
    {
        return undefined;
    }

    return typeof data === 'string' ? data : Buffer.from( data ).toString( 'base64' );
}

function assertHasSource( provider: string, attachment: MessageAttachment ): void
{
    const hasData = attachment.data !== undefined && attachment.data !== null && attachment.data !== '';

    if( !hasData && !attachment.url )
    {
        throw new InvalidInputError( 
            `[${provider}] ${attachment.type} attachment has neither data nor url` 
        );
    }
}

function requireBytes( provider: string, attachment: MessageAttachment ): string
{
    assertHasSource( provider, attachment );

    const base64 = attachmentBase64( attachment );

    if( base64 === undefined )
    {
        throw new CapabilityError( 
            provider, 
            `multimodal.${attachment.type}`, 
            `${attachment.type} attachment must be supplied as bytes (url-only is not accepted)` 
        );
    }

    return base64;
}

function unsupported( provider: string, type: AttachmentType ): CapabilityError
{
    return new CapabilityError( 
        provider, 
        `multimodal.${type}`, 
        `attachment type '${type}' is not supported by ${provider}` 
    );
}

/**
 * Attachments only make sense on user turns. Anything else would be dropped by
 * every wire format, so reject it instead.
 */
export function assertAttachmentRole( role: string, attachments?: MessageAttachment[] ): void
{
    if( attachments && attachments.length > 0 && role !== 'user' )
    {
        throw new InvalidInputError( `Attachments are only supported on user messages (got '${role}')` );
    }
}

function audioFormat( mimeType: string ): string
{
    const sub = mimeType.split( '/' )[ 1 ]?.toLowerCase() ?? 'wav';

    if( sub === 'mpeg' || sub === 'mp3' )
    {
        return 'mp3';
    }

    if( sub === 'x-wav' || sub === 'wave' )
    {
        return 'wav';
    }

    return sub;
}

function documentFilename( attachment: MessageAttachment ): string
{
    if( attachment.filename )
    {
        return attachment.filename;
    }

    return attachment.mimeType === 'application/pdf' ? 'document.pdf' : 'document';
}

/** OpenAI-compatible chat `content` parts for one user message. Empty text is omitted (R31). */
export function toOpenAIParts( 
    provider: string, 
    content: string, 
    attachments: MessageAttachment[] 
): WirePart[]
{
    const parts: WirePart[] = [];

    if( content )
    {
        parts.push( { type : 'text', text : content } );
    }

    for( const att of attachments )
    {
        if( att.type === 'image' )
        {
            assertHasSource( provider, att );

            const base64 = attachmentBase64( att );
            const url = base64 !== undefined ? `data:${att.mimeType};base64,${base64}` : att.url!;

            parts.push( { type : 'image_url', image_url : { url } } );
        }
        else if( att.type === 'audio' )
        {
            parts.push( { type : 'input_audio', input_audio : { data : requireBytes( provider, att ), format : audioFormat( att.mimeType ) } } );
        }
        else if( att.type === 'document' )
        {
            parts.push( { 
                type : 'file', 
                file : { 
                    filename  : documentFilename( att ), 
                    file_data : `data:${att.mimeType};base64,${requireBytes( provider, att )}` 
                } 
            } );
        }
        else
        {
            throw unsupported( provider, att.type );
        }
    }

    return parts;
}

/** Anthropic image/document blocks (media first, text last). Empty text is omitted (R31). */
export function toAnthropicBlocks( 
    provider: string, 
    content: string, 
    attachments: MessageAttachment[] 
): WirePart[]
{
    const blocks: WirePart[] = [];

    for( const att of attachments )
    {
        if( att.type !== 'image' && att.type !== 'document' )
        {
            throw unsupported( provider, att.type );
        }

        assertHasSource( provider, att );

        const base64 = attachmentBase64( att );

        blocks.push( {
            type   : att.type,
            source : base64 !== undefined
                ? { type : 'base64', media_type : att.mimeType, data : base64 }
                : { type : 'url', url : att.url }
        } );
    }

    if( content )
    {
        blocks.push( { type : 'text', text : content } );
    }

    return blocks;
}

/** Gemini parts: `inlineData` for bytes, `fileData` for URL-only attachments. */
export function toGeminiParts( provider: string, attachments: MessageAttachment[] ): WirePart[]
{
    const parts: WirePart[] = [];

    for( const att of attachments )
    {
        assertHasSource( provider, att );

        const base64 = attachmentBase64( att );

        parts.push( base64 !== undefined
            ? { inlineData : { mimeType : att.mimeType, data : base64 } }
            : { fileData : { mimeType : att.mimeType, fileUri : att.url } } );
    }

    return parts;
}

/** Ollama chat accepts base64 images only. */
export function toOllamaImages( provider: string, attachments: MessageAttachment[] ): string[]
{
    const images: string[] = [];

    for( const att of attachments )
    {
        if( att.type !== 'image' )
        {
            throw unsupported( provider, att.type );
        }

        images.push( requireBytes( provider, att ) );
    }

    return images;
}
