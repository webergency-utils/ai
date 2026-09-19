import type { z } from 'zod';

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

export type ChatMessage =
    {
        role         : MessageRole
        content      : string
        name?        : string
        toolCallId?  : string
        toolCalls?   : ToolCall[]
        attachments? : MessageAttachment[]
    }

export type ToolDefinition =
    {
        name        : string
        description : string
        parameters  : z.ZodTypeAny
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

export type ModelConfig =
    {
        provider       : string
        model          : string
        apiKey?        : string
        baseUrl?       : string
        temperature?   : number
        maxTokens?     : number
        topP?          : number
        systemPrompt?  : string
        vendorOptions? : Record<string, unknown>
    }

export type ModelRequest =
    {
        messages      : ChatMessage[]
        tools?        : ToolDefinition[]
        toolChoice?   : 'auto' | 'none' | 'required' | { name : string }
        temperature?  : number
        maxTokens?    : number
        systemPrompt? : string
        stream?       : boolean
        rawOptions?   : Record<string, unknown>
    }

export type ModelResponse =
    {
        content      : string
        role         : 'assistant'
        toolCalls?   : ToolCall[]
        usage?       : UsageMetrics
        finishReason : 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other'
        raw          : unknown
    }

export type ModelStreamChunk =
    {
        deltaContent  : string
        deltaToolCall?: 
        {
            index      : number
            id?        : string
            name?      : string
            arguments? : string
        }
        toolCalls?    : ToolCall[]
        usage?        : UsageMetrics
        finishReason? : 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other'
        raw?          : unknown
    }
