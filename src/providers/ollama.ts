import { BaseProviderAdapter } from './base.js';
import type { 
    ModelCapabilities,
    ModelConfig, 
    ModelRequest, 
    ModelResponse, 
    ModelStreamChunk,
    ChatMessage,
    ToolCall,
    UsageMetrics
} from '../core/types.js';
import { toJsonSchema } from '../core/schema.js';
import { ProviderError } from '../core/error.js';
import { parseToolArguments } from '../core/tool-stream.js';
import { createStreamChunk } from '../core/stream.js';
import { createNDJSONDecoder } from '../core/ndjson.js';

interface RawOllamaToolCall
{
    function?: {
        name?: string
        arguments?: Record<string, unknown> | string
    }
}

interface RawOllamaResponse
{
    model?: string
    message?: {
        role?: string
        content?: string
        tool_calls?: RawOllamaToolCall[]
    }
    done?: boolean
    done_reason?: string
    prompt_eval_count?: number
    eval_count?: number
    [key: string]: unknown
}

export class OllamaProviderAdapter extends BaseProviderAdapter
{
    readonly #baseUrl: string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'http://127.0.0.1:11434';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : true,
            reasoningContent   : false,
            promptCacheControl : false,
            multimodal         : { image : true, audio : false, video : false, document : false }
        };
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        this.assertRequestSupported( request );

        const payload = this.buildPayload( request, false );
        const transport = this.resolveTransportOptions( request );

        const response = await this.request( {
            url  : `${this.#baseUrl}/api/chat`,
            init : {
                method  : 'POST',
                headers : { 'Content-Type' : 'application/json' },
                body    : JSON.stringify( payload )
            },
            ...transport
        } );

        const data = await response.json() as RawOllamaResponse;
        const message = data.message;
        const toolCalls = this.parseToolCalls( message?.tool_calls );
        const usage = this.parseUsage( data );
        const finishReason = this.mapFinishReason( data.done_reason, toolCalls.length > 0 );

        return {
            content   : message?.content ?? '',
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

        const payload = this.buildPayload( request, true );
        const transport = this.resolveTransportOptions( request );

        const response = await this.request( {
            url  : `${this.#baseUrl}/api/chat`,
            init : {
                method  : 'POST',
                headers : { 'Content-Type' : 'application/json' },
                body    : JSON.stringify( payload )
            },
            stream : true,
            ...transport
        } );

        if( !response.body )
        {
            throw new ProviderError( this.provider, 'Stream response had no body', response.status );
        }

        const reader = response.body.getReader();
        const textDecoder = new TextDecoder();
        const ndjson = createNDJSONDecoder();
        let sawDone = false;

        const parseLine = ( trimmed: string ): ModelStreamChunk | undefined => 
        {
            let chunkData: RawOllamaResponse;

            try
            {
                chunkData = JSON.parse( trimmed ) as RawOllamaResponse;
            }
            catch
            {
                return undefined;
            }

            const deltaContent = chunkData.message?.content ?? '';
            const toolCalls = this.parseToolCalls( chunkData.message?.tool_calls );
            const isDone = chunkData.done ?? false;

            if( isDone )
            {
                sawDone = true;
            }

            const finishReason = isDone 
                ? this.mapFinishReason( chunkData.done_reason, toolCalls.length > 0 ) 
                : undefined;
            const usage = isDone ? this.parseUsage( chunkData ) : undefined;

            return createStreamChunk( deltaContent, 
                {
                    toolCalls : toolCalls.length > 0 ? toolCalls : undefined,
                    finishReason,
                    usage,
                    raw       : chunkData
                } );
        };

        try
        {
            while( true )
            {
                const { done, value } = await reader.read();

                if( done )
                {
                    break;
                }

                for( const line of ndjson.push( textDecoder.decode( value, { stream : true } ) ) )
                {
                    const chunk = parseLine( line );

                    if( chunk )
                    {
                        yield chunk;
                    }
                }
            }

            const tail = textDecoder.decode();

            if( tail )
            {
                for( const line of ndjson.push( tail ) )
                {
                    const chunk = parseLine( line );

                    if( chunk )
                    {
                        yield chunk;
                    }
                }
            }

            for( const line of ndjson.flush() )
            {
                const chunk = parseLine( line );

                if( chunk )
                {
                    yield chunk;
                }
            }
        }
        finally
        {
            try
            {
                await reader.cancel();
            }
            catch
            {
                // Already closed.
            }

            try
            {
                reader.releaseLock();
            }
            catch
            {
                // Already released.
            }
        }

        if( !sawDone )
        {
            throw new ProviderError( 
                this.provider, 
                'Stream ended without done:true terminator', 
                response.status 
            );
        }
    }

    protected buildPayload( request: ModelRequest, isStream: boolean ): Record<string, unknown>
    {
        const messages = this.formatMessages( request );
        const options: Record<string, unknown> = {};

        const temperature = request.temperature ?? this.config.temperature;

        if( temperature !== undefined )
        {
            options.temperature = temperature;
        }

        const maxTokens = request.maxTokens ?? this.config.maxTokens;

        if( maxTokens !== undefined )
        {
            options.num_predict = maxTokens;
        }

        if( this.config.topP !== undefined )
        {
            options.top_p = this.config.topP;
        }

        const payload: Record<string, unknown> = 
            {
                model  : this.model,
                messages,
                stream : isStream
            };

        if( Object.keys( options ).length > 0 )
        {
            payload.options = options;
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
                        parameters  : toJsonSchema( tool.parameters )
                    }
                };
            } );
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
        const out: Record<string, unknown> = 
            {
                role    : msg.role,
                content : msg.content
            };

        if( msg.attachments && msg.attachments.length > 0 )
        {
            const images: string[] = [];

            for( const att of msg.attachments )
            {
                if( att.type === 'image' )
                {
                    if( att.data )
                    {
                        const b64 = typeof att.data === 'string' 
                            ? att.data 
                            : Buffer.from( att.data ).toString( 'base64' );
                        images.push( b64 );
                    }
                }
            }

            if( images.length > 0 )
            {
                out.images = images;
            }
        }

        return out;
    }

    protected parseToolCalls( rawToolCalls?: RawOllamaToolCall[] ): ToolCall[]
    {
        if( !rawToolCalls || !Array.isArray( rawToolCalls ) )
        {
            return [];
        }

        const parsed: ToolCall[] = [];
        let index = 0;

        for( const tc of rawToolCalls )
        {
            if( tc.function?.name )
            {
                parsed.push( 
                    {
                        id        : `ollama_call_${index++}`,
                        name      : tc.function.name,
                        arguments : parseToolArguments( this.provider, tc.function.name, tc.function.arguments )
                    } );
            }
        }

        return parsed;
    }

    protected parseUsage( rawResponse: RawOllamaResponse ): UsageMetrics | undefined
    {
        const promptTokens = rawResponse.prompt_eval_count ?? 0;
        const completionTokens = rawResponse.eval_count ?? 0;

        if( promptTokens === 0 && completionTokens === 0 )
        {
            return undefined;
        }

        return {
            promptTokens,
            completionTokens,
            totalTokens : promptTokens + completionTokens,
            raw         : rawResponse
        };
    }

    protected mapFinishReason( reason?: string, hasTools?: boolean ): ModelResponse['finishReason']
    {
        if( hasTools )
        {
            return 'tool_calls';
        }

        switch ( reason )
        {
            case 'stop':
                return 'stop';
            case 'length':
                return 'length';
            default:
                return 'stop';
        }
    }
}
