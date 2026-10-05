let ai;

module.exports.fuzz = async function( data )
{
    if( !ai )
    {
        ai = await import( './dist/index.js' );
    }

    try
    {
        if( !data || data.length < 4 )
        {
            return;
        }

        const str = data.toString( 'utf8' );

        // 1. Fuzz toJsonSchema / zodToJsonSchema
        try
        {
            ai.toJsonSchema( { type : str.slice( 0, 10 ) } );
            ai.zodToJsonSchema( { type : str.slice( 0, 10 ) } );
        }
        catch
        {
            // Expected
        }

        // 2. Fuzz spend calculator
        try
        {
            ai.calculateSpend( 'gpt-4o', 
            {
                promptTokens     : Math.abs( data.readInt32LE( 0 ) % 100000 ),
                completionTokens : Math.abs( ( data.length > 8 ? data.readInt32LE( 4 ) : 100 ) % 50000 ),
                totalTokens      : 150000
            });
        }
        catch
        {
            // Expected
        }

        // 3. Fuzz vector store with numeric values
        try
        {
            const vecStore = new ai.MemoryVectorStore();
            const vals = Array.from( data.slice( 0, 8 ) ).map( ( b ) => Number( b ) );
            await vecStore.upsert( [ { id : 'fuzz_1', values : vals } ] );
            await vecStore.query( vals, 1 );
        }
        catch
        {
            // Expected
        }
    }
    catch( e )
    {
        if( e instanceof RangeError || e instanceof TypeError || e?.name === 'AIError' )
        {
            return;
        }

        throw e;
    }
};
