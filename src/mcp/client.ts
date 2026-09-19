import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';
import { AIError } from '../core/error.js';
import { parseSSEStream } from '../core/stream.js';
import type { 
    JSONRPCMessage, 
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPTool, 
    MCPToolResult, 
    MCPTransport 
} from './types.js';
import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { CategorySpendInput } from '../spend/types.js';


export class InMemoryTransport implements MCPTransport
{
    #peer?: InMemoryTransport;
    #handler?: ( message: JSONRPCMessage ) => void;
    readonly #queue: JSONRPCMessage[] = [];
    #connected = false;

    public setPeer( peer: InMemoryTransport ): void
    {
        this.#peer = peer;
    }

    public async connect(): Promise<void>
    {
        this.#connected = true;

        while( this.#queue.length > 0 && this.#handler )
        {
            const msg = this.#queue.shift()!;
            this.#handler( msg );
        }
    }

    public async send( message: JSONRPCMessage ): Promise<void>
    {
        if( !this.#connected || !this.#peer )
        {
            throw new AIError( 'InMemoryTransport is not connected to a peer', 'MCP_TRANSPORT_ERROR' );
        }

        this.#peer.receive( structuredClone( message ) );
    }

    public receive( message: JSONRPCMessage ): void
    {
        if( this.#handler && this.#connected )
        {
            this.#handler( message );
        }
        else
        {
            this.#queue.push( message );
        }
    }

    public async close(): Promise<void>
    {
        this.#connected = false;
        this.#queue.length = 0;
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;

        if( this.#connected )
        {
            while( this.#queue.length > 0 )
            {
                const msg = this.#queue.shift()!;
                handler( msg );
            }
        }
    }

    public static createPair(): [ InMemoryTransport, InMemoryTransport ]
    {
        const a = new InMemoryTransport();
        const b = new InMemoryTransport();
        a.setPeer( b );
        b.setPeer( a );

        return [ a, b ];
    }
}

export class StdioTransport implements MCPTransport
{
    readonly #command: string;
    readonly #args: string[];
    readonly #env?: Record<string, string>;
    #process?: ChildProcess;
    #handler?: ( message: JSONRPCMessage ) => void;
    #buffer = '';

    constructor( command: string, args: string[] = [], env?: Record<string, string> )
    {
        this.#command = command;
        this.#args = args;
        this.#env = env;
    }

    public async connect(): Promise<void>
    {
        this.#process = spawn( this.#command, this.#args, 
            {
                env   : { ...process.env, ...this.#env },
                stdio : [ 'pipe', 'pipe', 'inherit' ]
            } );

        this.#process.stdout?.on( 'data', ( chunk: Buffer ) => 
        {
            this.#buffer += chunk.toString( 'utf8' );
            const lines = this.#buffer.split( '\n' );
            this.#buffer = lines.pop() ?? '';

            for( const line of lines )
            {
                const trimmed = line.trim();

                if( !trimmed )
                {
                    continue;
                }

                try
                {
                    const parsed = JSON.parse( trimmed ) as JSONRPCMessage;

                    if( this.#handler )
                    {
                        this.#handler( parsed );
                    }
                }
                catch
                {
                    // Ignore non-JSON output
                }
            }
        } );
    }

    public async send( message: JSONRPCMessage ): Promise<void>
    {
        if( !this.#process || !this.#process.stdin )
        {
            throw new AIError( 'StdioTransport process is not running', 'MCP_TRANSPORT_ERROR' );
        }

        const data = JSON.stringify( message ) + '\n';
        this.#process.stdin.write( data );
    }

    public async close(): Promise<void>
    {
        if( this.#process )
        {
            this.#process.kill();
            this.#process = undefined;
        }
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;
    }
}

export class SSETransport implements MCPTransport
{
    readonly #endpointUrl: string;
    #postUrl?: string;
    #handler?: ( message: JSONRPCMessage ) => void;
    #abortController?: AbortController;

    constructor( endpointUrl: string )
    {
        this.#endpointUrl = endpointUrl;
    }

    public async connect(): Promise<void>
    {
        this.#abortController = new AbortController();

        const response = await fetch( this.#endpointUrl, 
            {
                headers : { Accept : 'text/event-stream' },
                signal  : this.#abortController.signal
            } );

        if( !response.ok || !response.body )
        {
            throw new AIError( 
                `Failed to connect to MCP SSE endpoint: HTTP ${response.status}`, 
                'MCP_TRANSPORT_ERROR' 
            );
        }

        this.listenStream( response.body );
    }

    public async send( message: JSONRPCMessage ): Promise<void>
    {
        const url = this.#postUrl ?? this.#endpointUrl;

        const response = await fetch( url, 
            {
                method  : 'POST',
                headers : { 'Content-Type' : 'application/json' },
                body    : JSON.stringify( message )
            } );

        if( !response.ok )
        {
            throw new AIError( 
                `MCP send failed: HTTP ${response.status}`, 
                'MCP_TRANSPORT_ERROR' 
            );
        }
    }

    public async close(): Promise<void>
    {
        if( this.#abortController )
        {
            this.#abortController.abort();
            this.#abortController = undefined;
        }
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;
    }

    private async listenStream( stream: ReadableStream<Uint8Array> ): Promise<void>
    {
        try
        {
            for await ( const event of parseSSEStream( stream ) )
            {
                if( event.event === 'endpoint' && event.data )
                {
                    this.#postUrl = new URL( event.data, this.#endpointUrl ).toString();
                    continue;
                }

                if( event.data )
                {
                    try
                    {
                        const msg = JSON.parse( event.data ) as JSONRPCMessage;

                        if( this.#handler )
                        {
                            this.#handler( msg );
                        }
                    }
                    catch
                    {
                        // Ignore malformed chunks
                    }
                }
            }
        }
        catch
        {
            // Stream closed
        }
    }
}

export interface MCPClientOptions
{
    tracker? : SpendTracker
}

export interface MCPCallOptions
{
    context? : ExecutionContext
}

export class MCPClient
{
    readonly #transport       : MCPTransport;
    readonly #tracker?        : SpendTracker;
    readonly #pendingRequests = new Map<string | number, {
        resolve: ( res: JSONRPCResponse ) => void
        reject: ( err: Error ) => void
    }>();
    #requestIdCounter = 1;

    constructor( transport: MCPTransport, options: MCPClientOptions = {} )
    {
        this.#transport = transport;
        this.#tracker = options.tracker;
        this.#transport.onMessage( ( msg ) => 
        {
            this.handleIncoming( msg );
        } );
    }

    public async connect(): Promise<void>
    {
        await this.#transport.connect();

        // Send MCP handshake initialize
        await this.request( 'initialize', 
            {
                protocolVersion : '2024-11-05',
                capabilities    : { tools : {} },
                clientInfo      : { name : '@webergency-utils/ai', version : '0.1.0' }
            } );

        // Send initialized notification
        await this.#transport.send( 
            {
                jsonrpc : '2.0',
                method  : 'notifications/initialized'
            } );
    }

    public async listTools(): Promise<MCPTool[]>
    {
        const res = await this.request( 'tools/list', {} );

        if( res.error )
        {
            throw new AIError( `MCP tools/list failed: ${res.error.message}`, 'MCP_CLIENT_ERROR', res.error );
        }

        const result = res.result as { tools?: MCPTool[] } | undefined;

        return result?.tools ?? [];
    }

    public async callTool( 
        name: string, 
        args: Record<string, unknown> = {}, 
        options?: MCPCallOptions 
    ): Promise<MCPToolResult>
    {
        const reqPayload = 
            {
                name,
                arguments : args
            };

        const res = await this.request( 'tools/call', reqPayload );

        if( res.error )
        {
            throw new AIError( `MCP tools/call failed: ${res.error.message}`, 'MCP_CLIENT_ERROR', res.error );
        }

        const context = options?.context;
        const reqBytes = Buffer.byteLength( JSON.stringify( reqPayload ) );
        const resBytes = Buffer.byteLength( JSON.stringify( res ) );

        this.#reportSpend( {
            category    : 'network',
            subcategory : 'mcp_transport',
            units       : reqBytes + resBytes,
            unitType    : 'bytes'
        }, context );

        this.#reportSpend( {
            category    : 'mcp',
            subcategory : name,
            units       : 1,
            unitType    : 'call'
        }, context );

        return res.result as MCPToolResult;
    }

    #reportSpend( entry: CategorySpendInput, context?: ExecutionContext ): void
    {
        if( context )
        {
            context.reportSpend( entry );
        }
        else if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( entry );
        }
    }


    public async toToolDefinitions(): Promise<ToolDefinition[]>
    {
        const tools = await this.listTools();

        return tools.map( ( t ) => 
        {
            return {
                name        : t.name,
                description : t.description ?? '',
                parameters  : t.inputSchema ?? { type : 'object', properties : {} }
            };
        } );
    }

    public async close(): Promise<void>
    {
        await this.#transport.close();
    }

    private async request( method: string, params?: Record<string, unknown> ): Promise<JSONRPCResponse>
    {
        const id = this.#requestIdCounter++;
        const req: JSONRPCRequest = 
            {
                jsonrpc : '2.0',
                id,
                method,
                params
            };

        return new Promise<JSONRPCResponse>( ( resolve, reject ) => 
        {
            this.#pendingRequests.set( id, { resolve, reject } );

            this.#transport.send( req ).catch( ( err ) => 
            {
                this.#pendingRequests.delete( id );
                reject( err );
            } );
        } );
    }

    private handleIncoming( message: JSONRPCMessage ): void
    {
        if( 'id' in message && message.id !== undefined && ( 'result' in message || 'error' in message ) )
        {
            const pending = this.#pendingRequests.get( message.id );

            if( pending )
            {
                this.#pendingRequests.delete( message.id );
                pending.resolve( message as JSONRPCResponse );
            }
        }
    }
}
