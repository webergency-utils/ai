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
import { parseSSEStream, createStreamChunk } from '../core/stream.js';

interface RawGeminiPart
{
    text?: string
    inlineData?: {
        mimeType: string
        data: string
    }
    functionCall?: {
        name: string
        args: Record<string, unknown>
    }
    functionResponse?: {
        name: string
        response: Record<string, unknown>
    }
}

interface RawGeminiCandidate
{
    content?: {
        role?: string
        parts?: RawGeminiPart[]
    }
    finishReason?: string
}

interface RawGeminiUsage
{
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
    [key: string]: unknown
}

interface RawGeminiResponse
{
    candidates?: RawGeminiCandidate[]
    usageMetadata?: RawGeminiUsage
    [key: string]: unknown
}

export class GeminiProviderAdapter extends BaseProviderAdapter
{
    readonly #baseUrl: string;

    constructor( config: ModelConfig )
    {
        super( config );
        this.#baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : true,
            reasoningContent   : false,
            promptCacheControl : false,
            multimodal         : { image : true, audio : true, video : true, document : true }
        };
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        this.assertRequestSupported( request );

        const apiKey = this.getApiKey( 'GEMINI_API_KEY' );
        const payload = this.buildPayload( request );
        const transport = this.resolveTransportOptions( request );
        const url = `${this.#baseUrl}/models/${this.model}:generateContent`;

        const response = await this.request( {
            url,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'   : 'application/json',
                    'x-goog-api-key' : apiKey
                },
                body : JSON.stringify( payload )
            },
            ...transport
        } );

        const data = await response.json() as RawGeminiResponse;
        const candidate = data.candidates?.[0];
        let content = '';
        const toolCalls: ToolCall[] = [];

        if( candidate?.content?.parts )
        {
            let callIndex = 0;

            for( const part of candidate.content.parts )
            {
                if( part.text )
                {
                    content += part.text;
                }

                if( part.functionCall )
                {
                    toolCalls.push( {
                        id        : `gemini_call_${Date.now()}_${callIndex++}`,
                        name      : part.functionCall.name,
                        arguments : part.functionCall.args ?? {}
                    } );
                }
            }
        }

        let finishReason = this.mapFinishReason( candidate?.finishReason );

        if( toolCalls.length > 0 && finishReason === 'stop' )
        {
            finishReason = 'tool_calls';
        }

        const usage = this.parseUsage( data.usageMetadata );

        return {
            content,
            role      : 'assistant',
            toolCalls : toolCalls.length > 0 ? toolCalls : undefined,
            usage,
            finishReason,
            raw       : data
        };
    }

    public async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        this.assertRequestSupported( request );

        const apiKey = this.getApiKey( 'GEMINI_API_KEY' );
        const payload = this.buildPayload( request );
        const transport = this.resolveTransportOptions( request );
        const url = `${this.#baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`;

        const response = await this.request( {
            url,
            init : {
                method  : 'POST',
                headers : {
                    'Content-Type'   : 'application/json',
                    'x-goog-api-key' : apiKey
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

        let toolCallIndex = 0;
        let sawTerminal = false;

        for await ( const event of parseSSEStream( response.body ) )
        {
            if( !event.data )
            {
                continue;
            }

            let chunkData: RawGeminiResponse;

            try
            {
                chunkData = JSON.parse( event.data ) as RawGeminiResponse;
            }
            catch
            {
                continue;
            }

            const candidate = chunkData.candidates?.[0];
            const finishReason = candidate?.finishReason 
                ? this.mapFinishReason( candidate.finishReason ) 
                : undefined;

            if( finishReason )
            {
                sawTerminal = true;
            }

            const usage = chunkData.usageMetadata ? this.parseUsage( chunkData.usageMetadata ) : undefined;

            let deltaContent = '';
            const functionCalls: Array<{ name: string, args: Record<string, unknown> }> = [];

            if( candidate?.content?.parts )
            {
                for( const part of candidate.content.parts )
                {
                    if( part.text )
                    {
                        deltaContent += part.text;
                    }

                    if( part.functionCall )
                    {
                        functionCalls.push( {
                            name : part.functionCall.name,
                            args : part.functionCall.args ?? {}
                        } );
                    }
                }
            }

            if( functionCalls.length > 0 )
            {
                for( let i = 0; i < functionCalls.length; i++ )
                {
                    const fc = functionCalls[i];

                    yield createStreamChunk( i === 0 ? deltaContent : '', {
                        deltaToolCall : {
                            index     : toolCallIndex++,
                            name      : fc.name,
                            arguments : JSON.stringify( fc.args )
                        },
                        finishReason,
                        usage,
                        raw : chunkData
                    } );
                }
            }
            else
            {
                yield createStreamChunk( deltaContent, {
                    finishReason,
                    usage,
                    raw : chunkData
                } );
            }
        }

        if( !sawTerminal )
        {
            throw new ProviderError( 
                this.provider, 
                'Stream ended without a finishReason terminator', 
                response.status 
            );
        }
    }

    protected buildPayload( request: ModelRequest ): Record<string, unknown>
    {
        const { systemParts, contents } = this.formatContents( request );

        const payload: Record<string, unknown> = { contents };

        if( systemParts.length > 0 )
        {
            payload.systemInstruction = { parts : systemParts };
        }

        const generationConfig: Record<string, unknown> = {};
        const temperature = request.temperature ?? this.config.temperature;

        if( temperature !== undefined )
        {
            generationConfig.temperature = temperature;
        }

        const maxTokens = request.maxTokens ?? this.config.maxTokens;

        if( maxTokens !== undefined )
        {
            generationConfig.maxOutputTokens = maxTokens;
        }

        if( this.config.topP !== undefined )
        {
            generationConfig.topP = this.config.topP;
        }

        if( Object.keys( generationConfig ).length > 0 )
        {
            payload.generationConfig = generationConfig;
        }

        if( request.tools && request.tools.length > 0 )
        {
            payload.tools =
                [
                    {
                        functionDeclarations : request.tools.map( ( tool ) => 
                        {
                            return {
                                name        : tool.name,
                                description : tool.description,
                                parameters  : toJsonSchema( tool.parameters )
                            };
                        } )
                    }
                ];

            if( request.toolChoice )
            {
                if( request.toolChoice === 'auto' )
                {
                    payload.toolConfig = { functionCallingConfig : { mode : 'AUTO' } };
                }
                else if( request.toolChoice === 'required' )
                {
                    payload.toolConfig = { functionCallingConfig : { mode : 'ANY' } };
                }
                else if( request.toolChoice === 'none' )
                {
                    payload.toolConfig = { functionCallingConfig : { mode : 'NONE' } };
                }
                else if( typeof request.toolChoice === 'object' && 'name' in request.toolChoice )
                {
                    payload.toolConfig =
                        {
                            functionCallingConfig :
                        {
                            mode                 : 'ANY',
                            allowedFunctionNames : [ request.toolChoice.name ]
                        }
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

    protected formatContents( request: ModelRequest ): {
        systemParts : Array<{ text: string }>
        contents    : Array<Record<string, unknown>>
    }
    {
        const systemParts: Array<{ text: string }> = [];
        const contents: Array<Record<string, unknown>> = [];
        const toolNamesById = new Map<string, string>();

        const configSystem = request.systemPrompt ?? this.config.systemPrompt;

        if( configSystem )
        {
            systemParts.push( { text : configSystem } );
        }

        for( const msg of request.messages )
        {
            if( msg.role === 'system' )
            {
                if( msg.content )
                {
                    systemParts.push( { text : msg.content } );
                }

                continue;
            }

            if( msg.role === 'assistant' && msg.toolCalls )
            {
                for( const tc of msg.toolCalls )
                {
                    toolNamesById.set( tc.id, tc.name );
                }
            }

            const role = msg.role === 'assistant' ? 'model' : 'user';
            const parts: RawGeminiPart[] = [];

            if( msg.role === 'tool' )
            {
                const name = msg.name
                    ?? ( msg.toolCallId ? toolNamesById.get( msg.toolCallId ) : undefined )
                    ?? msg.toolCallId
                    ?? 'unknown';

                parts.push( {
                    functionResponse : {
                        name,
                        response : { result : msg.content }
                    }
                } );
                contents.push( { role : 'user', parts } );
                continue;
            }

            if( msg.content )
            {
                parts.push( { text : msg.content } );
            }

            if( msg.attachments && msg.attachments.length > 0 )
            {
                for( const att of msg.attachments )
                {
                    const base64Data = att.data 
                        ? ( typeof att.data === 'string' ? att.data : Buffer.from( att.data ).toString( 'base64' ) )
                        : '';

                    if( base64Data )
                    {
                        parts.push( {
                            inlineData : {
                                mimeType : att.mimeType,
                                data     : base64Data
                            }
                        } );
                    }
                }
            }

            if( msg.toolCalls && msg.toolCalls.length > 0 )
            {
                for( const tc of msg.toolCalls )
                {
                    parts.push( {
                        functionCall : {
                            name : tc.name,
                            args : tc.arguments
                        }
                    } );
                }
            }

            contents.push( { role, parts } );
        }

        return { systemParts, contents };
    }

    protected parseUsage( rawUsage?: RawGeminiUsage ): UsageMetrics | undefined
    {
        if( !rawUsage )
        {
            return undefined;
        }

        const promptTokens = rawUsage.promptTokenCount ?? 0;
        const completionTokens = rawUsage.candidatesTokenCount ?? 0;
        const totalTokens = rawUsage.totalTokenCount ?? ( promptTokens + completionTokens );
        const thoughts = Number( rawUsage.thoughtsTokenCount ?? 0 );

        return {
            promptTokens,
            completionTokens,
            totalTokens,
            reasoningTokens        : Number.isFinite( thoughts ) && thoughts > 0 ? thoughts : undefined,
            cachedPromptReadTokens : rawUsage.cachedContentTokenCount,
            raw                    : rawUsage
        };
    }

    protected mapFinishReason( reason?: string ): ModelResponse['finishReason']
    {
        switch ( reason )
        {
            case 'STOP':
                return 'stop';
            case 'MAX_TOKENS':
                return 'length';
            case 'SAFETY':
            case 'RECITATION':
                return 'content_filter';
            default:
                return 'other';
        }
    }
}
