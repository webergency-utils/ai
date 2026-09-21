import type { ToolDefinition } from '../core/types.js';
import { toJsonSchema } from '../core/schema.js';
import type { 
    JSONRPCMessage, 
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPTool, 
    MCPTransport 
} from './types.js';
import { SimpleExecutionContext, type ExecutionContext } from '../agent/context.js';
import { SpanImpl } from '../trace/span.js';

export type ToolHandler = ( args: Record<string, unknown>, context?: ExecutionContext ) => Promise<unknown>;



export interface MCPServerOptions
{
    name?    : string
    version? : string
}

export class MCPServer
{
    readonly #name: string;
    readonly #version: string;
    readonly #tools = new Map<string, { definition: ToolDefinition, handler: ToolHandler }>();

    constructor( options: MCPServerOptions = {} )
    {
        this.#name = options.name ?? '@webergency-utils/ai';
        this.#version = options.version ?? '0.1.0';
    }

    public registerTool( tool: ToolDefinition, handler: ToolHandler ): void
    {
        this.#tools.set( tool.name, { definition : tool, handler } );
    }

    public async connect( transport: MCPTransport ): Promise<void>
    {
        transport.onMessage( async ( message ) => 
        {
            const response = await this.handleMessage( message );

            if( response )
            {
                await transport.send( response );
            }
        } );

        await transport.connect();
    }

    public async handleMessage( message: JSONRPCMessage, context?: ExecutionContext ): Promise<JSONRPCResponse | null>
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

        switch ( req.method )
        {
            case 'initialize':
                return {
                    jsonrpc : '2.0',
                    id      : req.id,
                    result : 
                    {
                        protocolVersion : '2024-11-05',
                        capabilities    : { tools : {} },
                        serverInfo      : { name : this.#name, version : this.#version }
                    }
                };

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
                            code    : -32601,
                            message : `Tool '${toolName}' not found`
                        }
                    };
                }

                const meta = req.params?._meta as { traceId?: string, parentSpanId?: string } | undefined;
                let handlerContext = context;
                let serverToolSpan: SpanImpl | undefined;

                if( meta?.traceId )
                {
                    serverToolSpan = new SpanImpl( `tool:${toolName}`, 
                        {
                            traceId      : meta.traceId,
                            parentSpanId : meta.parentSpanId,
                            kind         : 'tool'
                        } );

                    handlerContext = new SimpleExecutionContext( 
                        {
                            traceId    : meta.traceId,
                            activeSpan : serverToolSpan,
                            threadId   : context?.threadId,
                            agentId    : context?.agentId
                        } );
                }

                try
                {
                    const rawResult = await registered.handler( toolArgs, handlerContext );

                    if( serverToolSpan )
                    {
                        serverToolSpan.end();
                    }

                    let formattedContent: Array<{ type: string, text: string }>;

                    if( 
                        rawResult && 
                        typeof rawResult === 'object' && 
                        'content' in rawResult && 
                        Array.isArray( ( rawResult as { content: unknown } ).content ) 
                    )
                    {
                        formattedContent = ( rawResult as { content: Array<{ type: string, text: string }> } ).content;
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
                        code    : -32601,
                        message : `Method '${req.method}' not implemented`
                    }
                };
        }
    }
}
