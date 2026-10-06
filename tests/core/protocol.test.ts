import { describe, it, expect } from 'vitest';
import { 
    parseSSEStream, 
    createStreamChunk, 
    MissingDependencyError, 
    ProviderError,
    type ChatMessage
} from '../../src/core/index.js';

describe( 'Core Protocol & Streaming', () => 
{
    it( 'should parse standard SSE events from stream', async () => 
    {
        const text = 'event: delta\ndata: {"text": "hello"}\n\nevent: done\ndata: [DONE]\n\n';
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>(
            {
                start( controller )
                {
                    controller.enqueue( encoder.encode( text ) );
                    controller.close();
                }
            } );

        const events = [];

        for await ( const ev of parseSSEStream( stream ) )
        {
            events.push( ev );
        }

        expect( events ).toHaveLength( 2 );
        expect( events[0] ).toEqual( { event : 'delta', data : '{"text": "hello"}' } );
        expect( events[1] ).toEqual( { event : 'done', data : '[DONE]' } );
    } );

    it( 'should handle chunked streaming and comment lines', async () => 
    {
        const chunk1 = ': ping\ndata: first';
        const chunk2 = ' line\n\n: heartbeat\ndata: second\n\n';
        const encoder = new TextEncoder();
        
        const stream = new ReadableStream<Uint8Array>(
            {
                start( controller )
                {
                    controller.enqueue( encoder.encode( chunk1 ) );
                    controller.enqueue( encoder.encode( chunk2 ) );
                    controller.close();
                }
            } );

        const events = [];

        for await ( const ev of parseSSEStream( stream ) )
        {
            events.push( ev );
        }

        expect( events ).toHaveLength( 2 );
        expect( events[0].data ).toBe( 'first line' );
        expect( events[1].data ).toBe( 'second' );
    } );

    it( 'should create stream chunks with raw property preserved', () => 
    {
        const rawPayload = { id : 'chunk-123', model : 'test-model' };
        const chunk = createStreamChunk( 'hello world', 
            {
                raw          : rawPayload,
                finishReason : 'stop'
            } );

        expect( chunk.deltaContent ).toBe( 'hello world' );
        expect( chunk.finishReason ).toBe( 'stop' );
        expect( chunk.raw ).toEqual( rawPayload );
    } );

    it( 'should format MissingDependencyError with copy-pasteable install command', () => 
    {
        const error = new MissingDependencyError( '@anthropic-ai/sdk' );

        expect( error.packageName ).toBe( '@anthropic-ai/sdk' );
        expect( error.installCmd ).toBe( 'npm install @anthropic-ai/sdk' );
        expect( error.message ).toContain( 'npm install @anthropic-ai/sdk' );
    } );

    it( 'should format ProviderError with status code and details', () => 
    {
        const error = new ProviderError( 'openai', 'Unauthorized', 401, { invalidKey : true } );

        expect( error.statusCode ).toBe( 401 );
        expect( error.provider ).toBe( 'openai' );
        expect( error.message ).toBe( '[openai] Unauthorized' );
        expect( error.details ).toEqual( { invalidKey : true } );
    } );

    it( 'should support multimodal ChatMessage structure', () => 
    {
        const msg: ChatMessage = 
            {
                role    : 'user',
                content : 'Describe this image and audio',
                attachments : 
            [
                {
                    type     : 'image',
                    mimeType : 'image/png',
                    url      : 'https://example.com/image.png'
                },
                {
                    type     : 'audio',
                    mimeType : 'audio/mp3',
                    data     : 'base64EncodedAudioData'
                }
            ]
            };

        expect( msg.attachments ).toHaveLength( 2 );
        expect( msg.attachments![0].type ).toBe( 'image' );
        expect( msg.attachments![1].type ).toBe( 'audio' );
    } );
} );
