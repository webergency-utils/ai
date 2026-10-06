export const START = '<!-- capabilities:start -->';
export const END = '<!-- capabilities:end -->';

const yes = ( value ) => ( value ? 'yes' : '-' );

/**
 * Render the provider capability table from adapter `capabilities` flags.
 * @param {Record<string, { structuredOutput: boolean, embeddings: boolean, reasoningContent: boolean, promptCacheControl: boolean, multimodal: Record<string, boolean> }>} byProvider
 */
export function renderCapabilityTable( byProvider )
{
    const header = [ 'Provider', 'Structured output', 'Reasoning content', 'Prompt cache', 'Embeddings', 'Image', 'Audio', 'Video', 'Document' ];
    const rows = Object.entries( byProvider ).map( ( [ provider, c ] ) =>
        [ `\`${ provider }\``, yes( c.structuredOutput ), yes( c.reasoningContent ), yes( c.promptCacheControl ), yes( c.embeddings ), yes( c.multimodal.image ), yes( c.multimodal.audio ), yes( c.multimodal.video ), yes( c.multimodal.document ) ] );

    return [ header, header.map( () => '---' ), ...rows ].map( ( cells ) => `| ${ cells.join( ' | ' ) } |` ).join( '\n' );
}

/** Replace the block between the markers; throws when the markers are missing. */
export function replaceBlock( markdown, table )
{
    const start = markdown.indexOf( START );
    const end = markdown.indexOf( END );

    if( start < 0 || end < start )
    {
        throw new Error( `README.md must contain ${ START } and ${ END }` );
    }

    return `${ markdown.slice( 0, start + START.length ) }\n${ table }\n${ markdown.slice( end ) }`;
}
