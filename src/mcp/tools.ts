import { validateSchema, type JsonSchema } from '@webergency-utils/typechecker';
import { AIError } from '../core/error.js';
import { createTool, type Tool } from '../agent/tool.js';
import type { MCPClient } from './client.js';
import type { MCPTool, MCPToolResult } from './types.js';

export interface MCPToolsOptions
{
    /** Prepended to every bound tool name (the server-side name is still used on the wire). */
    prefix?  : string
    /** Only bind tools whose server-side name is listed / matches. */
    include? : string[] | RegExp
    /** Skip tools whose server-side name is listed / matches (applied after `include`). */
    exclude? : string[] | RegExp
}

function matches( filter: string[] | RegExp, name: string ): boolean
{
    if( filter instanceof RegExp )
    {
        // Reset stateful (global / sticky) expressions so repeated tests are deterministic.
        filter.lastIndex = 0;

        return filter.test( name );
    }

    return filter.includes( name );
}

function assertSchemaUsable( tool: MCPTool ): void
{
    try
    {
        // Compiling the schema is eager: unsupported types and unresolved references throw here.
        validateSchema( tool.inputSchema as JsonSchema, {}, 'strip' );
    }
    catch( error )
    {
        throw new AIError( 
            `MCP tool '${tool.name}' has an input schema this toolkit cannot validate: ${error instanceof Error ? error.message : String( error )}`, 
            'MCP_UNSUPPORTED_SCHEMA', 
            { tool : tool.name, cause : error instanceof Error ? error.message : String( error ) } 
        );
    }
}

/**
 * Converts an MCP tool result into the string a model sees. `isError` results and any
 * non-text content are surfaced as thrown errors, never dropped.
 */
export function mcpResultToText( toolName: string, result: MCPToolResult ): string
{
    const items = Array.isArray( result?.content ) ? result.content : [];

    if( result?.isError )
    {
        const message = items
            .filter( ( item ) => {return item.type === 'text' && typeof item.text === 'string';} )
            .map( ( item ) => {return item.text;} )
            .join( '\n' );

        throw new AIError( 
            `MCP tool '${toolName}' failed: ${message || 'no error detail returned'}`, 
            'MCP_TOOL_ERROR', 
            { tool : toolName, content : items } 
        );
    }

    const texts: string[] = [];

    for( const item of items )
    {
        if( item.type !== 'text' )
        {
            throw new AIError( 
                `MCP tool '${toolName}' returned unsupported content of type '${String( item.type )}'`, 
                'MCP_UNSUPPORTED_CONTENT', 
                { tool : toolName, type : item.type } 
            );
        }

        if( typeof item.text !== 'string' )
        {
            throw new AIError( 
                `MCP tool '${toolName}' returned a text item without text`, 
                'MCP_UNSUPPORTED_CONTENT', 
                { tool : toolName, type : item.type } 
            );
        }

        texts.push( item.text );
    }

    return texts.join( '\n' );
}

/**
 * Binds every tool of a connected `MCPClient` as an executable agent `Tool`.
 * Tool `parameters` are the server `inputSchema` verbatim; schemas the validator cannot
 * compile fail here (bind time), duplicate resulting names throw before returning.
 */
export async function createMCPTools( client: MCPClient, options: MCPToolsOptions = {} ): Promise<Tool[]>
{
    const prefix = options.prefix ?? '';
    const listed = await client.listTools();
    const tools: Tool[] = [];
    const seen = new Set<string>();

    for( const definition of listed )
    {
        if( options.include && !matches( options.include, definition.name ) )
        {
            continue;
        }

        if( options.exclude && matches( options.exclude, definition.name ) )
        {
            continue;
        }

        const name = `${prefix}${definition.name}`;

        if( seen.has( name ) )
        {
            throw new AIError( 
                `Duplicate MCP tool name '${name}'; use a different prefix or exclude one of the tools`, 
                'MCP_DUPLICATE_TOOL', 
                { name } 
            );
        }

        seen.add( name );

        const inputSchema = definition.inputSchema ?? { type : 'object', properties : {} };

        assertSchemaUsable( { ...definition, inputSchema } );

        tools.push( createTool( {
            name,
            description : definition.description ?? '',
            parameters  : inputSchema,
            execute     : async ( args, context, runOptions ) => 
            {
                const result = await client.callTool( definition.name, args, { context, signal : runOptions?.signal } );

                return mcpResultToText( name, result );
            }
        } ) );
    }

    return tools;
}
