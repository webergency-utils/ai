import { describe, it, expect } from 'vitest';
import { decideLiveProviders, formatDecisionTable, liveEnabled, requiredProviders, type LiveProviderSpec } from '../live/gating.js';

const providers: LiveProviderSpec[] =
    [
        { id : 'openai', keyEnv : 'OPENAI_API_KEY', model : 'm' },
        { id : 'anthropic', keyEnv : 'ANTHROPIC_API_KEY', model : 'm' },
        { id : 'ollama', model : 'm', baseUrl : 'http://localhost:11434' }
    ];

describe( 'live suite gating (R15)', () =>
{
    it( 'is enabled only by AI_LIVE=1', () =>
    {
        expect( liveEnabled( {} ) ).toBe( false );
        expect( liveEnabled( { AI_LIVE : 'true' } ) ).toBe( false );
        expect( liveEnabled( { AI_LIVE : '1' } ) ).toBe( true );
    } );

    it( 'runs providers with keys and skips the rest with a printed reason', () =>
    {
        const decisions = decideLiveProviders( { env : { AI_LIVE : '1', OPENAI_API_KEY : 'k' }, providers } );

        expect( decisions[0] ).toEqual( { provider : 'openai', action : 'run' } );
        expect( decisions[1] ).toEqual( { provider : 'anthropic', action : 'skip', reason : 'ANTHROPIC_API_KEY is not set' } );
        expect( decisions[2] ).toMatchObject( { provider : 'ollama', action : 'skip', reason : expect.stringContaining( 'not reachable' ) } );
        expect( formatDecisionTable( decisions ) ).toContain( 'ANTHROPIC_API_KEY is not set' );
    } );

    it( 'AE8: fails (not skips) a required provider whose key is missing', () =>
    {
        const withRequire = decideLiveProviders( { env : { AI_LIVE : '1', AI_LIVE_REQUIRE : 'openai' }, providers } );
        expect( withRequire[0] ).toMatchObject( { provider : 'openai', action : 'fail' } );
        expect( ( withRequire[0] as { reason: string } ).reason ).toContain( 'OPENAI_API_KEY' );

        const without = decideLiveProviders( { env : { AI_LIVE : '1' }, providers } );
        expect( without[0]!.action ).toBe( 'skip' );
    } );

    it( 'treats keyless providers as runnable only when reachable, and honours AI_LIVE_REQUIRE for them', () =>
    {
        expect( decideLiveProviders( { env : {}, providers, reachable : { ollama : true } } )[2]!.action ).toBe( 'run' );
        expect( decideLiveProviders( { env : { AI_LIVE_REQUIRE : ' Ollama , ' }, providers } )[2]!.action ).toBe( 'fail' );
        expect( [ ...requiredProviders( { AI_LIVE_REQUIRE : 'a, b' } ) ] ).toEqual( [ 'a', 'b' ] );
    } );
} );
