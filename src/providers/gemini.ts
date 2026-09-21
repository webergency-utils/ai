import { BaseProviderAdapter } from './base.js';
import type { 
    ModelConfig, 
    ModelRequest, 
    ModelResponse, 
    ModelStreamChunk,
    ToolCall,
    UsageMetrics
} from '../core/types.js';
import { toJsonSchema } from '../core/schema.js';
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

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        const apiKey = this.getApiKey( 'GEMINI_API_KEY' );
        const payload = this.buildPayload( request );
        const url = `${this.#baseUrl}/models/${this.model}:generateContent`;

        const response = await fetch( url, 
            {
                method : 'POST',
                headers : 
            {
                'Content-Type'   : 'application/json',
                'x-goog-api-key' : apiKey
            },
                body : JSON.stringify( payload )
            } );

        if( !response.ok )
        {
            await this.handleErrorResponse( response );
        }

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
                    toolCalls.push( 
                        {
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
        const apiKey = this.getApiKey( 'GEMINI_API_KEY' );
        const payload = this.buildPayload( request );
        const url = `${this.#baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`;

        const response = await fetch( url, 
            {
                method : 'POST',
                headers : 
            {
                'Content-Type'   : 'application/json',
                'x-goog-api-key' : apiKey
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
            let deltaContent = '';
            let deltaToolCall: ModelStreamChunk['deltaToolCall'];

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
                        deltaToolCall = 
                            {
                                index     : 0,
                                name      : part.functionCall.name,
                                arguments : JSON.stringify( part.functionCall.args ?? {} )
                            };
                    }
                }
            }

            const finishReason = candidate?.finishReason 
                ? this.mapFinishReason( candidate.finishReason ) 
                : undefined;
            const usage = chunkData.usageMetadata ? this.parseUsage( chunkData.usageMetadata ) : undefined;

            yield createStreamChunk( deltaContent, 
                {
                    deltaToolCall,
                    finishReason,
                    usage,
                    raw : chunkData
                } );
        }
    }

    protected buildPayload( request: ModelRequest ): Record<string, unknown>
    {
        const contents = this.formatContents( request );
        const systemPrompt = request.systemPrompt ?? this.config.systemPrompt;

        const payload: Record<string, unknown> = { contents };

        if( systemPrompt )
        {
            payload.systemInstruction = 
                {
                    parts : [ { text : systemPrompt } ]
                };
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

    protected formatContents( request: ModelRequest ): Array<Record<string, unknown>>
    {
        const contents: Array<Record<string, unknown>> = [];

        for( const msg of request.messages )
        {
            if( msg.role === 'system' )
            {
                // Handled via systemInstruction
                continue;
            }

            const role = msg.role === 'assistant' ? 'model' : 'user';
            const parts: RawGeminiPart[] = [];

            if( msg.role === 'tool' )
            {
                parts.push( 
                    {
                        functionResponse : 
                    {
                        name     : msg.name ?? msg.toolCallId ?? 'unknown',
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
                        parts.push( 
                            {
                                inlineData : 
                            {
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
                    parts.push( 
                        {
                            functionCall : 
                        {
                            name : tc.name,
                            args : tc.arguments
                        }
                        } );
                }
            }

            contents.push( { role, parts } );
        }

        return contents;
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

        return {
            promptTokens,
            completionTokens,
            totalTokens,
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
