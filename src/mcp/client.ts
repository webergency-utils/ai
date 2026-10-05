import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';
import { AIError } from '../core/error.js';
import { parseSSEStream } from '../core/stream.js';
import { createNDJSONDecoder } from '../core/ndjson.js';
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
import type { Span } from '../trace/types.js';
import { SpanImpl } from '../trace/span.js';



export class InMemoryTransport implements MCPTransport
{
    #peer?: InMemoryTransport;
    #handler?: ( message: JSONRPCMessage ) => void;
    #closeHandler?: () => void;
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
        if( !this.#connected )
        {
            return;
        }

        this.#connected = false;
        this.#queue.length = 0;
        this.#closeHandler?.();
    }

    /** Simulate peer/transport death without going through close() (R58 tests). */
    public simulateDeath(): void
    {
        if( !this.#connected )
        {
            return;
        }

        this.#connected = false;
        this.#queue.length = 0;
        this.#closeHandler?.();
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

    public onClose( handler: () => void ): void
    {
        this.#closeHandler = handler;
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
    #closeHandler?: () => void;
    readonly #textDecoder = new TextDecoder();
    readonly #ndjson = createNDJSONDecoder();

    constructor( command: string, args: string[] = [], env?: Record<string, string> )
    {
        this.#command = command;
        this.#args = args;
        this.#env = env;
    }

    #dispatchLines( lines: string[] ): void
    {
        for( const trimmed of lines )
        {
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
            this.#dispatchLines( this.#ndjson.push( this.#textDecoder.decode( chunk, { stream : true } ) ) );
        } );

        this.#process.stdout?.on( 'end', () => 
        {
            const tail = this.#textDecoder.decode();

            if( tail )
            {
                this.#dispatchLines( this.#ndjson.push( tail ) );
            }

            this.#dispatchLines( this.#ndjson.flush() );
        } );

        this.#process.on( 'exit', () => 
        {
            this.#process = undefined;
            this.#closeHandler?.();
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
            const proc = this.#process;
            this.#process = undefined;
            proc.removeAllListeners( 'exit' );
            proc.kill();
            this.#closeHandler?.();
        }
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;
    }

    public onClose( handler: () => void ): void
    {
        this.#closeHandler = handler;
    }
}

export class SSETransport implements MCPTransport
{
    readonly #endpointUrl: string;
    #postUrl?: string;
    #handler?: ( message: JSONRPCMessage ) => void;
    #closeHandler?: () => void;
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
        if( !this.#abortController )
        {
            return;
        }

        const controller = this.#abortController;
        this.#abortController = undefined;
        controller.abort();
        this.#closeHandler?.();
    }

    public onMessage( handler: ( message: JSONRPCMessage ) => void ): void
    {
        this.#handler = handler;
    }

    public onClose( handler: () => void ): void
    {
        this.#closeHandler = handler;
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
        finally
        {
            if( this.#abortController )
            {
                this.#abortController = undefined;
                this.#closeHandler?.();
            }
        }
    }
}

export interface MCPClientOptions
{
    tracker?    : SpendTracker
    /** Per-request timeout in ms (default 60_000). */
    timeoutMs?  : number
}

export interface MCPCallOptions
{
    context?   : ExecutionContext
    signal?    : AbortSignal
    timeoutMs? : number
}

export class MCPClient
{
    readonly #transport       : MCPTransport;
    readonly #tracker?        : SpendTracker;
    readonly #timeoutMs       : number;
    readonly #pendingRequests = new Map<string | number, {
        resolve: ( res: JSONRPCResponse ) => void
        reject: ( err: Error ) => void
        method: string
        timer?: ReturnType<typeof setTimeout>
    }>();
    #requestIdCounter = 1;
    #closed = false;

    constructor( transport: MCPTransport, options: MCPClientOptions = {} )
    {
        this.#transport = transport;
        this.#tracker = options.tracker;
        this.#timeoutMs = options.timeoutMs ?? 60_000;
        this.#transport.onMessage( ( msg ) => 
        {
            this.handleIncoming( msg );
        } );

        this.#transport.onClose?.( () => 
        {
            this.#rejectAllPending( new AIError( 'MCP transport closed', 'MCP_TRANSPORT_CLOSED' ) );
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
        const context = options?.context;
        const parentSpan = context?.activeSpan;
        let mcpSpan: Span | undefined;

        if( context?.startSpan )
        {
            mcpSpan = context.startSpan( `mcp:call:${name}`, 
                {
                    kind       : 'mcp',
                    attributes : { 'mcp.tool' : name }
                } );
        }

        const reqPayload: Record<string, unknown> = 
            {
                name,
                arguments : args
            };

        if( mcpSpan )
        {
            reqPayload._meta = 
                {
                    traceId      : mcpSpan.traceId,
                    parentSpanId : mcpSpan.id
                };
        }
        else if( parentSpan )
        {
            reqPayload._meta = 
                {
                    traceId      : parentSpan.traceId,
                    parentSpanId : parentSpan.id
                };
        }

        let res: JSONRPCResponse;

        try
        {
            res = await this.request( 'tools/call', reqPayload, {
                signal    : options?.signal,
                timeoutMs : options?.timeoutMs
            } );
        }
        catch( err: unknown )
        {
            if( mcpSpan )
            {
                mcpSpan.status = 'error';
                mcpSpan.errorDetails = 
                    {
                        message : err instanceof Error ? err.message : String( err )
                    };
                mcpSpan.end();
            }

            throw err;
        }

        if( res.error )
        {
            if( mcpSpan )
            {
                mcpSpan.status = 'error';
                mcpSpan.errorDetails = 
                    {
                        message : res.error.message
                    };
                mcpSpan.end();
            }

            throw new AIError( `MCP tools/call failed: ${res.error.message}`, 'MCP_CLIENT_ERROR', res.error );
        }

        const result = res.result as MCPToolResult;

        if( mcpSpan && result?._meta?.spans && Array.isArray( result._meta.spans ) )
        {
            for( const serializedChild of result._meta.spans )
            {
                const deserializedChild = SpanImpl.fromSerialized( serializedChild );
                mcpSpan.addChild( deserializedChild );
            }
        }

        const reqBytes = Buffer.byteLength( JSON.stringify( reqPayload ) );
        const resBytes = Buffer.byteLength( JSON.stringify( res ) );

        const reportCtx = mcpSpan ? context?.child( { activeSpan : mcpSpan } ) : context;

        this.#reportSpend( {
            category    : 'network',
            subcategory : 'mcp_transport',
            units       : reqBytes + resBytes,
            unitType    : 'bytes'
        }, reportCtx );

        this.#reportSpend( {
            category    : 'mcp',
            subcategory : name,
            units       : 1,
            unitType    : 'call'
        }, reportCtx );

        if( mcpSpan )
        {
            mcpSpan.end();
        }

        return result;
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
        this.#closed = true;
        this.#rejectAllPending( new AIError( 'MCP client closed', 'MCP_CLIENT_CLOSED' ) );
        await this.#transport.close();
    }

    private async request( 
        method: string, 
        params?: Record<string, unknown>,
        options: { signal?: AbortSignal, timeoutMs?: number } = {}
    ): Promise<JSONRPCResponse>
    {
        if( this.#closed )
        {
            throw new AIError( 'MCP client closed', 'MCP_CLIENT_CLOSED' );
        }

        const id = this.#requestIdCounter++;
        const req: JSONRPCRequest = 
            {
                jsonrpc : '2.0',
                id,
                method,
                params
            };

        const timeoutMs = options.timeoutMs ?? this.#timeoutMs;

        return new Promise<JSONRPCResponse>( ( resolve, reject ) => 
        {
            let settled = false;
            let onAbort: ( () => void ) | undefined;

            const finish = ( res?: JSONRPCResponse, err?: Error ): void => 
            {
                if( settled )
                {
                    return;
                }

                settled = true;
                const pending = this.#pendingRequests.get( id );

                if( pending?.timer )
                {
                    clearTimeout( pending.timer );
                }

                this.#pendingRequests.delete( id );

                if( onAbort )
                {
                    options.signal?.removeEventListener( 'abort', onAbort );
                }

                if( err )
                {
                    reject( err );
                }
                else
                {
                    resolve( res! );
                }
            };

            onAbort = (): void => 
            {
                void this.#sendCancelled( id, method );
                finish( undefined, new AIError( `MCP request '${method}' aborted`, 'MCP_REQUEST_ABORTED', { id, method } ) );
            };

            if( options.signal?.aborted )
            {
                onAbort();

                return;
            }

            const timer = timeoutMs > 0
                ? setTimeout( () => 
                {
                    void this.#sendCancelled( id, method );
                    finish( undefined, new AIError( 
                        `MCP request '${method}' timed out after ${timeoutMs}ms`, 
                        'MCP_REQUEST_TIMEOUT', 
                        { id, method, timeoutMs } 
                    ) );
                }, timeoutMs )
                : undefined;

            this.#pendingRequests.set( id, {
                resolve : ( res ) => { finish( res ); },
                reject  : ( err ) => { finish( undefined, err ); },
                method,
                timer
            } );

            options.signal?.addEventListener( 'abort', onAbort, { once : true } );

            this.#transport.send( req ).catch( ( err: unknown ) => 
            {
                finish( 
                    undefined, 
                    err instanceof Error ? err : new AIError( String( err ), 'MCP_TRANSPORT_ERROR' ) 
                );
            } );
        } );
    }

    async #sendCancelled( id: string | number, method: string ): Promise<void>
    {
        // MCP spec: do not cancel initialize (R40).
        if( method === 'initialize' )
        {
            return;
        }

        try
        {
            await this.#transport.send( {
                jsonrpc : '2.0',
                method  : 'notifications/cancelled',
                params  : {
                    requestId : id,
                    reason    : 'client cancelled'
                }
            } );
        }
        catch
        {
            // Best-effort cancel notification
        }
    }

    #rejectAllPending( err: Error ): void
    {
        for( const [ id, pending ] of this.#pendingRequests )
        {
            if( pending.timer )
            {
                clearTimeout( pending.timer );
            }

            this.#pendingRequests.delete( id );
            pending.reject( err );
        }
    }

    private handleIncoming( message: JSONRPCMessage ): void
    {
        if( 'id' in message && message.id !== undefined && ( 'result' in message || 'error' in message ) )
        {
            const pending = this.#pendingRequests.get( message.id );

            if( pending )
            {
                pending.resolve( message as JSONRPCResponse );
            }
        }
    }
}
