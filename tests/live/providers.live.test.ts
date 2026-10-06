import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CASES, buildContext } from './cases.js';
import { decideLiveProviders, formatDecisionTable, liveEnabled } from './gating.js';
import { LIVE_PROVIDERS } from './providers.js';
import { recordingFetch, type Recorder } from '../helpers/recording.js';

const RECORD_DIR = fileURLToPath( new URL( '../fixtures/recorded/', import.meta.url ) );
const env = process.env;
const enabled = liveEnabled( env );
const record = env.AI_RECORD === '1';
const onlyProvider = env.AI_LIVE_PROVIDER;

async function probe( baseUrl: string ): Promise<boolean>
{
    try
    {
        const response = await fetch( `${ baseUrl }/api/tags`, { signal : AbortSignal.timeout( 1_500 ) } );

        return response.ok;
    }
    catch
    {
        return false;
    }
}

if( !enabled )
{
    describe.skip( 'live providers (set AI_LIVE=1 to run; see README "Live provider tests")', () =>
    {
        it( 'is opt-in', () => undefined );
    } );
}
else
{
    const reachable: Record<string, boolean> = {};
    let decisions = decideLiveProviders( { env, providers : LIVE_PROVIDERS } );

    beforeAll( async () =>
    {
        for( const spec of LIVE_PROVIDERS.filter( ( p ) => !p.keyEnv && p.baseUrl ) )
        {
            reachable[spec.id] = await probe( spec.baseUrl! );
        }

        decisions = decideLiveProviders( { env, providers : LIVE_PROVIDERS, reachable } );
        console.info( formatDecisionTable( decisions ) );
    } );

    const realFetch = globalThis.fetch;
    let recorder: Recorder | undefined;

    afterEach( () =>
    {
        vi.unstubAllGlobals();
        globalThis.fetch = realFetch;
        recorder = undefined;
    } );

    for( const spec of LIVE_PROVIDERS.filter( ( p ) => !onlyProvider || p.id === onlyProvider ) )
    {
        describe( `live: ${ spec.id }`, () =>
        {
            // Decisions depend on probing, so gate inside each test rather than at collection time.
            const gate = (): 'run' | 'skip' =>
            {
                const decision = decisions.find( ( d ) => d.provider === spec.id )!;

                if( decision.action === 'fail' )
                {
                    expect.fail( decision.reason );
                }

                return decision.action === 'skip' ? 'skip' : 'run';
            };

            for( const liveCase of CASES )
            {
                it( `${ liveCase.title }`, async ( ctx ) =>
                {
                    if( gate() === 'skip' )
                    {
                        const reason = ( decisions.find( ( d ) => d.provider === spec.id ) as { reason: string } ).reason;
                        ctx.skip( reason );

                        return;
                    }

                    const context = buildContext( spec, spec.keyEnv ? env[spec.keyEnv] : undefined );

                    if( !liveCase.applies( context.model.capabilities, spec ) )
                    {
                        ctx.skip( `${ liveCase.id } not supported by ${ spec.id }` );

                        return;
                    }

                    if( record )
                    {
                        recorder = recordingFetch( realFetch as never, { dir : RECORD_DIR, name : `${ spec.id }/${ liveCase.id }`, provider : spec.id, model : liveCase.id === 'embeddings' ? spec.embeddingModel! : spec.model } );
                        vi.stubGlobal( 'fetch', recorder.fetch );
                    }

                    await liveCase.run( context );

                    if( recorder )
                    {
                        console.info( `recorded ${ recorder.save() }` );
                    }
                } );
            }
        } );
    }
}
