/**
 * Fuzz target: SSE and NDJSON incremental decoders must yield the same
 * events for randomly split input as for the whole payload.
 * Throws on mismatch so Jazzer can find bugs (no blanket catch).
 */
let ai;

function assertDeepEqual( a, b, label )
{
    const left = JSON.stringify( a );
    const right = JSON.stringify( b );

    if( left !== right )
    {
        throw new Error( `${label}: split output !== whole output\nwhole=${right}\nsplit=${left}` );
    }
}

module.exports.fuzz = async function( data )
{
    if( !ai )
    {
        ai = await import( './dist/index.js' );
    }

    if( !data || data.length < 2 )
    {
        return;
    }

    const splitAt = data[0] % Math.max( 1, data.length );
    const payload = data.slice( 1 ).toString( 'utf8' );

    const ssePayload = payload.includes( 'data:' )
        ? payload
        : `data: ${JSON.stringify( { n : data[0] } )}\n\ndata: done\n\n`;
    const ndjsonPayload = payload.includes( '\n' )
        ? payload
        : `{"a":${data[0]}}\n{"b":${data[1] ?? 0}}`;

    const sseWhole = [];
    const sseDec = ai.createSSEDecoder();
    sseWhole.push( ...sseDec.push( ssePayload ), ...sseDec.flush() );

    const sseSplit = [];
    const sseDec2 = ai.createSSEDecoder();
    sseSplit.push( ...sseDec2.push( ssePayload.slice( 0, splitAt ) ) );
    sseSplit.push( ...sseDec2.push( ssePayload.slice( splitAt ) ) );
    sseSplit.push( ...sseDec2.flush() );
    assertDeepEqual( sseSplit, sseWhole, 'SSE' );

    const ndWhole = [];
    const ndDec = ai.createNDJSONDecoder();
    ndWhole.push( ...ndDec.push( ndjsonPayload ), ...ndDec.flush() );

    const ndSplit = [];
    const ndDec2 = ai.createNDJSONDecoder();
    ndSplit.push( ...ndDec2.push( ndjsonPayload.slice( 0, splitAt ) ) );
    ndSplit.push( ...ndDec2.push( ndjsonPayload.slice( splitAt ) ) );
    ndSplit.push( ...ndDec2.flush() );
    assertDeepEqual( ndSplit, ndWhole, 'NDJSON' );
};
