import { describe, it, expect } from 'vitest';
import {
    attachmentBase64,
    assertAttachmentRole,
    toOpenAIParts,
    toAnthropicBlocks,
    toGeminiParts,
    toOllamaImages,
    CapabilityError,
    InvalidInputError,
    type MessageAttachment
} from '../../src/core/index.js';

const bytes = new Uint8Array( [ 1, 2, 3 ] );
const b64 = Buffer.from( bytes ).toString( 'base64' );

const image = ( extra: Partial<MessageAttachment> = {} ): MessageAttachment => {return { type : 'image', mimeType : 'image/png', data : b64, ...extra };};

describe( 'multimodal helpers', () =>
{
    it( 'encodes bytes and passes base64 strings through', () =>
    {
        expect( attachmentBase64( image( { data : bytes } ) ) ).toBe( b64 );
        expect( attachmentBase64( image() ) ).toBe( b64 );
        expect( attachmentBase64( { type : 'image', mimeType : 'image/png', url : 'https://x/y.png' } ) ).toBeUndefined();
    } );

    describe( 'OpenAI parts', () =>
    {
        it( 'maps URL-only images to image_url without base64', () =>
        {
            const parts = toOpenAIParts( 'openai', 'look', [ { type : 'image', mimeType : 'image/png', url : 'https://x/y.png' } ] );

            expect( parts ).toEqual( [
                { type : 'text', text : 'look' },
                { type : 'image_url', image_url : { url : 'https://x/y.png' } }
            ] );
        } );

        it( 'maps bytes to data URLs, audio to input_audio, documents to file parts', () =>
        {
            const parts = toOpenAIParts( 'openai', '', [
                image(),
                { type : 'audio', mimeType : 'audio/mpeg', data : b64 },
                { type : 'document', mimeType : 'application/pdf', data : b64 }
            ] );

            expect( parts ).toEqual( [
                { type : 'image_url', image_url : { url : `data:image/png;base64,${b64}` } },
                { type : 'input_audio', input_audio : { data : b64, format : 'mp3' } },
                { type : 'file', file : { filename : 'document.pdf', file_data : `data:application/pdf;base64,${b64}` } }
            ] );
        } );

        it( 'omits empty text parts (R31)', () =>
        {
            expect( toOpenAIParts( 'openai', '', [ image() ] ).some( ( p ) => {return p.type === 'text';} ) ).toBe( false );
        } );

        it( 'rejects video, URL-only audio/documents, and sourceless attachments', () =>
        {
            expect( () => toOpenAIParts( 'openai', '', [ { type : 'video', mimeType : 'video/mp4', data : b64 } ] ) )
                .toThrow( /video.*openai|openai.*video/ );
            expect( () => toOpenAIParts( 'openai', '', [ { type : 'audio', mimeType : 'audio/wav', url : 'https://x' } ] ) )
                .toThrow( CapabilityError );
            expect( () => toOpenAIParts( 'openai', '', [ { type : 'document', mimeType : 'application/pdf', url : 'https://x' } ] ) )
                .toThrow( CapabilityError );
            expect( () => toOpenAIParts( 'openai', '', [ { type : 'image', mimeType : 'image/png' } ] ) )
                .toThrow( InvalidInputError );
        } );
    } );

    describe( 'Anthropic blocks', () =>
    {
        it( 'maps PDF documents with media_type and puts media before text', () =>
        {
            const blocks = toAnthropicBlocks( 'anthropic', 'summarise', [ { type : 'document', mimeType : 'application/pdf', data : b64 } ] );

            expect( blocks ).toEqual( [
                { type : 'document', source : { type : 'base64', media_type : 'application/pdf', data : b64 } },
                { type : 'text', text : 'summarise' }
            ] );
        } );

        it( 'maps URL-only images to url sources and rejects video/audio', () =>
        {
            expect( toAnthropicBlocks( 'anthropic', '', [ { type : 'image', mimeType : 'image/png', url : 'https://x/y.png' } ] ) )
                .toEqual( [ { type : 'image', source : { type : 'url', url : 'https://x/y.png' } } ] );
            expect( () => toAnthropicBlocks( 'anthropic', '', [ { type : 'video', mimeType : 'video/mp4', data : b64 } ] ) )
                .toThrow( CapabilityError );
            expect( () => toAnthropicBlocks( 'anthropic', '', [ { type : 'audio', mimeType : 'audio/wav', data : b64 } ] ) )
                .toThrow( CapabilityError );
        } );
    } );

    describe( 'Gemini parts', () =>
    {
        it( 'uses inlineData for bytes and fileData for URLs', () =>
        {
            expect( toGeminiParts( 'gemini', [
                { type : 'video', mimeType : 'video/mp4', data : b64 },
                { type : 'document', mimeType : 'application/pdf', url : 'https://generativelanguage.googleapis.com/v1beta/files/abc' }
            ] ) ).toEqual( [
                { inlineData : { mimeType : 'video/mp4', data : b64 } },
                { fileData : { mimeType : 'application/pdf', fileUri : 'https://generativelanguage.googleapis.com/v1beta/files/abc' } }
            ] );
        } );
    } );

    describe( 'Ollama images', () =>
    {
        it( 'returns base64 images and rejects video (AE6) and URL-only images', () =>
        {
            expect( toOllamaImages( 'ollama', [ image() ] ) ).toEqual( [ b64 ] );
            expect( () => toOllamaImages( 'ollama', [ { type : 'video', mimeType : 'video/mp4', data : b64 } ] ) )
                .toThrow( /video.*ollama|ollama.*video/ );
            expect( () => toOllamaImages( 'ollama', [ { type : 'image', mimeType : 'image/png', url : 'https://x' } ] ) )
                .toThrow( CapabilityError );
        } );
    } );

    it( 'rejects attachments on non-user roles', () =>
    {
        expect( () => assertAttachmentRole( 'assistant', [ image() ] ) ).toThrow( InvalidInputError );
        expect( () => assertAttachmentRole( 'user', [ image() ] ) ).not.toThrow();
        expect( () => assertAttachmentRole( 'tool', undefined ) ).not.toThrow();
    } );
} );
