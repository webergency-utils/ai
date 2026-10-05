import type { ToolDefinition } from '../core/types.js';
import { toJsonSchema } from '../core/schema.js';
import type { 
    JSONRPCMessage, 
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPContentItem,
    MCPServerCapabilities,
    MCPTool, 
    MCPTransport 
} from './types.js';
import { 
    JSONRPC_INVALID_PARAMS, 
    JSONRPC_METHOD_NOT_FOUND, 
    LATEST_PROTOCOL_VERSION, 
    MCP_SERVER_NOT_INITIALIZED, 
    isSupportedProtocolVersion 
} from './protocol.js';
import { SimpleExecutionContext, type ExecutionContext } from '../agent/context.js';
import { SpanImpl } from '../trace/span.js';
import type { SpendTracker } from '../spend/tracker.js';

export type ToolHandler = ( args: Record<string, unknown>, context?: ExecutionContext ) => Promise<unknown>;



export interface MCPServerOptions
{
    name?     : string
    version?  : string
    /** Spend tracker for tool handlers when no per-call context is supplied (R30). */
    tracker?  : SpendTracker
}

/**
 * Per-connection lifecycle state. `MCPServer.connect()` keeps one per transport; the HTTP handler keeps one
 * per session. `handleMessage` without a connection is session-agnostic and performs no lifecycle gating.
 */
export interface MCPServerConnection
{
    initialized      : boolean
    protocolVersion? : string
}

export class MCPServer
{
    readonly #name: string;
    readonly #version: string;
    readonly #tracker?: SpendTracker;
    readonly #tools = new Map<string, { definition: ToolDefinition, handler: ToolHandler }>();

    constructor( options: MCPServerOptions = {} )
    {
        this.#name = options.name ?? '@webergency-utils/ai';
        this.#version = options.version ?? '0.1.0';
        this.#tracker = options.tracker;
    }

    public registerTool( tool: ToolDefinition, handler: ToolHandler ): void
    {
        this.#tools.set( tool.name, { definition : tool, handler } );
    }

    public createConnection(): MCPServerConnection
    {
        return { initialized : false };
    }

    #capabilities(): MCPServerCapabilities
    {
        // `tools` is always advertised (back-compat: tools may be registered after the handshake).
        return { tools : {} };
    }

    public async connect( transport: MCPTransport ): Promise<void>
    {
        const connection = this.createConnection();

        transport.onMessage( async ( message ) => 
        {
            const defaultContext = this.#tracker
                ? new SimpleExecutionContext( { tracker : this.#tracker } )
                : undefined;
            const response = await this.handleMessage( message, defaultContext, connection );

            if( response )
            {
                await transport.send( response );
            }
        } );

        await transport.connect();
    }

    public async handleMessage( 
        message: JSONRPCMessage, 
        context?: ExecutionContext, 
        connection?: MCPServerConnection 
    ): Promise<JSONRPCResponse | null>
    {
        if( !( 'method' in message ) )
        {
            return null;
        }

        const req = message as JSONRPCRequest;

        // If it's a notification without an id
        if( req.id === undefined )
        {
            return null;
        }

        if( req.method === 'ping' )
        {
            return { jsonrpc : '2.0', id : req.id, result : {} };
        }

        if( req.method === 'initialize' )
        {
            const requested = req.params?.protocolVersion;

            if( typeof requested !== 'string' )
            {
                return {
                    jsonrpc : '2.0',
                    id      : req.id,
                    error   : { code : JSONRPC_INVALID_PARAMS, message : "initialize requires a string 'protocolVersion'" }
                };
            }

            // Echo the client's version when supported, otherwise answer with our latest and let the client decide.
            const protocolVersion = isSupportedProtocolVersion( requested ) ? requested : LATEST_PROTOCOL_VERSION;

            if( connection )
            {
                connection.initialized = true;
                connection.protocolVersion = protocolVersion;
            }

            return {
                jsonrpc : '2.0',
                id      : req.id,
                result : 
                {
                    protocolVersion,
                    capabilities : this.#capabilities(),
                    serverInfo   : { name : this.#name, version : this.#version }
                }
            };
        }

        if( connection && !connection.initialized )
        {
            return {
                jsonrpc : '2.0',
                id      : req.id,
                error   : { code : MCP_SERVER_NOT_INITIALIZED, message : `Received '${req.method}' before initialize` }
            };
        }

        switch ( req.method )
        {
            case 'tools/list':
            {
                const tools: MCPTool[] = [];

                for( const { definition } of this.#tools.values() )
                {
                    tools.push( 
                        {
                            name        : definition.name,
                            description : definition.description,
                            inputSchema : toJsonSchema( definition.parameters )
                        } );
                }

                return {
                    jsonrpc : '2.0',
                    id      : req.id,
                    result  : { tools }
                };
            }

            case 'tools/call':
            {
                const toolName = ( req.params?.name as string ) ?? '';
                const toolArgs = ( req.params?.arguments as Record<string, unknown> ) ?? {};
                const registered = this.#tools.get( toolName );

                if( !registered )
                {
                    return {
                        jsonrpc : '2.0',
                        id      : req.id,
                        error : 
                        {
                            code    : JSONRPC_METHOD_NOT_FOUND,
                            message : `Tool '${toolName}' not found`
                        }
                    };
                }

                const meta = req.params?._meta as { traceId?: string, parentSpanId?: string } | undefined;
                let handlerContext = context ?? (
                    this.#tracker
                        ? new SimpleExecutionContext( { tracker : this.#tracker } )
                        : undefined
                );
                let serverToolSpan: SpanImpl | undefined;

                if( meta?.traceId )
                {
                    serverToolSpan = new SpanImpl( `tool:${toolName}`, 
                        {
                            traceId      : meta.traceId,
                            parentSpanId : meta.parentSpanId,
                            kind         : 'tool'
                        } );

                    if( context )
                    {
                        handlerContext = context.child( {
                            traceId    : meta.traceId,
                            activeSpan : serverToolSpan
                        } );
                    }
                    else
                    {
                        handlerContext = new SimpleExecutionContext( 
                            {
                                traceId    : meta.traceId,
                                activeSpan : serverToolSpan,
                                tracker    : this.#tracker
                            } );
                    }
                }

                try
                {
                    const rawResult = await registered.handler( toolArgs, handlerContext );

                    if( serverToolSpan )
                    {
                        serverToolSpan.end();
                    }

                    let formattedContent: MCPContentItem[];

                    if( 
                        rawResult && 
                        typeof rawResult === 'object' && 
                        'content' in rawResult && 
                        Array.isArray( ( rawResult as { content: unknown } ).content ) 
                    )
                    {
                        formattedContent = ( rawResult as { content: MCPContentItem[] } ).content;
                    }
                    else
                    {
                        const text = typeof rawResult === 'string' 
                            ? rawResult 
                            : JSON.stringify( rawResult );

                        formattedContent = [ { type : 'text', text } ];
                    }

                    const responseResult: Record<string, unknown> = 
                        {
                            content : formattedContent,
                            isError : false
                        };

                    const structured = ( rawResult as { structuredContent?: unknown } | null )?.structuredContent;

                    if( structured !== undefined && Array.isArray( ( rawResult as { content?: unknown } ).content ) )
                    {
                        responseResult.structuredContent = structured;
                    }

                    if( serverToolSpan )
                    {
                        responseResult._meta = 
                            {
                                spans : [ serverToolSpan.toJSON() ]
                            };
                    }

                    return {
                        jsonrpc : '2.0',
                        id      : req.id,
                        result  : responseResult
                    };
                }
                catch( err: unknown )
                {
                    const errorMessage = err instanceof Error ? err.message : String( err );

                    if( serverToolSpan )
                    {
                        serverToolSpan.status = 'error';
                        serverToolSpan.errorDetails = 
                            {
                                message : errorMessage,
                                name    : err instanceof Error ? err.name : undefined,
                                stack   : err instanceof Error ? err.stack : undefined
                            };
                        serverToolSpan.end();
                    }

                    const responseResult: Record<string, unknown> = 
                        {
                            content : [ { type : 'text', text : `Tool error: ${errorMessage}` } ],
                            isError : true
                        };

                    if( serverToolSpan )
                    {
                        responseResult._meta = 
                            {
                                spans : [ serverToolSpan.toJSON() ]
                            };
                    }

                    return {
                        jsonrpc : '2.0',
                        id      : req.id,
                        result  : responseResult
                    };
                }
            }

            default:
                return {
                    jsonrpc : '2.0',
                    id      : req.id,
                    error : 
                    {
                        code    : JSONRPC_METHOD_NOT_FOUND,
                        message : `Method '${req.method}' not implemented`
                    }
                };
        }
    }
}
