/**
 * Opt-in gating for the live provider suite (R15).
 *
 *  - `AI_LIVE=1` enables the suite at all.
 *  - A provider without credentials is skipped with a printed reason...
 *  - ...unless it is listed in `AI_LIVE_REQUIRE` (comma separated), in which case the suite fails.
 */
export interface LiveProviderSpec
{
    id            : string
    /** Environment variable holding the API key; `undefined` for keyless providers (Ollama). */
    keyEnv?       : string
    model         : string
    embeddingModel? : string
    baseUrl?      : string
}

export type LiveDecision =
    | { provider: string, action: 'run' }
    | { provider: string, action: 'skip', reason: string }
    | { provider: string, action: 'fail', reason: string };

export interface GatingInput
{
    env              : Record<string, string | undefined>
    providers        : LiveProviderSpec[]
    /** Result of probing a keyless local provider; `undefined` means "not probed". */
    reachable?       : Record<string, boolean>
}

export function liveEnabled( env: Record<string, string | undefined> ): boolean
{
    return env.AI_LIVE === '1';
}

export function requiredProviders( env: Record<string, string | undefined> ): Set<string>
{
    return new Set( ( env.AI_LIVE_REQUIRE ?? '' ).split( ',' ).map( ( s ) => s.trim().toLowerCase() ).filter( Boolean ) );
}

export function decideLiveProviders( { env, providers, reachable = {} }: GatingInput ): LiveDecision[]
{
    const required = requiredProviders( env );

    return providers.map( ( spec ): LiveDecision =>
    {
        const missing = spec.keyEnv
            ? ( env[spec.keyEnv] ? undefined : `${ spec.keyEnv } is not set` )
            : ( reachable[spec.id] ? undefined : `${ spec.baseUrl ?? 'local server' } is not reachable` );

        if( !missing )
        {
            return { provider : spec.id, action : 'run' };
        }

        return required.has( spec.id )
            ? { provider : spec.id, action : 'fail', reason : `${ missing } but AI_LIVE_REQUIRE lists "${ spec.id }"` }
            : { provider : spec.id, action : 'skip', reason : missing };
    } );
}

export function formatDecisionTable( decisions: LiveDecision[] ): string
{
    const rows = decisions.map( ( d ) => `  ${ d.provider.padEnd( 10 ) } ${ d.action.padEnd( 5 ) } ${ 'reason' in d ? d.reason : '' }`.trimEnd() );

    return [ 'Live provider suite:', ...rows ].join( '\n' );
}
