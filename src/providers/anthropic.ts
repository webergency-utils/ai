import { BaseProviderAdapter } from './base.js';
import type { 
    ModelCapabilities,
    ModelConfig, 
    ModelRequest, 
    ModelResponse, 
    ModelStreamChunk,
    ToolCall,
    UsageMetrics
} from '../core/types.js';
import { toJsonSchema } from '../core/schema.js';
import { ProviderError } from '../core/error.js';
import { toAnthropicBlocks } from '../core/multimodal.js';
import { parseToolArguments } from '../core/tool-stream.js';
import { parseSSEStream, createStreamChunk } from '../core/stream.js';

interface RawAnthropicUsage
{
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    [key: string]: unknown
}

interface RawAnthropicContentBlock
{
    type: 'text' | 'tool_use' | 'thinking'
    text?: string
    thinking?: string
    id?: string
    name?: string
    input?: Record<string, unknown>
}

interface RawAnthropicResponse
{
    id?: string
    type?: string
    role?: string
    content?: RawAnthropicContentBlock[]
    stop_reason?: string
    usage?: RawAnthropicUsage
}

export class AnthropicProviderAdapter extends BaseProviderAdapter
{
    readonly #baseUrl: string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : false,
            reasoningContent   : false,
            promptCacheControl : true,
            multimodal         : { image : true, audio : false, video : false, document : true }
        };
    }

    protected override get supportsMessageCacheControl(): boolean
    {
        return true;
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        this.assertRequestSupported( request );

        const apiKey = this.getApiKey( 'ANTHROPIC_API_KEY' );
        const payload = this.buildPayload( request, false );
        const transport = this.resolveTransportOptions( request );

        const response = await this.request( {
            url  : `${this.#baseUrl}/v1/messages`,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'      : 'application/json',
                    'x-api-key'         : apiKey,
                    'anthropic-version' : '2023-06-01',
                    'anthropic-beta'    : 'prompt-caching-2024-07-31,output-128k-2025-02-19'
                },
                body : JSON.stringify( payload )
            },
            ...transport
        } );

        const data = await response.json() as RawAnthropicResponse;
        let content = '';
        const toolCalls: ToolCall[] = [];

        if( data.content && Array.isArray( data.content ) )
        {
            for( const block of data.content )
            {
                if( block.type === 'text' && block.text )
                {
                    content += block.text;
                }
                else if( block.type === 'tool_use' )
                {
                    const name = block.name ?? '';

                    toolCalls.push( 
                        {
                            id        : block.id ?? '',
                            name,
                            arguments : parseToolArguments( this.provider, name, block.input )
                        } );
                }
            }
        }

        const finishReason = this.mapFinishReason( data.stop_reason );
        const usage = this.parseUsage( data.usage );

        return {
            content,
            role      : 'assistant',
            toolCalls : toolCalls.length > 0 ? toolCalls : undefined,
            usage,
            finishReason,
            raw       : data
        };
    }

    public stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        return this.finalizeChunks( request, this.streamChunks( request ) );
    }

    protected async* streamChunks( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        this.assertRequestSupported( request );

        const apiKey = this.getApiKey( 'ANTHROPIC_API_KEY' );
        const payload = this.buildPayload( request, true );
        const transport = this.resolveTransportOptions( request );

        const response = await this.request( {
            url  : `${this.#baseUrl}/v1/messages`,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'      : 'application/json',
                    'x-api-key'         : apiKey,
                    'anthropic-version' : '2023-06-01',
                    'anthropic-beta'    : 'prompt-caching-2024-07-31,output-128k-2025-02-19'
                },
                body : JSON.stringify( payload )
            },
            stream : true,
            ...transport
        } );

        if( !response.body )
        {
            throw new ProviderError( this.provider, 'Stream response had no body', response.status );
        }

        let accumulatedUsage: RawAnthropicUsage = {};
        const activeToolCalls = new Map<number, { id: string, name: string }>();
        let sawMessageStop = false;

        for await ( const event of parseSSEStream( response.body ) )
        {
            if( event.event === 'error' || ( event.data && event.data.includes( '"type":"error"' ) ) )
            {
                let errorMessage = 'Stream error from provider';

                try
                {
                    const parsed = JSON.parse( event.data ) as { error?: { message?: string }, message?: string };
                    errorMessage = parsed.error?.message ?? parsed.message ?? errorMessage;
                }
                catch
                {
                    // Keep default message.
                }

                throw new ProviderError( this.provider, errorMessage, 200, event.data );
            }

            if( !event.data )
            {
                continue;
            }

            let eventData: Record<string, unknown>;

            try
            {
                eventData = JSON.parse( event.data );
            }
            catch
            {
                continue;
            }

            const eventType = ( eventData.type as string ) ?? event.event;

            if( eventType === 'error' )
            {
                const errObj = eventData.error as { message?: string } | undefined;
                throw new ProviderError( 
                    this.provider, 
                    errObj?.message ?? 'Stream error from provider', 
                    200, 
                    eventData 
                );
            }

            if( eventType === 'message_start' )
            {
                const msg = eventData.message as Record<string, unknown> | undefined;

                if( msg?.usage )
                {
                    accumulatedUsage = { ...accumulatedUsage, ...( msg.usage as RawAnthropicUsage ) };
                }
                continue;
            }

            if( eventType === 'content_block_start' )
            {
                const block = eventData.content_block as RawAnthropicContentBlock | undefined;
                const index = ( eventData.index as number ) ?? 0;

                if( block?.type === 'tool_use' )
                {
                    activeToolCalls.set( index, { id : block.id ?? '', name : block.name ?? '' } );
                    yield createStreamChunk( '', 
                        {
                            deltaToolCall : 
                        {
                            index,
                            id        : block.id,
                            name      : block.name,
                            arguments : ''
                        },
                            raw : eventData
                        } );
                }
                continue;
            }

            if( eventType === 'content_block_delta' )
            {
                const delta = eventData.delta as Record<string, unknown> | undefined;
                const index = ( eventData.index as number ) ?? 0;

                if( delta?.type === 'text_delta' && typeof delta.text === 'string' )
                {
                    yield createStreamChunk( delta.text, { raw : eventData } );
                }
                else if( delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' )
                {
                    const toolInfo = activeToolCalls.get( index );

                    yield createStreamChunk( '', 
                        {
                            deltaToolCall : 
                        {
                            index,
                            id        : toolInfo?.id,
                            name      : toolInfo?.name,
                            arguments : delta.partial_json
                        },
                            raw : eventData
                        } );
                }
                continue;
            }

            if( eventType === 'message_delta' )
            {
                const delta = eventData.delta as Record<string, unknown> | undefined;
                const stopReason = delta?.stop_reason as string | undefined;

                if( eventData.usage )
                {
                    accumulatedUsage = { ...accumulatedUsage, ...( eventData.usage as RawAnthropicUsage ) };
                }

                yield createStreamChunk( '', 
                    {
                        finishReason : this.mapFinishReason( stopReason ),
                        usage        : this.parseUsage( accumulatedUsage ),
                        raw          : eventData
                    } );
                continue;
            }

            if( eventType === 'message_stop' )
            {
                sawMessageStop = true;
                break;
            }
        }

        if( !sawMessageStop )
        {
            throw new ProviderError( 
                this.provider, 
                'Stream ended without message_stop terminator', 
                response.status 
            );
        }
    }

    protected buildPayload( request: ModelRequest, isStream: boolean ): Record<string, unknown>
    {
        const { system, messages } = this.formatMessagesAndSystem( request );
        const maxTokens = request.maxTokens ?? this.config.maxTokens ?? 4096;

        const payload: Record<string, unknown> = 
            {
                model      : this.model,
                max_tokens : maxTokens,
                messages,
                stream     : isStream
            };

        if( system )
        {
            payload.system = system;
        }

        const temperature = request.temperature ?? this.config.temperature;

        if( temperature !== undefined )
        {
            payload.temperature = temperature;
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
                    name         : tool.name,
                    description  : tool.description,
                    input_schema : toJsonSchema( tool.parameters )
                };
            } );

            if( request.toolChoice )
            {
                if( request.toolChoice === 'auto' )
                {
                    payload.tool_choice = { type : 'auto' };
                }
                else if( request.toolChoice === 'required' )
                {
                    payload.tool_choice = { type : 'any' };
                }
                else if( typeof request.toolChoice === 'object' && 'name' in request.toolChoice )
                {
                    payload.tool_choice = { type : 'tool', name : request.toolChoice.name };
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

    protected formatMessagesAndSystem( request: ModelRequest ): { system?: string, messages: Array<Record<string, unknown>> }
    {
        let system = request.systemPrompt ?? this.config.systemPrompt;
        const messages: Array<Record<string, unknown>> = [];

        for( const msg of request.messages )
        {
            if( msg.role === 'system' )
            {
                system = system ? `${system}\n\n${msg.content}` : msg.content;
                continue;
            }

            if( msg.role === 'tool' )
            {
                messages.push( 
                    {
                        role : 'user',
                        content : 
                    [
                        {
                            type        : 'tool_result',
                            tool_use_id : msg.toolCallId ?? '',
                            content     : msg.content
                        }
                    ]
                    } );
                continue;
            }

            if( msg.role === 'assistant' )
            {
                const blocks: Array<Record<string, unknown>> = [];

                if( msg.content )
                {
                    blocks.push( { type : 'text', text : msg.content } );
                }

                if( msg.toolCalls && msg.toolCalls.length > 0 )
                {
                    for( const tc of msg.toolCalls )
                    {
                        blocks.push( 
                            {
                                type  : 'tool_use',
                                id    : tc.id,
                                name  : tc.name,
                                input : tc.arguments
                            } );
                    }
                }

                messages.push( { role : 'assistant', content : blocks.length > 0 ? blocks : '' } );
                continue;
            }

            if( msg.attachments && msg.attachments.length > 0 )
            {
                messages.push( { 
                    role    : 'user', 
                    content : toAnthropicBlocks( this.provider, msg.content, msg.attachments ) 
                } );
                continue;
            }

            messages.push( { role : 'user', content : msg.content } );
        }

        return { system, messages };
    }

    protected parseUsage( rawUsage?: RawAnthropicUsage ): UsageMetrics | undefined
    {
        if( !rawUsage )
        {
            return undefined;
        }

        const inputTokens = rawUsage.input_tokens ?? 0;
        const outputTokens = rawUsage.output_tokens ?? 0;

        return {
            promptTokens            : inputTokens,
            completionTokens        : outputTokens,
            totalTokens             : inputTokens + outputTokens,
            cachedPromptReadTokens  : rawUsage.cache_read_input_tokens,
            cachedPromptWriteTokens : rawUsage.cache_creation_input_tokens,
            raw                     : rawUsage
        };
    }

    protected mapFinishReason( reason?: string ): ModelResponse['finishReason']
    {
        switch ( reason )
        {
            case 'end_turn':
            case 'stop_sequence':
                return 'stop';
            case 'tool_use':
                return 'tool_calls';
            case 'max_tokens':
                return 'length';
            default:
                return 'other';
        }
    }
}
