import type { ModelProtocol } from '../core/protocol.js';
import type { ModelRequest, ModelResponse, ModelStreamChunk, UsageMetrics } from '../core/types.js';
import { MissingDependencyError, ProviderError } from '../core/error.js';

type AnyFn = ( ...args: unknown[] ) => unknown;

export const VENDOR_SDK_PACKAGES: Record<string, string> = 
    {
        openai    : 'openai',
        anthropic : '@anthropic-ai/sdk',
        gemini    : '@google/genai',
        ollama    : 'ollama'
    };

export async function loadVendorSDK<T = unknown>( packageName: string ): Promise<T>
{
    try
    {
        // Dynamic import of optional peer dependency
        const mod = await import( packageName );

        return mod as T;
    }
    catch
    {
        throw new MissingDependencyError( packageName );
    }
}

export function getVendorPackageName( provider: string ): string
{
    const normalized = provider.toLowerCase();

    return VENDOR_SDK_PACKAGES[normalized] ?? normalized;
}

export interface SDKClientWrapper
{
    client : unknown
    [key: string]: unknown
}

function parseOpenAIUsage( raw: unknown ): UsageMetrics | undefined
{
    if( !raw || typeof raw !== 'object' )
    {
        return undefined;
    }

    const usage = raw as Record<string, unknown>;
    const promptTokens = Number( usage.prompt_tokens ?? 0 );
    const completionTokens = Number( usage.completion_tokens ?? 0 );
    const totalTokens = Number( usage.total_tokens ?? ( promptTokens + completionTokens ) );

    if( !Number.isFinite( promptTokens ) && !Number.isFinite( completionTokens ) )
    {
        return undefined;
    }

    return {
        promptTokens,
        completionTokens,
        totalTokens,
        raw : usage
    };
}

function finalizeBridgeResponse( 
    content: string, 
    usage: UsageMetrics | undefined, 
    raw: unknown 
): ModelResponse
{
    if( usage )
    {
        return {
            content,
            role         : 'assistant',
            usage,
            finishReason : 'stop',
            raw
        };
    }

    return {
        content,
        role         : 'assistant',
        usageMissing : true,
        finishReason : 'stop',
        raw
    };
}

export class SDKBridgeAdapter implements ModelProtocol
{
    public readonly provider : string;
    public readonly model    : string;
    readonly #client         : Record<string, unknown>;

    constructor( provider: string, model: string, client: unknown )
    {
        this.provider = provider;
        this.model = model;
        this.#client = client as Record<string, unknown>;
    }

    public get client(): unknown
    {
        return this.#client;
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        const norm = this.provider.toLowerCase();

        if( norm === 'openai' )
        {
            return this.callOpenAISDK( request );
        }

        if( norm === 'anthropic' )
        {
            return this.callAnthropicSDK( request );
        }

        if( norm === 'gemini' )
        {
            return this.callGeminiSDK( request );
        }

        if( norm === 'ollama' )
        {
            return this.callOllamaSDK( request );
        }

        throw new ProviderError( this.provider, `Unsupported SDK bridge provider '${this.provider}'` );
    }

    public async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        yield* [];

        throw new ProviderError( 
            this.provider, 
            `Streaming via vendor SDK bridge for '${this.provider}' with ${request.messages.length} messages is not supported. Use native fetch adapter.` 
        );
    }

    private async callOpenAISDK( request: ModelRequest ): Promise<ModelResponse>
    {
        const chat = ( this.#client.chat as Record<string, unknown> )?.completions as Record<string, unknown>;

        if( typeof chat?.create !== 'function' )
        {
            throw new ProviderError( 'openai', 'Invalid OpenAI SDK client instance passed to bridge' );
        }

        const messages = request.messages.map( ( m ) => 
        {
            return { role : m.role, content : m.content };
        } );

        const res = await ( chat.create as AnyFn )( {
            model  : this.model,
            messages,
            stream : false,
            ...( request.signal ? { signal : request.signal } : {} )
        } ) as Record<string, unknown>;

        const choices = res.choices as Array<Record<string, unknown>> | undefined;
        const msg = choices?.[0]?.message as Record<string, unknown> | undefined;

        return finalizeBridgeResponse( 
            ( msg?.content as string ) ?? '', 
            parseOpenAIUsage( res.usage ), 
            res 
        );
    }

    private async callAnthropicSDK( request: ModelRequest ): Promise<ModelResponse>
    {
        const messagesApi = this.#client.messages as Record<string, unknown>;

        if( typeof messagesApi?.create !== 'function' )
        {
            throw new ProviderError( 'anthropic', 'Invalid Anthropic SDK client instance passed to bridge' );
        }

        const messages = request.messages.map( ( m ) => 
        {
            return { role : m.role, content : m.content };
        } );

        const res = await ( messagesApi.create as AnyFn )( {
            model      : this.model,
            messages,
            max_tokens : request.maxTokens ?? 4096,
            ...( request.signal ? { signal : request.signal } : {} )
        } ) as Record<string, unknown>;

        const contentBlocks = res.content as Array<Record<string, unknown>> | undefined;
        let content = '';

        if( contentBlocks )
        {
            for( const b of contentBlocks )
            {
                if( b.type === 'text' && b.text )
                {
                    content += b.text;
                }
            }
        }

        const rawUsage = res.usage as Record<string, unknown> | undefined;
        let usage: UsageMetrics | undefined;

        if( rawUsage )
        {
            const promptTokens = Number( rawUsage.input_tokens ?? 0 );
            const completionTokens = Number( rawUsage.output_tokens ?? 0 );
            usage = {
                promptTokens,
                completionTokens,
                totalTokens : promptTokens + completionTokens,
                raw         : rawUsage
            };
        }

        return finalizeBridgeResponse( content, usage, res );
    }

    private async callGeminiSDK( request: ModelRequest ): Promise<ModelResponse>
    {
        const modelsApi = ( this.#client.models as Record<string, unknown> ) ?? this.#client;

        if( typeof modelsApi.generateContent !== 'function' )
        {
            throw new ProviderError( 'gemini', 'Invalid Gemini SDK client instance passed to bridge' );
        }

        const contents = request.messages.map( ( m ) => {return m.content;} ).join( '\n' );
        const res = await ( modelsApi.generateContent as AnyFn )( {
            model : this.model,
            contents,
            ...( request.signal ? { signal : request.signal } : {} )
        } ) as Record<string, unknown>;

        const text = typeof res.text === 'function' ? ( res.text as AnyFn )() : ( res.text ?? '' );
        const rawUsage = ( res.usageMetadata ?? res.usage ) as Record<string, unknown> | undefined;
        let usage: UsageMetrics | undefined;

        if( rawUsage )
        {
            const promptTokens = Number( rawUsage.promptTokenCount ?? rawUsage.prompt_tokens ?? 0 );
            const completionTokens = Number( 
                rawUsage.candidatesTokenCount ?? rawUsage.completion_tokens ?? 0 
            );
            usage = {
                promptTokens,
                completionTokens,
                totalTokens : Number( 
                    rawUsage.totalTokenCount ?? rawUsage.total_tokens ?? ( promptTokens + completionTokens ) 
                ),
                raw : rawUsage
            };
        }

        return finalizeBridgeResponse( ( text as string ) ?? '', usage, res );
    }

    private async callOllamaSDK( request: ModelRequest ): Promise<ModelResponse>
    {
        if( typeof this.#client.chat !== 'function' )
        {
            throw new ProviderError( 'ollama', 'Invalid Ollama SDK client instance passed to bridge' );
        }

        const messages = request.messages.map( ( m ) => 
        {
            return { role : m.role, content : m.content };
        } );

        const res = await ( this.#client.chat as AnyFn )( {
            model : this.model,
            messages,
            ...( request.signal ? { signal : request.signal } : {} )
        } ) as Record<string, unknown>;

        const msg = res.message as Record<string, unknown> | undefined;
        const promptTokens = Number( res.prompt_eval_count ?? 0 );
        const completionTokens = Number( res.eval_count ?? 0 );
        const usage = ( promptTokens > 0 || completionTokens > 0 )
            ? {
                promptTokens,
                completionTokens,
                totalTokens : promptTokens + completionTokens,
                raw         : res
            }
            : undefined;

        return finalizeBridgeResponse( ( msg?.content as string ) ?? '', usage, res );
    }
}

export function createSDKBridge( provider: string, model: string, client: unknown ): ModelProtocol
{
    return new SDKBridgeAdapter( provider, model, client );
}
