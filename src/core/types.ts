import type { JsonSchema } from '@webergency-utils/typechecker';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type AttachmentType = 'image' | 'audio' | 'video' | 'document';

export type MessageAttachment =
    {
        type      : AttachmentType
        mimeType  : string
        data?     : string | Uint8Array
        url?      : string
        filename? : string
    }

export type ToolCall =
    {
        id        : string
        name      : string
        arguments : Record<string, unknown>
    }

export type ToolCallResult =
    {
        toolCallId : string
        name       : string
        result     : unknown
        isError?   : boolean
    }

export type CacheControl =
    {
        type : 'ephemeral'
        ttl? : '5m' | '1h'
    }

export type ChatMessage =
    {
        role              : MessageRole
        content           : string
        name?             : string
        toolCallId?       : string
        toolCalls?        : ToolCall[]
        attachments?      : MessageAttachment[]
        /** Assistant-only: provider reasoning text, round-tripped where the provider requires it. */
        reasoningContent? : string
        /** Prompt-cache breakpoint (Anthropic-style). Fails loudly on providers without support. */
        cacheControl?     : CacheControl
    }

export type ToolDefinition =
    {
        name        : string
        description : string
        parameters  : JsonSchema | Record<string, unknown>
    }

export type UsageMetrics =
    {
        promptTokens             : number
        completionTokens         : number
        totalTokens              : number
        reasoningTokens?         : number
        cachedPromptReadTokens?  : number
        cachedPromptWriteTokens? : number
        raw?                     : Record<string, unknown>
    }

export type OutputMode = 'json' | 'json_schema';

/**
 * Honest per-adapter capability flags. `embeddings` states whether the provider
 * is supported by `createEmbeddingModel` (chat models never embed themselves).
 */
export type ModelCapabilities =
    {
        structuredOutput    : boolean
        embeddings          : boolean
        reasoningContent    : boolean
        promptCacheControl  : boolean
        multimodal          : Record<AttachmentType, boolean>
    }

export type ModelConfig =
    {
        provider       : string
        model          : string
        apiKey?        : string
        apiKeyEnvVar?  : string
        baseUrl?       : string
        temperature?   : number
        maxTokens?     : number
        topP?          : number
        systemPrompt?  : string
        vendorOptions? : Record<string, unknown>
        timeoutMs?     : number
        idleTimeoutMs? : number
        maxRetries?    : number
        /** Send the W3C `traceparent` header (taken from `ModelRequest.traceparent`) to the provider. Default false. */
        propagateTraceContext? : boolean
        /** Overrides adapter capability defaults (e.g. a local model without schema support). */
        capabilities?  : Partial<Omit<ModelCapabilities, 'multimodal'>> & { multimodal? : Partial<Record<AttachmentType, boolean>> }
    }

export type ModelRequestAttemptInfo =
    {
        attempt     : number
        maxAttempts : number
        error?      : unknown
        delayMs?    : number
    }

export type ModelRequest =
    {
        messages       : ChatMessage[]
        tools?         : ToolDefinition[]
        toolChoice?    : 'auto' | 'none' | 'required' | { name : string }
        temperature?   : number
        maxTokens?     : number
        systemPrompt?  : string
        stream?        : boolean
        rawOptions?    : Record<string, unknown>
        /** JSON Schema the final answer must satisfy; result is returned as `ModelResponse.structured`. */
        outputSchema?  : JsonSchema | Record<string, unknown>
        /** Defaults to 'json_schema' when `outputSchema` is present. */
        outputMode?    : OutputMode
        /** OpenAI prompt-cache routing key. */
        promptCacheKey? : string
        signal?        : AbortSignal
        /** W3C `traceparent` of the calling span; only sent when the adapter config enables `propagateTraceContext`. */
        traceparent?   : string
        timeoutMs?     : number
        idleTimeoutMs? : number
        /** false disables retries; object overrides maxRetries for this call */
        retry?         : false | { maxRetries? : number }
        onAttempt?     : ( info: ModelRequestAttemptInfo ) => void
    }

export type ModelResponse =
    {
        content      : string
        role         : 'assistant'
        toolCalls?   : ToolCall[]
        /** Parsed and schema-validated JSON when `outputSchema` was requested. */
        structured?  : unknown
        reasoningContent? : string
        usage?       : UsageMetrics
        /**
         * True when the provider returned no usage metrics.
         * Metering must record a spend gap (R2/R57), never treat as free.
         */
        usageMissing? : true
        finishReason : 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other'
        raw          : unknown
    }

export type ModelStreamChunk =
    {
        deltaContent  : string
        deltaReasoningContent? : string
        deltaToolCall?: 
        {
            index      : number
            id?        : string
            name?      : string
            arguments? : string
        }
        toolCalls?    : ToolCall[]
        /** Terminal chunk only: parsed and schema-validated output when `outputSchema` was requested. */
        structured?   : unknown
        usage?        : UsageMetrics
        finishReason? : 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other'
        raw?          : unknown
    }
