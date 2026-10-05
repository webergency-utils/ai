import { describe, it, expect, vi } from 'vitest';
import { 
    loadVendorSDK, 
    getVendorPackageName, 
    createSDKBridge 
} from '../../src/providers/sdk-bridge.js';
import { MissingDependencyError, ProviderError } from '../../src/core/error.js';

describe( 'Vendor SDK Lazy Bridge', () => 
{
    it( 'should throw MissingDependencyError with install command for uninstalled package', async () => 
    {
        await expect( loadVendorSDK( '@nonexistent/vendor-package' ) )
            .rejects
            .toThrow( MissingDependencyError );

        try
        {
            await loadVendorSDK( '@anthropic-ai/sdk' );
        }
        catch( err )
        {
            const depErr = err as MissingDependencyError;
            expect( depErr.name ).toBe( 'MissingDependencyError' );
            expect( depErr.packageName ).toBe( '@anthropic-ai/sdk' );
            expect( depErr.installCmd ).toBe( 'npm install @anthropic-ai/sdk' );
        }
    } );

    it( 'should resolve correct package names for standard providers', () => 
    {
        expect( getVendorPackageName( 'openai' ) ).toBe( 'openai' );
        expect( getVendorPackageName( 'anthropic' ) ).toBe( '@anthropic-ai/sdk' );
        expect( getVendorPackageName( 'gemini' ) ).toBe( '@google/genai' );
        expect( getVendorPackageName( 'ollama' ) ).toBe( 'ollama' );
        expect( getVendorPackageName( 'custom' ) ).toBe( 'custom' );
    } );

    it( 'should wrap an OpenAI SDK client and execute completions', async () => 
    {
        const mockOpenAIClient = 
            {
                chat : 
            {
                completions : 
                {
                    create : vi.fn().mockResolvedValue( 
                        {
                            choices : 
                        [
                            {
                                message : { content : 'Bridged OpenAI response' }
                            }
                        ]
                        } )
                }
            }
            };

        const bridge = createSDKBridge( 'openai', 'gpt-4o', mockOpenAIClient );
        const res = await bridge.generate( {
            messages : [ { role : 'user', content : 'Hello' } ]
        } );

        expect( res.content ).toBe( 'Bridged OpenAI response' );
        expect( res.usageMissing ).toBe( true );
        expect( mockOpenAIClient.chat.completions.create ).toHaveBeenCalledWith( 
            {
                model    : 'gpt-4o',
                messages : [ { role : 'user', content : 'Hello' } ],
                stream   : false
            } );
    } );

    it( 'forwards AbortSignal into vendor SDK options and preserves usage when present', async () => 
    {
        const controller = new AbortController();
        const create = vi.fn().mockResolvedValue( {
            choices : [ { message : { content : 'ok' } } ],
            usage   : { prompt_tokens : 2, completion_tokens : 3, total_tokens : 5 }
        } );

        const bridge = createSDKBridge( 'openai', 'gpt-4o', {
            chat : { completions : { create } }
        } );

        const res = await bridge.generate( {
            messages : [ { role : 'user', content : 'Hello' } ],
            signal   : controller.signal
        } );

        expect( res.usageMissing ).toBeUndefined();
        expect( res.usage?.totalTokens ).toBe( 5 );
        expect( create ).toHaveBeenCalledWith( expect.objectContaining( {
            signal : controller.signal
        } ) );
    } );

    it( 'should wrap an Anthropic SDK client and execute messages', async () => 
    {
        const mockAnthropicClient = 
            {
                messages : 
            {
                create : vi.fn().mockResolvedValue( 
                    {
                        content : 
                    [
                        {
                            type : 'text',
                            text : 'Bridged Claude response'
                        }
                    ]
                    } )
            }
            };

        const bridge = createSDKBridge( 'anthropic', 'claude-3-7-sonnet', mockAnthropicClient );
        const res = await bridge.generate( {
            messages : [ { role : 'user', content : 'Hello' } ]
        } );

        expect( res.content ).toBe( 'Bridged Claude response' );
        expect( mockAnthropicClient.messages.create ).toHaveBeenCalledWith( 
            {
                model      : 'claude-3-7-sonnet',
                messages   : [ { role : 'user', content : 'Hello' } ],
                max_tokens : 4096
            } );
    } );

    it( 'should wrap a Gemini SDK client and execute generateContent', async () => 
    {
        const mockGeminiClient = 
            {
                models : 
            {
                generateContent : vi.fn().mockResolvedValue( 
                    {
                        text : () => {return 'Bridged Gemini response';}
                    } )
            }
            };

        const bridge = createSDKBridge( 'gemini', 'gemini-2.5-flash', mockGeminiClient );
        const res = await bridge.generate( {
            messages : [ { role : 'user', content : 'Hello' } ]
        } );

        expect( res.content ).toBe( 'Bridged Gemini response' );
    } );

    it( 'should wrap an Ollama SDK client and execute chat', async () => 
    {
        const mockOllamaClient = 
            {
                chat : vi.fn().mockResolvedValue( 
                    {
                        message : { content : 'Bridged Ollama response' }
                    } )
            };

        const bridge = createSDKBridge( 'ollama', 'llama3', mockOllamaClient );
        const res = await bridge.generate( {
            messages : [ { role : 'user', content : 'Hello' } ]
        } );

        expect( res.content ).toBe( 'Bridged Ollama response' );
    } );

    it( 'should throw ProviderError on invalid client or unsupported provider', async () => 
    {
        const badBridge = createSDKBridge( 'openai', 'gpt-4o', {} );

        await expect( badBridge.generate( { messages : [] } ) )
            .rejects
            .toThrow( ProviderError );

        const unsupportedBridge = createSDKBridge( 'unknown-provider', 'model', {} );

        await expect( unsupportedBridge.generate( { messages : [] } ) )
            .rejects
            .toThrow( ProviderError );
    } );
} );
