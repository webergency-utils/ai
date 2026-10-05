import type { SerializedSpan } from '../trace/types.js';

export interface JSONRPCRequest
{
    jsonrpc : '2.0'
    id      : string | number
    method  : string
    params? : Record<string, unknown>
}

export interface JSONRPCNotification
{
    jsonrpc : '2.0'
    method  : string
    params? : Record<string, unknown>
}

export interface JSONRPCError
{
    code     : number
    message  : string
    data?    : unknown
}

export interface JSONRPCResponse
{
    jsonrpc  : '2.0'
    id       : string | number
    result?  : unknown
    error?   : JSONRPCError
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

export interface MCPTool
{
    name         : string
    description? : string
    inputSchema  : Record<string, unknown>
}

export interface MCPAnnotations
{
    audience?     : Array<'user' | 'assistant'>
    priority?     : number
    lastModified? : string
}

export interface MCPContentItem
{
    type          : 'text' | 'image' | 'audio' | 'resource' | 'resource_link'
    text?         : string
    data?         : string
    mimeType?     : string
    /** `resource_link` only. */
    uri?          : string
    name?         : string
    title?        : string
    description?  : string
    /** `resource` (embedded) only. */
    resource?     : MCPResourceContents
    annotations?  : MCPAnnotations
}

export interface MCPTraceMeta
{
    traceId?      : string
    parentSpanId? : string
    metadata?     : Record<string, unknown>
}

export interface MCPToolResult
{
    content            : MCPContentItem[]
    structuredContent? : Record<string, unknown>
    isError?           : boolean
    _meta?             : {
        spans? : SerializedSpan[]
        [key: string]: unknown
    }
}

export interface MCPImplementationInfo
{
    name     : string
    version  : string
    title?   : string
}

export interface MCPServerCapabilities
{
    tools?        : { listChanged?: boolean }
    resources?    : { subscribe?: boolean, listChanged?: boolean }
    prompts?      : { listChanged?: boolean }
    logging?      : Record<string, unknown>
    completions?  : Record<string, unknown>
    experimental? : Record<string, unknown>
}

export type MCPCapabilityName = 'tools' | 'resources' | 'prompts';

export interface MCPResource
{
    uri          : string
    name         : string
    title?       : string
    description? : string
    mimeType?    : string
    size?        : number
    annotations? : MCPAnnotations
}

export interface MCPResourceTemplate
{
    uriTemplate  : string
    name         : string
    title?       : string
    description? : string
    mimeType?    : string
    annotations? : MCPAnnotations
}

/** One piece of resource content. Exactly one of `text` / `blob` (base64) is present. */
export interface MCPResourceContents
{
    uri       : string
    mimeType? : string
    text?     : string
    blob?     : string
}

export interface MCPPromptArgument
{
    name         : string
    title?       : string
    description? : string
    required?    : boolean
}

export interface MCPPrompt
{
    name         : string
    title?       : string
    description? : string
    arguments?   : MCPPromptArgument[]
}

export interface MCPPromptMessage
{
    role    : 'user' | 'assistant'
    content : MCPContentItem
}

export interface MCPGetPromptResult
{
    description? : string
    messages     : MCPPromptMessage[]
}

export interface MCPTransport
{
    connect(): Promise<void>
    send( message: JSONRPCMessage ): Promise<void>
    close(): Promise<void>
    onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    /** Optional: fires when the underlying connection ends. A defined `error` is the reason it died (R58, R13). */
    onClose?( handler: ( error?: Error ) => void ): void
    /** Optional: non-fatal / out-of-band transport failures that have no request to reject (R13). */
    onError?( handler: ( error: Error ) => void ): void
    /** Optional: called after `initialize` with the negotiated version (HTTP sends it as `MCP-Protocol-Version`). */
    setProtocolVersion?( version: string ): void
}
