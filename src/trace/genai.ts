import { AIError } from '../core/error.js';
import type { Span, SpanAttributeValue } from './types.js';

/**
 * OpenTelemetry GenAI semantic-convention attribute names (still experimental upstream).
 * Every name lives here, so an upstream rename is a one-line edit.
 */
export const GENAI_ATTR = 
    {
        OPERATION_NAME                 : 'gen_ai.operation.name',
        PROVIDER_NAME                  : 'gen_ai.provider.name',
        /** Pre-1.37 name of {@link GENAI_ATTR.PROVIDER_NAME}; emitted on request via `genaiCompat`. */
        SYSTEM_LEGACY                  : 'gen_ai.system',
        REQUEST_MODEL                  : 'gen_ai.request.model',
        REQUEST_TEMPERATURE            : 'gen_ai.request.temperature',
        REQUEST_MAX_TOKENS             : 'gen_ai.request.max_tokens',
        REQUEST_TOP_P                  : 'gen_ai.request.top_p',
        RESPONSE_FINISH_REASONS        : 'gen_ai.response.finish_reasons',
        USAGE_INPUT_TOKENS             : 'gen_ai.usage.input_tokens',
        USAGE_OUTPUT_TOKENS            : 'gen_ai.usage.output_tokens',
        USAGE_PROMPT_TOKENS_LEGACY     : 'gen_ai.usage.prompt_tokens',
        USAGE_COMPLETION_TOKENS_LEGACY : 'gen_ai.usage.completion_tokens',
        USAGE_CACHE_READ_TOKENS        : 'gen_ai.usage.cache_read.input_tokens',
        USAGE_CACHE_CREATION_TOKENS    : 'gen_ai.usage.cache_creation.input_tokens',
        USAGE_REASONING_TOKENS         : 'gen_ai.usage.reasoning.output_tokens',
        EMBEDDINGS_DIMENSIONS          : 'gen_ai.embeddings.dimension.count',
        TOOL_NAME                      : 'gen_ai.tool.name',
        TOOL_CALL_ID                   : 'gen_ai.tool.call.id',
        TOOL_TYPE                      : 'gen_ai.tool.type',
        AGENT_ID                       : 'gen_ai.agent.id',
        AGENT_NAME                     : 'gen_ai.agent.name',
        CONVERSATION_ID                : 'gen_ai.conversation.id',
        INPUT_MESSAGES                 : 'gen_ai.input.messages',
        OUTPUT_MESSAGES                : 'gen_ai.output.messages',
        ERROR_TYPE                     : 'error.type'
    } as const;

export type GenAIOperation = 'chat' | 'embeddings' | 'execute_tool' | 'invoke_agent';

/** How the exporter spells provider/usage attributes. `latest` follows the current registry. */
export type GenAICompat = 'latest' | 'legacy' | 'both';

/** Library provider ids to registered semconv `gen_ai.provider.name` values. Unknown ids pass through verbatim. */
export const GENAI_PROVIDER_NAMES: ReadonlyMap<string, string> = new Map( 
    [
        [ 'openai', 'openai' ],
        [ 'anthropic', 'anthropic' ],
        [ 'gemini', 'gcp.gemini' ],
        [ 'google', 'gcp.gemini' ],
        [ 'vertex', 'gcp.vertex_ai' ],
        [ 'mistral', 'mistral_ai' ],
        [ 'groq', 'groq' ],
        [ 'deepseek', 'deepseek' ],
        [ 'xai', 'x_ai' ],
        [ 'cohere', 'cohere' ],
        [ 'perplexity', 'perplexity' ],
        [ 'azure', 'azure.ai.openai' ],
        [ 'bedrock', 'aws.bedrock' ]
    ] );

export function toGenAIProvider( provider: string ): string
{
    return GENAI_PROVIDER_NAMES.get( provider.toLowerCase() ) ?? provider;
}

export interface GenAIModelRequestInfo
{
    temperature? : number
    maxTokens?   : number
    topP?        : number
}

export interface GenAIModelResponseInfo
{
    finishReason? : string
    usage?        : 
    {
        promptTokens?            : number
        completionTokens?        : number
        reasoningTokens?         : number
        cachedPromptReadTokens?  : number
        cachedPromptWriteTokens? : number
    }
    /** Number of vectors / dimension of the first vector, for embeddings. */
    dimensions?   : number
}

export interface ModelCallAttributes
{
    provider   : string
    model      : string
    /** Defaults to `chat`. */
    operation? : 'chat' | 'embeddings'
    request?   : GenAIModelRequestInfo
    response?  : GenAIModelResponseInfo
}

function setFinite( span: Span, key: string, value: number | undefined ): void
{
    if( typeof value === 'number' && Number.isFinite( value ) )
    {
        span.setAttribute( key, value );
    }
}

/**
 * Sets GenAI attributes on a model span and keeps the legacy `model.provider` / `model.name` names.
 * Safe to call before the request (request info) and again after it (response info): usage gaps stay gaps,
 * a missing counter never becomes a zero.
 */
export function applyModelCallAttributes( span: Span, info: ModelCallAttributes ): void
{
    span.setAttribute( 'model.provider', info.provider );
    span.setAttribute( 'model.name', info.model );
    span.setAttribute( GENAI_ATTR.OPERATION_NAME, info.operation ?? 'chat' );
    span.setAttribute( GENAI_ATTR.PROVIDER_NAME, toGenAIProvider( info.provider ) );
    span.setAttribute( GENAI_ATTR.REQUEST_MODEL, info.model );

    setFinite( span, GENAI_ATTR.REQUEST_TEMPERATURE, info.request?.temperature );
    setFinite( span, GENAI_ATTR.REQUEST_MAX_TOKENS, info.request?.maxTokens );
    setFinite( span, GENAI_ATTR.REQUEST_TOP_P, info.request?.topP );

    const response = info.response;

    if( !response )
    {
        return;
    }

    if( response.finishReason )
    {
        span.setAttribute( GENAI_ATTR.RESPONSE_FINISH_REASONS, [ response.finishReason ] );
    }

    setFinite( span, GENAI_ATTR.EMBEDDINGS_DIMENSIONS, response.dimensions );
    setFinite( span, GENAI_ATTR.USAGE_INPUT_TOKENS, response.usage?.promptTokens );
    setFinite( span, GENAI_ATTR.USAGE_OUTPUT_TOKENS, response.usage?.completionTokens );
    setFinite( span, GENAI_ATTR.USAGE_CACHE_READ_TOKENS, response.usage?.cachedPromptReadTokens );
    setFinite( span, GENAI_ATTR.USAGE_CACHE_CREATION_TOKENS, response.usage?.cachedPromptWriteTokens );
    setFinite( span, GENAI_ATTR.USAGE_REASONING_TOKENS, response.usage?.reasoningTokens );
}

export function applyToolAttributes( span: Span, info: { name: string, callId?: string } ): void
{
    span.setAttribute( GENAI_ATTR.OPERATION_NAME, 'execute_tool' );
    span.setAttribute( GENAI_ATTR.TOOL_NAME, info.name );
    span.setAttribute( GENAI_ATTR.TOOL_TYPE, 'function' );

    if( info.callId )
    {
        span.setAttribute( GENAI_ATTR.TOOL_CALL_ID, info.callId );
    }
}

export function applyAgentAttributes( span: Span, info: { id: string, threadId?: string, name?: string } ): void
{
    span.setAttribute( GENAI_ATTR.OPERATION_NAME, 'invoke_agent' );
    span.setAttribute( GENAI_ATTR.AGENT_ID, info.id );

    if( info.name )
    {
        span.setAttribute( GENAI_ATTR.AGENT_NAME, info.name );
    }

    if( info.threadId )
    {
        span.setAttribute( GENAI_ATTR.CONVERSATION_ID, info.threadId );
    }
}

function str( value: SpanAttributeValue | undefined ): string | undefined
{
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function num( value: number | undefined ): number | undefined
{
    return typeof value === 'number' && Number.isFinite( value ) ? value : undefined;
}

/**
 * Export-time projection: derives GenAI attributes for spans that were created without them
 * (older traces, third-party spans using the legacy `model.*` / `tool.name` / `metrics.*` names).
 * Never overrides an attribute that is already present.
 */
export function projectGenAIAttributes( span: Span ): Record<string, SpanAttributeValue>
{
    const attrs = span.attributes;
    const out: Record<string, SpanAttributeValue> = {};
    const add = ( key: string, value: SpanAttributeValue | undefined ): void => 
    {
        if( value !== undefined && attrs[key] === undefined )
        {
            out[key] = value;
        }
    };

    if( span.kind === 'model' )
    {
        const provider = str( attrs['model.provider'] );
        const model = str( attrs['model.name'] );
        const embedding = span.name.startsWith( 'model:embed' );

        if( provider || model || attrs[GENAI_ATTR.OPERATION_NAME] )
        {
            add( GENAI_ATTR.OPERATION_NAME, embedding ? 'embeddings' : 'chat' );
            add( GENAI_ATTR.PROVIDER_NAME, provider ? toGenAIProvider( provider ) : undefined );
            add( GENAI_ATTR.REQUEST_MODEL, model );
            add( GENAI_ATTR.USAGE_INPUT_TOKENS, num( span.metrics.promptTokens ) );
            add( GENAI_ATTR.USAGE_OUTPUT_TOKENS, num( span.metrics.completionTokens ) );
            add( GENAI_ATTR.USAGE_CACHE_READ_TOKENS, num( span.metrics.cachedTokens ) );
            add( GENAI_ATTR.USAGE_REASONING_TOKENS, num( span.metrics.reasoningTokens ) );
        }
    }
    else if( span.kind === 'tool' )
    {
        const tool = str( attrs['tool.name'] );

        if( tool )
        {
            add( GENAI_ATTR.OPERATION_NAME, 'execute_tool' );
            add( GENAI_ATTR.TOOL_NAME, tool );
        }
    }
    else if( span.kind === 'mcp' )
    {
        add( GENAI_ATTR.TOOL_NAME, str( attrs['mcp.tool'] ) );
    }
    else if( span.kind === 'agent' )
    {
        const id = str( attrs['agent.id'] );

        if( id )
        {
            add( GENAI_ATTR.OPERATION_NAME, 'invoke_agent' );
            add( GENAI_ATTR.AGENT_ID, id );
            add( GENAI_ATTR.CONVERSATION_ID, str( attrs['agent.threadId'] ) );
        }
    }

    return out;
}

/**
 * Semconv span name for a span (`chat {model}`, `execute_tool {tool}`, `invoke_agent {agent}`),
 * or the native name when the span carries no GenAI operation. `extra` are projected attributes.
 */
export function toGenAISpanName( span: Span, extra: Record<string, SpanAttributeValue> = {} ): string
{
    const get = ( key: string ): string | undefined => {return str( span.attributes[key] ) ?? str( extra[key] );};
    const operation = get( GENAI_ATTR.OPERATION_NAME );

    switch ( operation )
    {
        case 'chat':
        case 'embeddings':
        {
            const model = get( GENAI_ATTR.REQUEST_MODEL );

            return model ? `${operation} ${model}` : operation;
        }

        case 'execute_tool':
        {
            const tool = get( GENAI_ATTR.TOOL_NAME );

            return tool ? `execute_tool ${tool}` : operation;
        }

        case 'invoke_agent':
        {
            const agent = get( GENAI_ATTR.AGENT_NAME ) ?? get( GENAI_ATTR.AGENT_ID );

            return agent ? `invoke_agent ${agent}` : operation;
        }

        default:
            return span.name;
    }
}

/* ------------------------------------------------------------------------------------------------
 * Privacy: opt-in content capture, redaction, truncation and secret scrubbing
 * ---------------------------------------------------------------------------------------------- */

export const CONTENT_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set( [ GENAI_ATTR.INPUT_MESSAGES, GENAI_ATTR.OUTPUT_MESSAGES ] );

export const DEFAULT_MAX_CONTENT_BYTES = 16 * 1024;
export const TRUNCATION_MARKER = '...truncated';

/** Opt-in capture of prompts and completions. Off by default; `redact` is mandatory when on. */
export interface ContentCaptureOptions
{
    captureContent? : boolean
    /** Applied to every captured text before truncation. Required when `captureContent` is true. */
    redact?         : ( content: string ) => string
    /** UTF-8 byte cap per captured attribute. Default 16 KiB. */
    maxContentBytes?: number
}

export type ContentCaptureConfig = Readonly<ContentCaptureOptions>;

/** Fails loudly when capture is enabled without a redactor (never capture unredacted content by accident). */
export function assertCaptureConfig( options: ContentCaptureOptions | undefined, owner: string ): void
{
    if( options?.captureContent && typeof options.redact !== 'function' )
    {
        throw new AIError( `${owner}: captureContent requires a \`redact( content ) => content\` function`, 'TRACE_CAPTURE_CONFIG' );
    }

    if( options?.maxContentBytes !== undefined && ( !Number.isFinite( options.maxContentBytes ) || options.maxContentBytes <= 0 ) )
    {
        throw new AIError( `${owner}: maxContentBytes must be a positive finite number`, 'TRACE_CAPTURE_CONFIG' );
    }
}

/** Truncates to `maxBytes` UTF-8 bytes (never splitting a character) and appends the marker. */
export function truncateContent( text: string, maxBytes: number ): string
{
    const bytes = Buffer.from( text, 'utf8' );

    if( bytes.length <= maxBytes )
    {
        return text;
    }

    let cut = Math.floor( maxBytes );

    // Step back over UTF-8 continuation bytes so a multi-byte character is not split.
    while( cut > 0 && ( bytes[cut]! & 0xC0 ) === 0x80 )
    {
        cut--;
    }

    return bytes.subarray( 0, cut ).toString( 'utf8' ) + TRUNCATION_MARKER;
}

export interface GenAIMessage
{
    role  : string
    parts : Array<Record<string, unknown>>
    finish_reason? : string
}

export interface CapturableMessage
{
    role        : string
    content     : string
    toolCallId? : string
    toolCalls?  : Array<{ id: string, name: string, arguments: unknown }>
}

/** Converts chat messages to the semconv `gen_ai.*.messages` JSON shape, redacting every text. */
export function toGenAIMessages( messages: CapturableMessage[], redact: ( content: string ) => string, finishReason?: string ): GenAIMessage[]
{
    return messages.map( ( message ) => 
    {
        const parts: Array<Record<string, unknown>> = [];

        if( message.role === 'tool' )
        {
            parts.push( { type : 'tool_call_response', id : message.toolCallId, response : redact( message.content ) } );
        }
        else if( message.content )
        {
            parts.push( { type : 'text', content : redact( message.content ) } );
        }

        for( const call of message.toolCalls ?? [] )
        {
            parts.push( { type : 'tool_call', id : call.id, name : call.name, arguments : redact( JSON.stringify( call.arguments ) ) } );
        }

        return { role : message.role, parts, ...( finishReason ? { finish_reason : finishReason } : {} ) };
    } );
}

/**
 * Sets a content attribute (`gen_ai.input.messages` / `gen_ai.output.messages`) when capture is enabled.
 * Returns whether anything was captured. A throwing redactor fails closed: nothing is captured.
 */
export function captureContent( 
    span: Span, 
    config: ContentCaptureConfig | undefined, 
    key: typeof GENAI_ATTR.INPUT_MESSAGES | typeof GENAI_ATTR.OUTPUT_MESSAGES, 
    messages: CapturableMessage[], 
    finishReason?: string 
): boolean
{
    if( !config?.captureContent || typeof config.redact !== 'function' )
    {
        return false;
    }

    try
    {
        const json = JSON.stringify( toGenAIMessages( messages, config.redact, finishReason ) );

        span.setAttribute( key, truncateContent( json, config.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES ) );

        return true;
    }
    catch
    {
        return false;
    }
}

/** Attribute keys that look like credentials. They are never exported, whoever set them. */
const SECRET_KEY_RE = /(^|[._-])(api[._-]?key|authorization|auth[._-]?token|access[._-]?token|secret|password|passwd|bearer|cookie|credentials?|raw[._-]?options)([._-]|$)/i;

export function isSecretAttributeKey( key: string ): boolean
{
    return SECRET_KEY_RE.test( key );
}

const SECRET_VALUE_RES: RegExp[] = 
    [
        /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
        /\bsk-[A-Za-z0-9_-]{16,}/g,
        /\bAIza[0-9A-Za-z_-]{20,}/g,
        /\b(?:xox[abprs]|ghp|gho|ghu|ghs)[-_][A-Za-z0-9-]{10,}/g
    ];

/** Replaces well-known credential shapes (bearer tokens, `sk-` / Google / Slack / GitHub keys) in free text. */
export function scrubSecrets( text: string ): string
{
    let out = text;

    for( const re of SECRET_VALUE_RES )
    {
        out = out.replace( re, '[REDACTED]' );
    }

    return out;
}
