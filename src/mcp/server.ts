import type { ToolDefinition } from '../core/types.js';
import { AIError } from '../core/error.js';
import { toJsonSchema } from '../core/schema.js';
import type { 
    JSONRPCMessage, 
    JSONRPCRequest, 
    JSONRPCResponse, 
    MCPContentItem,
    MCPGetPromptResult,
    MCPPrompt,
    MCPPromptMessage,
    MCPResource,
    MCPResourceContents,
    MCPResourceTemplate,
    MCPServerCapabilities,
    MCPTool, 
    MCPTransport 
} from './types.js';
import { compileUriTemplate, type CompiledUriTemplate } from './uri-template.js';
import { validateResourceContents } from './resource-content.js';
import { 
    JSONRPC_INTERNAL_ERROR,
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



/** One piece of resource content a reader may return; `uri` / `mimeType` default to the resource's. */
export interface ResourceContentInput
{
    uri?      : string
    mimeType? : string
    text?     : string
    blob?     : string
}

/** A bare string is shorthand for one `text` content. */
export type ResourceReadResult = string | ResourceContentInput | ResourceContentInput[];

export type ResourceReader = ( uri: string, context?: ExecutionContext ) => Promise<ResourceReadResult> | ResourceReadResult;
export type ResourceTemplateReader = ( uri: string, variables: Record<string, string>, context?: ExecutionContext ) => Promise<ResourceReadResult> | ResourceReadResult;
export type PromptHandler = ( args: Record<string, string>, context?: ExecutionContext ) => Promise<MCPGetPromptResult | MCPPromptMessage[]> | MCPGetPromptResult | MCPPromptMessage[];

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
    readonly #resources = new Map<string, { info: MCPResource, read: ResourceReader }>();
    readonly #templates = new Map<string, { info: MCPResourceTemplate, compiled: CompiledUriTemplate, read: ResourceTemplateReader }>();
    readonly #prompts = new Map<string, { info: MCPPrompt, get: PromptHandler }>();

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

    /** Registers a fixed-URI resource. Advertises the `resources` capability from the next `initialize` on. */
    public registerResource( resource: MCPResource, read: ResourceReader ): void
    {
        if( !resource?.uri || typeof resource.uri !== 'string' || !resource.name || typeof resource.name !== 'string' )
        {
            throw new AIError( "registerResource requires a non-empty 'uri' and 'name'", 'INVALID_INPUT', { resource } );
        }

        if( this.#resources.has( resource.uri ) )
        {
            throw new AIError( `Resource '${resource.uri}' is already registered`, 'MCP_DUPLICATE_RESOURCE', { uri : resource.uri } );
        }

        this.#resources.set( resource.uri, { info : resource, read } );
    }

    /** Registers a `{var}` (RFC 6570 level 1) resource template; other expression operators throw here. */
    public registerResourceTemplate( template: MCPResourceTemplate, read: ResourceTemplateReader ): void
    {
        if( !template?.name || typeof template.name !== 'string' )
        {
            throw new AIError( "registerResourceTemplate requires a non-empty 'name'", 'INVALID_INPUT', { template } );
        }

        const compiled = compileUriTemplate( template.uriTemplate );

        if( this.#templates.has( template.uriTemplate ) )
        {
            throw new AIError( `Resource template '${template.uriTemplate}' is already registered`, 'MCP_DUPLICATE_RESOURCE', { uriTemplate : template.uriTemplate } );
        }

        this.#templates.set( template.uriTemplate, { info : template, compiled, read } );
    }

    public registerPrompt( prompt: MCPPrompt, get: PromptHandler ): void
    {
        if( !prompt?.name || typeof prompt.name !== 'string' )
        {
            throw new AIError( "registerPrompt requires a non-empty 'name'", 'INVALID_INPUT', { prompt } );
        }

        if( this.#prompts.has( prompt.name ) )
        {
            throw new AIError( `Prompt '${prompt.name}' is already registered`, 'MCP_DUPLICATE_PROMPT', { name : prompt.name } );
        }

        const seen = new Set<string>();

        for( const argument of prompt.arguments ?? [] )
        {
            if( !argument?.name || seen.has( argument.name ) )
            {
                throw new AIError( `Prompt '${prompt.name}' declares a missing or duplicate argument name`, 'INVALID_INPUT', { name : prompt.name, argument } );
            }

            seen.add( argument.name );
        }

        this.#prompts.set( prompt.name, { info : prompt, get } );
    }

    public createConnection(): MCPServerConnection
    {
        return { initialized : false };
    }

    #capabilities(): MCPServerCapabilities
    {
        // `tools` is always advertised (back-compat: tools may be registered after the handshake);
        // resources / prompts only when something of that kind is registered.
        const capabilities: MCPServerCapabilities = { tools : {} };

        if( this.#resources.size > 0 || this.#templates.size > 0 )
        {
            capabilities.resources = {};
        }

        if( this.#prompts.size > 0 )
        {
            capabilities.prompts = {};
        }

        return capabilities;
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

        if( req.method.startsWith( 'resources/' ) && this.#resources.size === 0 && this.#templates.size === 0 )
        {
            return this.#methodNotFound( req );
        }

        if( req.method.startsWith( 'prompts/' ) && this.#prompts.size === 0 )
        {
            return this.#methodNotFound( req );
        }

        switch ( req.method )
        {
            case 'resources/list':
                return { jsonrpc : '2.0', id : req.id, result : { resources : [ ...this.#resources.values() ].map( ( r ) => {return r.info;} ) } };

            case 'resources/templates/list':
                return { jsonrpc : '2.0', id : req.id, result : { resourceTemplates : [ ...this.#templates.values() ].map( ( t ) => {return t.info;} ) } };

            case 'resources/read':
                return this.#readResource( req, context );

            case 'prompts/list':
                return { jsonrpc : '2.0', id : req.id, result : { prompts : [ ...this.#prompts.values() ].map( ( p ) => {return p.info;} ) } };

            case 'prompts/get':
                return this.#getPrompt( req, context );

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
                return this.#methodNotFound( req );
        }
    }

    #methodNotFound( req: JSONRPCRequest ): JSONRPCResponse
    {
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

    #handlerContext( context?: ExecutionContext ): ExecutionContext | undefined
    {
        return context ?? ( this.#tracker ? new SimpleExecutionContext( { tracker : this.#tracker } ) : undefined );
    }

    async #readResource( req: JSONRPCRequest, context?: ExecutionContext ): Promise<JSONRPCResponse>
    {
        const uri = req.params?.uri;

        if( typeof uri !== 'string' || uri === '' )
        {
            return { jsonrpc : '2.0', id : req.id, error : { code : JSONRPC_INVALID_PARAMS, message : "resources/read requires a string 'uri'" } };
        }

        let read: () => Promise<ResourceReadResult> | ResourceReadResult;
        let defaultMimeType: string | undefined;
        const handlerContext = this.#handlerContext( context );
        const fixed = this.#resources.get( uri );

        if( fixed )
        {
            defaultMimeType = fixed.info.mimeType;
            read = () => {return fixed.read( uri, handlerContext );};
        }
        else
        {
            let resolved: { variables: Record<string, string>, entry: { info: MCPResourceTemplate, read: ResourceTemplateReader } } | undefined;

            for( const entry of this.#templates.values() )
            {
                const variables = entry.compiled.match( uri );

                if( variables )
                {
                    resolved = { variables, entry };
                    break;
                }
            }

            if( !resolved )
            {
                return { jsonrpc : '2.0', id : req.id, error : { code : JSONRPC_INVALID_PARAMS, message : `Resource '${uri}' not found`, data : { uri } } };
            }

            defaultMimeType = resolved.entry.info.mimeType;
            read = () => {return resolved.entry.read( uri, resolved.variables, handlerContext );};
        }

        try
        {
            const raw = await read();
            const items: ResourceContentInput[] = typeof raw === 'string' ? [ { text : raw } ] : Array.isArray( raw ) ? raw : [ raw ];

            const contents: MCPResourceContents[] = validateResourceContents( 
                items.map( ( item ) => 
                {
                    if( !item || typeof item !== 'object' )
                    {
                        return item;
                    }

                    const content: Record<string, unknown> = { ...item, uri : item.uri ?? uri };
                    const mimeType = item.mimeType ?? defaultMimeType;

                    if( mimeType !== undefined )
                    {
                        content.mimeType = mimeType;
                    }

                    return content;
                } ), 
                `resource '${uri}'` 
            );

            return { jsonrpc : '2.0', id : req.id, result : { contents } };
        }
        catch( err: unknown )
        {
            return { 
                jsonrpc : '2.0', 
                id      : req.id, 
                error   : { code : JSONRPC_INTERNAL_ERROR, message : `Resource '${uri}' could not be read: ${err instanceof Error ? err.message : String( err )}` } 
            };
        }
    }

    async #getPrompt( req: JSONRPCRequest, context?: ExecutionContext ): Promise<JSONRPCResponse>
    {
        const invalid = ( message: string, data?: unknown ): JSONRPCResponse => 
        {
            return { jsonrpc : '2.0', id : req.id, error : { code : JSONRPC_INVALID_PARAMS, message, data } };
        };

        const name = req.params?.name;

        if( typeof name !== 'string' || name === '' )
        {
            return invalid( "prompts/get requires a string 'name'" );
        }

        const registered = this.#prompts.get( name );

        if( !registered )
        {
            return invalid( `Prompt '${name}' not found`, { name } );
        }

        const rawArgs = req.params?.arguments ?? {};

        if( !rawArgs || typeof rawArgs !== 'object' || Array.isArray( rawArgs ) )
        {
            return invalid( "prompts/get 'arguments' must be an object of strings" );
        }

        const args = rawArgs as Record<string, unknown>;

        for( const [ key, value ] of Object.entries( args ) )
        {
            if( typeof value !== 'string' )
            {
                return invalid( `Prompt argument '${key}' must be a string`, { argument : key } );
            }
        }

        const declared = registered.info.arguments ?? [];
        const unknown = Object.keys( args ).filter( ( key ) => {return !declared.some( ( d ) => {return d.name === key;} );} );

        if( unknown.length > 0 )
        {
            return invalid( `Prompt '${name}' does not accept argument(s): ${unknown.join( ', ' )}`, { unknown } );
        }

        const missing = declared.filter( ( d ) => {return d.required && args[d.name] === undefined;} ).map( ( d ) => {return d.name;} );

        if( missing.length > 0 )
        {
            return invalid( `Prompt '${name}' is missing required argument(s): ${missing.join( ', ' )}`, { missing } );
        }

        try
        {
            const raw = await registered.get( args as Record<string, string>, this.#handlerContext( context ) );
            const result: MCPGetPromptResult = Array.isArray( raw ) ? { messages : raw } : raw;

            if( !result || typeof result !== 'object' || !Array.isArray( result.messages ) )
            {
                throw new AIError( 'prompt handler must return messages or { messages }', 'MCP_INVALID_PROMPT_RESULT' );
            }

            for( const [ index, message ] of result.messages.entries() )
            {
                if( ( message?.role !== 'user' && message?.role !== 'assistant' ) || !message.content || typeof message.content !== 'object' )
                {
                    throw new AIError( `prompt message ${index} needs a 'user' | 'assistant' role and a content object`, 'MCP_INVALID_PROMPT_RESULT' );
                }
            }

            return { jsonrpc : '2.0', id : req.id, result };
        }
        catch( err: unknown )
        {
            return { 
                jsonrpc : '2.0', 
                id      : req.id, 
                error   : { code : JSONRPC_INTERNAL_ERROR, message : `Prompt '${name}' failed: ${err instanceof Error ? err.message : String( err )}` } 
            };
        }
    }
}
