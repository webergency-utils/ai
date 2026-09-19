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

export interface MCPToolResult
{
    content  : MCPContentItem[]
    isError? : boolean
}

export interface MCPTransport
{
    connect(): Promise<void>
    send( message: JSONRPCMessage ): Promise<void>
    close(): Promise<void>
    onMessage( handler: ( message: JSONRPCMessage ) => void ): void
}
