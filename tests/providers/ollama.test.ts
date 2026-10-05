import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProviderAdapter } from '../../src/providers/ollama.js';
import type { ModelRequest } from '../../src/core/types.js';

describe( 'OllamaProviderAdapter', () => 
{
    const originalFetch = globalThis.fetch;

    beforeEach( () => 
    {
        vi.stubGlobal( 'fetch', vi.fn() );
    } );

    afterEach( () => 
    {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    } );

    it( 'should generate chat completion from local Ollama endpoint', async () => 
    {
        const mockData = 
            {
                model : 'llama3',
                message : 
            {
                role    : 'assistant',
                content : 'Hello from local Ollama!'
            },
                done              : true,
                done_reason       : 'stop',
                prompt_eval_count : 18,
                eval_count        : 22
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockData;}
        } as unknown as Response );

        const adapter = new OllamaProviderAdapter( {
            provider : 'ollama',
            model    : 'llama3'
        } );

        const req: ModelRequest = 
            {
                messages : [ { role : 'user', content : 'Hello' } ]
            };

        const res = await adapter.generate( req );

        expect( res.content ).toBe( 'Hello from local Ollama!' );
        expect( res.role ).toBe( 'assistant' );
        expect( res.finishReason ).toBe( 'stop' );
        expect( res.usage ).toEqual( {
            promptTokens     : 18,
            completionTokens : 22,
            totalTokens      : 40,
            raw              : mockData
        } );

        expect( vi.mocked( fetch ) ).toHaveBeenCalledWith(
            'http://127.0.0.1:11434/api/chat',
            expect.objectContaining( {
                method : 'POST'
            } )
        );
    } );

    it( 'should parse tool calls from Ollama response', async () => 
    {
        const mockData = 
            {
                model : 'llama3',
                message : 
            {
                role    : 'assistant',
                content : '',
                tool_calls : 
                [
                    {
                        function : 
                        {
                            name      : 'get_stock_price',
                            arguments : { symbol : 'AAPL' }
                        }
                    }
                ]
            },
                done        : true,
                done_reason : 'stop'
            };

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            json   : async () => {return mockData;}
        } as unknown as Response );

        const adapter = new OllamaProviderAdapter( {
            provider : 'ollama',
            model    : 'llama3'
        } );

        const res = await adapter.generate( {
            messages : [ { role : 'user', content : 'What is AAPL stock?' } ]
        } );

        expect( res.finishReason ).toBe( 'tool_calls' );
        expect( res.toolCalls ).toHaveLength( 1 );
        expect( res.toolCalls![0].name ).toBe( 'get_stock_price' );
        expect( res.toolCalls![0].arguments ).toEqual( { symbol : 'AAPL' } );
    } );

    it( 'should stream NDJSON chunks from Ollama endpoint', async () => 
    {
        const line1 = JSON.stringify( { model : 'llama3', message : { role : 'assistant', content : 'Thinking ' }, done : false } ) + '\n';
        const line2 = JSON.stringify( { model : 'llama3', message : { role : 'assistant', content : 'fast!' }, done : true, prompt_eval_count : 10, eval_count : 15 } ) + '\n';

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( line1 + line2 ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } as unknown as Response );

        const adapter = new OllamaProviderAdapter( {
            provider : 'ollama',
            model    : 'llama3'
        } );

        const chunks = [];

        for await ( const chunk of adapter.stream( { messages : [ { role : 'user', content : 'Run' } ] } ) )
        {
            chunks.push( chunk );
        }

        expect( chunks ).toHaveLength( 2 );
        expect( chunks[0].deltaContent ).toBe( 'Thinking ' );
        expect( chunks[1].deltaContent ).toBe( 'fast!' );
        expect( chunks[1].usage?.totalTokens ).toBe( 25 );
    } );

    it( 'throws when the stream ends without done:true (R44)', async () => 
    {
        const line1 = JSON.stringify( { 
            model   : 'llama3', 
            message : { role : 'assistant', content : 'partial' }, 
            done    : false 
        } ) + '\n';

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>( {
            start( controller )
            {
                controller.enqueue( encoder.encode( line1 ) );
                controller.close();
            }
        } );

        vi.mocked( fetch ).mockResolvedValue( {
            ok     : true,
            status : 200,
            body   : stream
        } as unknown as Response );

        const adapter = new OllamaProviderAdapter( {
            provider : 'ollama',
            model    : 'llama3'
        } );

        await expect( ( async () => 
        {
            for await ( const _chunk of adapter.stream( { messages : [ { role : 'user', content : 'Run' } ] } ) )
            {
                // consume
            }
        } )() ).rejects.toThrow( /without done:true terminator/ );
    } );
} );
