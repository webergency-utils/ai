import type { ToolDefinition } from '../core/types.js';
import { zodToJsonSchema } from '../core/schema.js';
import type { 
    JSONRPCMessage, 
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPTool, 
    MCPTransport 
} from './types.js';

export type ToolHandler = ( args: Record<string, unknown> ) => Promise<unknown>;

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

    public async handleMessage( message: JSONRPCMessage ): Promise<JSONRPCResponse | null>
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
                            inputSchema : zodToJsonSchema( definition.parameters )
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

                try
                {
                    const rawResult = await registered.handler( toolArgs );

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

                    return {
                        jsonrpc : '2.0',
                        id      : req.id,
                        result : 
                        {
                            content : formattedContent,
                            isError : false
                        }
                    };
                }
                catch( err: unknown )
                {
                    const errorMessage = err instanceof Error ? err.message : String( err );

                    return {
                        jsonrpc : '2.0',
                        id      : req.id,
                        result : 
                        {
                            content : [ { type : 'text', text : `Tool error: ${errorMessage}` } ],
                            isError : true
                        }
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
