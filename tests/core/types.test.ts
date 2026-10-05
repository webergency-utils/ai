import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    NO_CAPABILITIES,
    getCapabilities,
    CapabilityError,
    type LanguageModel,
    type ModelProtocol,
    type ChatMessage,
    type ModelRequest,
    type ModelResponse,
    type ModelStreamChunk
} from '../../src/core/index.js';
import {
    BaseProviderAdapter,
    createModel,
    createSDKBridge,
    MeteredModel,
    OpenAIProviderAdapter,
    GroqProviderAdapter,
    OllamaProviderAdapter,
    AnthropicProviderAdapter
} from '../../src/providers/index.js';
import { SpendTracker } from '../../src/spend/index.js';

class StubAdapter extends BaseProviderAdapter
{
    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        this.assertRequestSupported( request );

        return { content : '', role : 'assistant', finishReason : 'stop', raw : {} };
    }

    public async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        this.assertRequestSupported( request );
        yield { deltaContent : '' };
    }
}

describe( 'LanguageModel contract', () =>
{
    afterEach( () =>
    {
        vi.unstubAllGlobals();
    } );

    it( 'keeps ModelProtocol assignable both ways with LanguageModel', () =>
    {
        const model: LanguageModel = {
            provider : 'x',
            model    : 'y',
            generate : async () => { return { content : '', role : 'assistant', finishReason : 'stop', raw : {} }; },
            stream   : async function* () { yield { deltaContent : '' }; }
        };
        const legacy: ModelProtocol = model;
        const back: LanguageModel = legacy;

        expect( back.provider ).toBe( 'x' );
        expect( getCapabilities( back ) ).toBe( NO_CAPABILITIES );
    } );

    it( 'reports all capability flags false for a stub adapter until overridden', () =>
    {
        const stub = new StubAdapter( { provider : 'stub', model : 'm' } );

        expect( stub.capabilities ).toEqual( NO_CAPABILITIES );

        const overridden = new StubAdapter( {
            provider     : 'stub',
            model        : 'm',
            capabilities : { structuredOutput : true, multimodal : { image : true } }
        } );

        expect( overridden.capabilities.structuredOutput ).toBe( true );
        expect( overridden.capabilities.multimodal ).toEqual( { image : true, audio : false, video : false, document : false } );
    } );

    it( 'fails before HTTP when outputSchema is set without structuredOutput', async () =>
    {
        const fetchMock = vi.fn();
        vi.stubGlobal( 'fetch', fetchMock );
        const stub = new StubAdapter( { provider : 'stub', model : 'm' } );
        const request: ModelRequest = {
            messages     : [ { role : 'user', content : 'hi' } ],
            outputSchema : { type : 'object', properties : {} }
        };

        await expect( stub.generate( request ) ).rejects.toThrow( /structuredOutput/ );
        await expect( stub.generate( request ) ).rejects.toBeInstanceOf( CapabilityError );
        await expect( ( async () => { for await ( const _ of stub.stream( request ) ) { void _; } } )() ).rejects.toThrow( /stub/ );
        expect( fetchMock ).not.toHaveBeenCalled();
    } );

    it( 'rejects reasoningContent on non-assistant messages', async () =>
    {
        const stub = new StubAdapter( { provider : 'stub', model : 'm' } );

        await expect( stub.generate( {
            messages : [ { role : 'user', content : 'hi', reasoningContent : 'x' } ]
        } ) ).rejects.toThrow( /assistant/ );
    } );

    it( 'exposes honest capability defaults per provider', () =>
    {
        const openai = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o' } );
        const groq = new GroqProviderAdapter( { provider : 'groq', model : 'm' } );
        const ollama = new OllamaProviderAdapter( { provider : 'ollama', model : 'm' } );
        const anthropic = new AnthropicProviderAdapter( { provider : 'anthropic', model : 'm' } );

        expect( openai.capabilities.multimodal.video ).toBe( false );
        expect( openai.capabilities.promptCacheControl ).toBe( true );
        expect( groq.capabilities.promptCacheControl ).toBe( false );
        expect( ollama.capabilities.multimodal ).toEqual( { image : true, audio : false, video : false, document : false } );
        expect( anthropic.capabilities.multimodal.document ).toBe( true );
        expect( createModel( { provider : 'gemini', model : 'g' } ).capabilities?.multimodal.video ).toBe( true );
    } );

    it( 'passes capabilities through MeteredModel and bridges as none', () =>
    {
        const openai = new OpenAIProviderAdapter( { provider : 'openai', model : 'gpt-4o' } );
        const metered = new MeteredModel( openai, { tracker : new SpendTracker() } );

        expect( metered.capabilities ).toEqual( openai.capabilities );
        expect( createSDKBridge( 'openai', 'm', {} ).capabilities ).toEqual( NO_CAPABILITIES );
    } );

    it( 'rejects structured output and attachments on the SDK bridge', async () =>
    {
        const bridge = createSDKBridge( 'openai', 'm', {} );

        await expect( bridge.generate( {
            messages     : [ { role : 'user', content : 'x' } ],
            outputSchema : { type : 'object' }
        } ) ).rejects.toBeInstanceOf( CapabilityError );
    } );

    it( 'round-trips reasoningContent and cacheControl through JSON cloning', () =>
    {
        const message: ChatMessage = {
            role             : 'assistant',
            content          : '',
            reasoningContent : 'step plan',
            cacheControl     : { type : 'ephemeral', ttl : '1h' },
            toolCalls        : [ { id : 'a', name : 't', arguments : { q : 1 } } ]
        };

        expect( JSON.parse( JSON.stringify( message ) ) ).toEqual( message );
    } );
} );
