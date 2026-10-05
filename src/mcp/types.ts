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

export interface MCPContentItem
{
    type      : 'text' | 'image' | 'resource'
    text?     : string
    data?     : string
    mimeType? : string
}

export interface MCPTraceMeta
{
    traceId?      : string
    parentSpanId? : string
    metadata?     : Record<string, unknown>
}

export interface MCPToolResult
{
    content  : MCPContentItem[]
    isError? : boolean
    _meta?   : {
        spans? : SerializedSpan[]
        [key: string]: unknown
    }
}


export interface MCPTransport
{
    connect(): Promise<void>
    send( message: JSONRPCMessage ): Promise<void>
    close(): Promise<void>
    onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    /** Optional: fire when the underlying connection dies (R58). */
    onClose?( handler: () => void ): void
}
