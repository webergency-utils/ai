import { AIError } from '../core/error.js';
import type { MCPResourceContents } from './types.js';

/**
 * Validates resource contents received from (or produced for) the wire: every item has a `uri`,
 * and exactly one of `text` / `blob` (both or neither is rejected, never repaired).
 */
export function validateResourceContents( contents: unknown, source: string ): MCPResourceContents[]
{
    if( !Array.isArray( contents ) )
    {
        throw new AIError( `MCP ${source}: 'contents' must be an array`, 'MCP_INVALID_RESOURCE_CONTENT', { source } );
    }

    return contents.map( ( item: unknown, index: number ) => 
    {
        if( !item || typeof item !== 'object' )
        {
            throw new AIError( `MCP ${source}: contents[${index}] must be an object`, 'MCP_INVALID_RESOURCE_CONTENT', { source, index } );
        }

        const entry = item as Record<string, unknown>;

        if( typeof entry.uri !== 'string' || entry.uri === '' )
        {
            throw new AIError( `MCP ${source}: contents[${index}] is missing 'uri'`, 'MCP_INVALID_RESOURCE_CONTENT', { source, index } );
        }

        const hasText = entry.text !== undefined;
        const hasBlob = entry.blob !== undefined;

        if( hasText === hasBlob )
        {
            throw new AIError( 
                `MCP ${source}: contents[${index}] must carry exactly one of 'text' or 'blob' (got ${hasText ? 'both' : 'neither'})`, 
                'MCP_INVALID_RESOURCE_CONTENT', 
                { source, index, uri : entry.uri } 
            );
        }

        if( hasText && typeof entry.text !== 'string' )
        {
            throw new AIError( `MCP ${source}: contents[${index}].text must be a string`, 'MCP_INVALID_RESOURCE_CONTENT', { source, index } );
        }

        if( hasBlob && typeof entry.blob !== 'string' )
        {
            throw new AIError( `MCP ${source}: contents[${index}].blob must be a base64 string`, 'MCP_INVALID_RESOURCE_CONTENT', { source, index } );
        }

        if( entry.mimeType !== undefined && typeof entry.mimeType !== 'string' )
        {
            throw new AIError( `MCP ${source}: contents[${index}].mimeType must be a string`, 'MCP_INVALID_RESOURCE_CONTENT', { source, index } );
        }

        return entry as unknown as MCPResourceContents;
    } );
}
