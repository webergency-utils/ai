// Runs inside the temporary consumer project created by scripts/smoke-pack.mjs.
// Works under Node and Bun: imports every public subpath and asserts a known export exists.
const EXPECTED = {
    '.'           : [ 'createModel', 'Agent', 'MemoryDocStore', 'SpendTracker', 'TraceCollector' ],
    './core'      : [ 'AIError', 'schema' ],
    './providers' : [ 'createModel', 'OpenAIProviderAdapter' ],
    './storage'   : [ 'MemoryDocStore' ],
    './mcp'       : [ 'MCPClient', 'MCPServer' ],
    './spend'     : [ 'SpendTracker' ],
    './agent'     : [ 'Agent', 'createTool' ],
    './workflow'  : [ 'Workflow' ],
    './trace'     : [ 'TraceCollector', 'exportTraceToOTLP' ]
};

const NAME = '@webergency-utils/ai';
const failures = [];

for( const [ subpath, names ] of Object.entries( EXPECTED ) )
{
    const specifier = subpath === '.' ? NAME : `${ NAME }/${ subpath.slice( 2 ) }`;

    try
    {
        const mod = await import( specifier );

        for( const name of names )
        {
            if( typeof mod[name] === 'undefined' )
            {
                failures.push( `${ specifier }: missing export "${ name }"` );
            }
        }
    }
    catch( error )
    {
        failures.push( `${ specifier }: import failed (${ error?.message ?? error })` );
    }
}

const { default: pkg } = await import( `${ NAME }/package.json`, { with : { type : 'json' } } );

if( pkg.name !== NAME )
{
    failures.push( `${ NAME }/package.json: unexpected name "${ pkg.name }"` );
}

// "No vendor SDK required": every optional peer must be absent from this project.
for( const peer of [ 'openai', '@anthropic-ai/sdk', '@google/genai', 'ollama' ] )
{
    try
    {
        await import( peer );
        failures.push( `optional peer "${ peer }" is installed in the smoke project; the absence check is invalid` );
    }
    catch { /* expected: not installed */ }
}

if( failures.length )
{
    console.error( failures.join( '\n' ) );
    process.exit( 1 );
}

console.log( `smoke-imports: ok (${ Object.keys( EXPECTED ).length } subpaths, runtime ${ typeof Bun !== 'undefined' ? 'bun' : 'node' } )` );
