import { BaseProviderAdapter } from './base.js';
import type { 
    ModelConfig, 
    ModelRequest, 
    ModelResponse, 
    ModelStreamChunk,
    ChatMessage,
    ToolCall,
    UsageMetrics
} from '../core/types.js';
import { zodToJsonSchema } from '../core/schema.js';
import { parseSSEStream, createStreamChunk } from '../core/stream.js';

interface RawOpenAIToolCall
{
    id?: string
    type?: string
    function?: {
        name?: string
        arguments?: string
    }
}

interface OpenAIChoice
{
    message?: {
        content?: string | null
        tool_calls?: RawOpenAIToolCall[]
    }
    delta?: {
        content?: string
        tool_calls?: Array<{
            index?: number
            id?: string
            function?: {
                name?: string
                arguments?: string
            }
        }>
    }
    finish_reason?: string
}

interface RawOpenAIUsage
{
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: {
        reasoning_tokens?: number
    }
    prompt_tokens_details?: {
        cached_tokens?: number
    }
    [key: string]: unknown
}

interface OpenAIResponse
{
    choices?: OpenAIChoice[]
    usage?: RawOpenAIUsage
}

export class OpenAIProviderAdapter extends BaseProviderAdapter
{
    readonly #baseUrl: string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    }

    protected get defaultEnvVar(): string
    {
        return 'OPENAI_API_KEY';
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        const apiKey = this.getApiKey( this.defaultEnvVar );
        const payload = this.buildPayload( request, false );

        const response = await fetch( `${this.#baseUrl}/chat/completions`, 
            {
                method : 'POST',
                headers : 
            {
                'Content-Type'  : 'application/json',
                'Authorization' : `Bearer ${apiKey}`
            },
                body : JSON.stringify( payload )
            } );

        if( !response.ok )
        {
            await this.handleErrorResponse( response );
        }

        const data = await response.json();
        const choice = data.choices?.[0];
        const message = choice?.message;

        const toolCalls = this.parseToolCalls( message?.tool_calls );
        const usage = this.parseUsage( data.usage );
        const finishReason = this.mapFinishReason( choice?.finish_reason );

        return {
            content   : message?.content ?? '',
            role      : 'assistant',
            toolCalls : toolCalls.length > 0 ? toolCalls : undefined,
            usage,
            finishReason,
            raw       : data
        };
    }

    public async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        const apiKey = this.getApiKey( this.defaultEnvVar );
        const payload = this.buildPayload( request, true );

        const response = await fetch( `${this.#baseUrl}/chat/completions`, 
            {
                method : 'POST',
                headers : 
            {
                'Content-Type'  : 'application/json',
                'Authorization' : `Bearer ${apiKey}`
            },
                body : JSON.stringify( payload )
            } );

        if( !response.ok )
        {
            await this.handleErrorResponse( response );
        }

        if( !response.body )
        {
            return;
        }

        for await ( const event of parseSSEStream( response.body ) )
        {
            if( event.data === '[DONE]' )
            {
                break;
            }

            let chunkData: OpenAIResponse;

            try
            {
                chunkData = JSON.parse( event.data ) as OpenAIResponse;
            }
            catch
            {
                continue;
            }

            const choice = chunkData.choices?.[0];
            const delta = choice?.delta;
            const deltaContent = delta?.content ?? '';
            const finishReason = this.mapFinishReason( choice?.finish_reason );
            const usage = chunkData.usage ? this.parseUsage( chunkData.usage ) : undefined;

            let deltaToolCall: ModelStreamChunk['deltaToolCall'];

            if( delta?.tool_calls && delta.tool_calls.length > 0 )
            {
                const tc = delta.tool_calls[0];
                deltaToolCall = 
                    {
                        index     : tc.index ?? 0,
                        id        : tc.id,
                        name      : tc.function?.name,
                        arguments : tc.function?.arguments
                    };
            }

            yield createStreamChunk( deltaContent, 
                {
                    deltaToolCall,
                    finishReason,
                    usage,
                    raw : chunkData
                } );
        }
    }

    protected buildPayload( request: ModelRequest, isStream: boolean ): Record<string, unknown>
    {
        const messages = this.formatMessages( request );
        const payload: Record<string, unknown> = 
            {
                model  : this.model,
                messages,
                stream : isStream
            };

        if( isStream )
        {
            payload.stream_options = { include_usage : true };
        }

        const temperature = request.temperature ?? this.config.temperature;

        if( temperature !== undefined )
        {
            payload.temperature = temperature;
        }

        const maxTokens = request.maxTokens ?? this.config.maxTokens;

        if( maxTokens !== undefined )
        {
            payload.max_tokens = maxTokens;
        }

        if( this.config.topP !== undefined )
        {
            payload.top_p = this.config.topP;
        }

        if( request.tools && request.tools.length > 0 )
        {
            payload.tools = request.tools.map( ( tool ) => 
            {
                return {
                    type : 'function',
                    function : 
                    {
                        name        : tool.name,
                        description : tool.description,
                        parameters  : zodToJsonSchema( tool.parameters )
                    }
                };
            } );

            if( request.toolChoice )
            {
                if( typeof request.toolChoice === 'string' )
                {
                    payload.tool_choice = request.toolChoice;
                }
                else if( 'name' in request.toolChoice )
                {
                    payload.tool_choice = 
                        {
                            type     : 'function',
                            function : { name : request.toolChoice.name }
                        };
                }
            }
        }

        if( this.config.vendorOptions )
        {
            Object.assign( payload, this.config.vendorOptions );
        }

        if( request.rawOptions )
        {
            Object.assign( payload, request.rawOptions );
        }

        return payload;
    }

    protected formatMessages( request: ModelRequest ): Array<Record<string, unknown>>
    {
        const formatted: Array<Record<string, unknown>> = [];
        const systemPrompt = request.systemPrompt ?? this.config.systemPrompt;
        const hasSystemMsg = request.messages.some( ( m ) => {return m.role === 'system';} );

        if( systemPrompt && !hasSystemMsg )
        {
            formatted.push( { role : 'system', content : systemPrompt } );
        }

        for( const msg of request.messages )
        {
            formatted.push( this.formatSingleMessage( msg ) );
        }

        return formatted;
    }

    protected formatSingleMessage( msg: ChatMessage ): Record<string, unknown>
    {
        if( msg.role === 'tool' )
        {
            return {
                role         : 'tool',
                tool_call_id : msg.toolCallId ?? '',
                content      : msg.content
            };
        }

        if( msg.role === 'assistant' )
        {
            const res: Record<string, unknown> = 
                {
                    role    : 'assistant',
                    content : msg.content || null
                };

            if( msg.toolCalls && msg.toolCalls.length > 0 )
            {
                res.tool_calls = msg.toolCalls.map( ( tc ) => 
                {
                    return {
                        id   : tc.id,
                        type : 'function',
                        function : 
                        {
                            name      : tc.name,
                            arguments : typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify( tc.arguments )
                        }
                    };
                } );
            }

            return res;
        }

        if( msg.attachments && msg.attachments.length > 0 )
        {
            const parts: Array<Record<string, unknown>> = [];

            if( msg.content )
            {
                parts.push( { type : 'text', text : msg.content } );
            }

            for( const att of msg.attachments )
            {
                if( att.type === 'image' )
                {
                    let url = att.url;

                    if( !url && att.data )
                    {
                        const base64Data = typeof att.data === 'string' 
                            ? att.data 
                            : Buffer.from( att.data ).toString( 'base64' );
                        url = `data:${att.mimeType};base64,${base64Data}`;
                    }

                    if( url )
                    {
                        parts.push( { type : 'image_url', image_url : { url } } );
                    }
                }
                else if( att.type === 'audio' && att.data )
                {
                    const base64Data = typeof att.data === 'string'
                        ? att.data
                        : Buffer.from( att.data ).toString( 'base64' );
                    const format = att.mimeType.split( '/' )[1] ?? 'wav';

                    parts.push( 
                        {
                            type        : 'input_audio',
                            input_audio : { data : base64Data, format }
                        } );
                }
            }

            return {
                role    : msg.role,
                content : parts
            };
        }

        return {
            role    : msg.role,
            content : msg.content
        };
    }

    protected parseToolCalls( rawToolCalls?: RawOpenAIToolCall[] ): ToolCall[]
    {
        if( !rawToolCalls || !Array.isArray( rawToolCalls ) )
        {
            return [];
        }

        const parsed: ToolCall[] = [];

        for( const tc of rawToolCalls )
        {
            if( tc.type === 'function' && tc.function )
            {
                let args: Record<string, unknown>;

                try
                {
                    args = typeof tc.function.arguments === 'string' 
                        ? JSON.parse( tc.function.arguments ) 
                        : ( tc.function.arguments ?? {} );
                }
                catch
                {
                    args = {};
                }

                parsed.push( 
                    {
                        id        : tc.id ?? '',
                        name      : tc.function.name ?? '',
                        arguments : args
                    } );
            }
        }

        return parsed;
    }

    protected parseUsage( rawUsage?: RawOpenAIUsage ): UsageMetrics | undefined
    {
        if( !rawUsage )
        {
            return undefined;
        }

        return {
            promptTokens           : rawUsage.prompt_tokens ?? 0,
            completionTokens       : rawUsage.completion_tokens ?? 0,
            totalTokens            : rawUsage.total_tokens ?? 0,
            reasoningTokens        : rawUsage.completion_tokens_details?.reasoning_tokens,
            cachedPromptReadTokens : rawUsage.prompt_tokens_details?.cached_tokens,
            raw                    : rawUsage
        };
    }

    protected mapFinishReason( reason?: string ): ModelResponse['finishReason']
    {
        switch ( reason )
        {
            case 'stop':
                return 'stop';
            case 'tool_calls':
                return 'tool_calls';
            case 'length':
                return 'length';
            case 'content_filter':
                return 'content_filter';
            default:
                return 'other';
        }
    }
}
