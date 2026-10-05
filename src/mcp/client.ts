import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';
import { AIError } from '../core/error.js';
import { parseSSEStream } from '../core/stream.js';
import { createNDJSONDecoder } from '../core/ndjson.js';
import type { 
    JSONRPCMessage, 
    JSONRPCNotification,
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPCapabilityName,
    MCPGetPromptResult,
    MCPImplementationInfo,
    MCPPrompt,
    MCPResource,
    MCPResourceContents,
    MCPResourceTemplate,
    MCPServerCapabilities,
    MCPTool, 
    MCPToolResult, 
    MCPTransport 
} from './types.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, isSupportedProtocolVersion, JSONRPC_METHOD_NOT_FOUND } from './protocol.js';
import { validateResourceContents } from './resource-content.js';
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
    /** Maximum pages followed for any paginated list call; a longer listing throws `MCP_PAGINATION_LIMIT` (default 100). */
    maxPages?   : number
    /**
     * Receives failures that have no request to reject: notification handler errors, failed replies to
     * server-initiated requests, and out-of-band transport errors. Without it they are rethrown asynchronously.
     */
    onError?    : ( error: Error ) => void
}

export interface MCPConnectOptions
{
    /** When `false`, methods are sent even if the server did not advertise the matching capability (default `true`). */
    strictCapabilities? : boolean
}

export interface MCPRequestOptions
{
    signal?    : AbortSignal
    timeoutMs? : number
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
    readonly #maxPages        : number;
    readonly #onError?        : ( error: Error ) => void;
    readonly #notificationHandlers = new Set<( notification: JSONRPCNotification ) => void>();
    #requestIdCounter = 1;
    #closed = false;
    #strictCapabilities = true;
    #negotiatedVersion?: string;
    #serverCapabilities?: MCPServerCapabilities;
    #serverInfo?: MCPImplementationInfo;
    #instructions?: string;

    constructor( transport: MCPTransport, options: MCPClientOptions = {} )
    {
        this.#transport = transport;
        this.#tracker = options.tracker;
        this.#timeoutMs = options.timeoutMs ?? 60_000;
        this.#maxPages = options.maxPages ?? 100;
        this.#onError = options.onError;

        if( !Number.isInteger( this.#maxPages ) || this.#maxPages < 1 )
        {
            throw new AIError( `MCPClient maxPages must be a positive integer, got ${String( options.maxPages )}`, 'INVALID_INPUT' );
        }

        this.#transport.onMessage( ( msg ) => 
        {
            this.handleIncoming( msg );
        } );

        this.#transport.onClose?.( ( error ) => 
        {
            this.#rejectAllPending( error ?? new AIError( 'MCP transport closed', 'MCP_TRANSPORT_CLOSED' ) );
        } );

        this.#transport.onError?.( ( error ) => 
        {
            this.#reportError( error );
        } );
    }

    /** Protocol revision agreed during `connect()`; undefined until connected. */
    public get negotiatedVersion(): string | undefined
    {
        return this.#negotiatedVersion;
    }

    public get serverCapabilities(): MCPServerCapabilities | undefined
    {
        return this.#serverCapabilities;
    }

    public get serverInfo(): MCPImplementationInfo | undefined
    {
        return this.#serverInfo;
    }

    public get instructions(): string | undefined
    {
        return this.#instructions;
    }

    /** Registers a listener for server notifications; returns an unsubscribe function. */
    public onNotification( handler: ( notification: JSONRPCNotification ) => void ): () => void
    {
        this.#notificationHandlers.add( handler );

        return () => 
        {
            this.#notificationHandlers.delete( handler );
        };
    }

    public async connect( options: MCPConnectOptions = {} ): Promise<void>
    {
        this.#strictCapabilities = options.strictCapabilities !== false;

        await this.#transport.connect();

        try
        {
            await this.#handshake();
        }
        catch( error: unknown )
        {
            try
            {
                await this.close();
            }
            catch
            {
                // The handshake error is the one worth surfacing.
            }

            throw error;
        }
    }

    async #handshake(): Promise<void>
    {
        const res = await this.request( 'initialize', 
            {
                protocolVersion : LATEST_PROTOCOL_VERSION,
                capabilities    : {},
                clientInfo      : { name : '@webergency-utils/ai', version : '0.1.0' }
            } );

        if( res.error )
        {
            throw new AIError( `MCP initialize failed: ${res.error.message}`, 'MCP_CLIENT_ERROR', res.error );
        }

        const result = res.result as Record<string, unknown> | undefined;

        if( !result || typeof result !== 'object' || Array.isArray( result ) )
        {
            throw new AIError( 'MCP initialize returned no result object', 'MCP_PROTOCOL_ERROR', { result } );
        }

        if( !isSupportedProtocolVersion( result.protocolVersion ) )
        {
            throw new AIError( 
                `MCP server answered with unsupported protocol version '${String( result.protocolVersion )}' (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join( ', ' )})`, 
                'MCP_PROTOCOL_VERSION_UNSUPPORTED', 
                { requested : LATEST_PROTOCOL_VERSION, received : result.protocolVersion, supported : [ ...SUPPORTED_PROTOCOL_VERSIONS ] } 
            );
        }

        const capabilities = result.capabilities;

        if( !capabilities || typeof capabilities !== 'object' || Array.isArray( capabilities ) )
        {
            throw new AIError( 'MCP initialize result is missing a capabilities object', 'MCP_PROTOCOL_ERROR', { result } );
        }

        if( result.serverInfo !== undefined && ( !result.serverInfo || typeof result.serverInfo !== 'object' ) )
        {
            throw new AIError( 'MCP initialize result has a malformed serverInfo', 'MCP_PROTOCOL_ERROR', { result } );
        }

        if( result.instructions !== undefined && typeof result.instructions !== 'string' )
        {
            throw new AIError( 'MCP initialize result has non-string instructions', 'MCP_PROTOCOL_ERROR', { result } );
        }

        this.#negotiatedVersion = result.protocolVersion;
        this.#serverCapabilities = capabilities as MCPServerCapabilities;
        this.#serverInfo = result.serverInfo as MCPImplementationInfo | undefined;
        this.#instructions = result.instructions as string | undefined;

        this.#transport.setProtocolVersion?.( result.protocolVersion );

        await this.#transport.send( 
            {
                jsonrpc : '2.0',
                method  : 'notifications/initialized'
            } );
    }

    /** Sends `ping`; resolves when the server answers, rejects on error or timeout. */
    public async ping( options?: MCPRequestOptions ): Promise<void>
    {
        this.#assertConnected( 'ping' );

        const res = await this.request( 'ping', {}, options );

        this.#unwrap( 'ping', res );
    }

    public async listTools( options?: MCPRequestOptions ): Promise<MCPTool[]>
    {
        this.#requireCapability( 'tools', 'tools/list' );

        return this.#paginate<MCPTool>( 'tools/list', 'tools', options );
    }

    public async listResources( options?: MCPRequestOptions ): Promise<MCPResource[]>
    {
        this.#requireCapability( 'resources', 'resources/list' );

        return this.#paginate<MCPResource>( 'resources/list', 'resources', options );
    }

    public async listResourceTemplates( options?: MCPRequestOptions ): Promise<MCPResourceTemplate[]>
    {
        this.#requireCapability( 'resources', 'resources/templates/list' );

        return this.#paginate<MCPResourceTemplate>( 'resources/templates/list', 'resourceTemplates', options );
    }

    public async readResource( uri: string, options?: MCPRequestOptions ): Promise<MCPResourceContents[]>
    {
        this.#requireCapability( 'resources', 'resources/read' );

        const res = await this.request( 'resources/read', { uri }, options );
        const result = this.#unwrap( 'resources/read', res );

        return validateResourceContents( result.contents, 'resources/read' );
    }

    public async listPrompts( options?: MCPRequestOptions ): Promise<MCPPrompt[]>
    {
        this.#requireCapability( 'prompts', 'prompts/list' );

        return this.#paginate<MCPPrompt>( 'prompts/list', 'prompts', options );
    }

    public async getPrompt( name: string, args: Record<string, string> = {}, options?: MCPRequestOptions ): Promise<MCPGetPromptResult>
    {
        this.#requireCapability( 'prompts', 'prompts/get' );

        const res = await this.request( 'prompts/get', { name, arguments : args }, options );
        const result = this.#unwrap( 'prompts/get', res );

        if( !Array.isArray( result.messages ) )
        {
            throw new AIError( 'MCP prompts/get result is missing a messages array', 'MCP_PROTOCOL_ERROR', { name } );
        }

        return result as unknown as MCPGetPromptResult;
    }

    #assertConnected( method: string ): void
    {
        if( this.#closed )
        {
            throw new AIError( 'MCP client closed', 'MCP_CLIENT_CLOSED' );
        }

        if( !this.#serverCapabilities )
        {
            throw new AIError( `MCP '${method}' called before connect() completed`, 'MCP_NOT_CONNECTED', { method } );
        }
    }

    #requireCapability( capability: MCPCapabilityName, method: string ): void
    {
        this.#assertConnected( method );

        if( this.#strictCapabilities && !this.#serverCapabilities![capability] )
        {
            throw new AIError( 
                `MCP server did not advertise the '${capability}' capability; cannot call '${method}'`, 
                'MCP_CAPABILITY_MISSING', 
                { capability, method } 
            );
        }
    }

    #unwrap( method: string, res: JSONRPCResponse ): Record<string, unknown>
    {
        if( res.error )
        {
            throw new AIError( `MCP ${method} failed: ${res.error.message}`, 'MCP_CLIENT_ERROR', res.error );
        }

        const result = res.result as Record<string, unknown> | undefined;

        if( !result || typeof result !== 'object' || Array.isArray( result ) )
        {
            throw new AIError( `MCP ${method} returned no result object`, 'MCP_PROTOCOL_ERROR', { method } );
        }

        return result;
    }

    async #paginate<T>( method: string, key: string, options?: MCPRequestOptions ): Promise<T[]>
    {
        const items: T[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;

        for( let page = 0; page < this.#maxPages; page++ )
        {
            const res = await this.request( method, cursor === undefined ? {} : { cursor }, options );
            const result = this.#unwrap( method, res );
            const pageItems = result[key];

            if( !Array.isArray( pageItems ) )
            {
                throw new AIError( `MCP ${method} result is missing the '${key}' array`, 'MCP_PROTOCOL_ERROR', { method, key } );
            }

            items.push( ...( pageItems as T[] ) );

            const next = result.nextCursor;

            if( next === undefined || next === null )
            {
                return items;
            }

            if( typeof next !== 'string' || next === '' )
            {
                throw new AIError( `MCP ${method} returned an invalid nextCursor`, 'MCP_PROTOCOL_ERROR', { method, nextCursor : next } );
            }

            if( seen.has( next ) )
            {
                throw new AIError( `MCP ${method} returned a repeated cursor; refusing to loop`, 'MCP_PAGINATION_LOOP', { method, cursor : next } );
            }

            seen.add( next );
            cursor = next;
        }

        throw new AIError( 
            `MCP ${method} exceeded maxPages (${this.#maxPages}); the server keeps returning nextCursor`, 
            'MCP_PAGINATION_LIMIT', 
            { method, maxPages : this.#maxPages } 
        );
    }

    public async callTool( 
        name: string, 
        args: Record<string, unknown> = {}, 
        options?: MCPCallOptions 
    ): Promise<MCPToolResult>
    {
        this.#requireCapability( 'tools', 'tools/call' );

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
        options: MCPRequestOptions = {}
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
            const abortHook: { handler?: () => void } = {};

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

                if( abortHook.handler )
                {
                    options.signal?.removeEventListener( 'abort', abortHook.handler );
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

            abortHook.handler = (): void => 
            {
                void this.#sendCancelled( id, method );
                finish( undefined, new AIError( `MCP request '${method}' aborted`, 'MCP_REQUEST_ABORTED', { id, method } ) );
            };

            if( options.signal?.aborted )
            {
                abortHook.handler();

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
                resolve : ( res ) => {finish( res );},
                reject  : ( err ) => {finish( undefined, err );},
                method,
                timer
            } );

            options.signal?.addEventListener( 'abort', abortHook.handler, { once : true } );

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

    #reportError( error: unknown ): void
    {
        const err = error instanceof Error ? error : new AIError( String( error ), 'MCP_CLIENT_ERROR' );

        if( this.#onError )
        {
            this.#onError( err );

            return;
        }

        // Nobody asked to handle it; do not swallow it.
        queueMicrotask( () => 
        {
            throw err;
        } );
    }

    #handleServerRequest( req: JSONRPCRequest ): void
    {
        if( this.#closed )
        {
            return;
        }

        const response: JSONRPCResponse = req.method === 'ping'
            ? { jsonrpc : '2.0', id : req.id, result : {} }
            : {
                jsonrpc : '2.0',
                id      : req.id,
                error   : { code : JSONRPC_METHOD_NOT_FOUND, message : `Method '${req.method}' is not supported by this client` }
            };

        this.#transport.send( response ).catch( ( err: unknown ) => 
        {
            this.#reportError( err );
        } );
    }

    #dispatchNotification( notification: JSONRPCNotification ): void
    {
        for( const handler of [ ...this.#notificationHandlers ] )
        {
            try
            {
                handler( notification );
            }
            catch( error: unknown )
            {
                this.#reportError( error );
            }
        }
    }

    private handleIncoming( message: JSONRPCMessage ): void
    {
        if( 'method' in message )
        {
            if( 'id' in message && message.id !== undefined )
            {
                this.#handleServerRequest( message as JSONRPCRequest );
            }
            else
            {
                this.#dispatchNotification( message as JSONRPCNotification );
            }

            return;
        }

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
