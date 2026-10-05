/**
 * MCP protocol revisions this toolkit speaks, newest first. Shared by client and server.
 * The client offers the first entry; a peer answering with anything outside this list is rejected.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05'
];

export const LATEST_PROTOCOL_VERSION: string = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Version a Streamable HTTP server assumes when the `MCP-Protocol-Version` header is absent (spec backwards-compat rule). */
export const DEFAULT_HTTP_PROTOCOL_VERSION = '2025-03-26';

export function isSupportedProtocolVersion( version: unknown ): version is string
{
    return typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes( version );
}

/** JSON-RPC / MCP error codes used by the server. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** Request received before `initialize` completed. */
export const MCP_SERVER_NOT_INITIALIZED = -32002;
