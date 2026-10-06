/**
 * Replays recorded provider traffic through each adapter's real request path (R14, R16).
 * Cases live in tests/live/cases.ts and are shared with the opt-in live suite, so a fixture
 * recorded by `npm run record:fixtures` is replayed by exactly the code that recorded it.
 *
 * A `ReplayMismatchError` means an adapter's request no longer matches the recorded one.
 * Fix the adapter, or re-record if the provider's API changed on purpose.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, buildContext } from '../../live/cases.js';
import { providerSpec } from '../../live/providers.js';
import { ReplayMismatchError, loadFixture, replayFetch, staleFixtures } from '../../helpers/recording.js';

const ROOT = fileURLToPath( new URL( '../../fixtures/recorded/', import.meta.url ) );
const providers = readdirSync( ROOT, { withFileTypes : true } ).filter( ( e ) => e.isDirectory() ).map( ( e ) => e.name ).sort();

const all = providers.flatMap( ( provider ) =>
    readdirSync( path.join( ROOT, provider ) ).filter( ( f ) => f.endsWith( '.json' ) ).sort().map( ( file ) => ( { provider, caseId : file.replace( /\.json$/, '' ) } ) ) );

afterEach( () =>
{
    vi.unstubAllGlobals();
} );

describe( 'recorded provider replay', () =>
{
    it( 'has generate and stream fixtures for every provider adapter (success criterion)', () =>
    {
        const expected = [ 'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'deepseek', 'ollama' ];

        for( const provider of expected )
        {
            const cases = all.filter( ( f ) => f.provider === provider ).map( ( f ) => f.caseId );

            expect( cases, provider ).toEqual( expect.arrayContaining( [ 'generate', 'stream' ] ) );
        }
    } );

    it( 'warns (does not fail) about recorded fixtures older than 180 days', () =>
    {
        const stale = staleFixtures( all.map( ( f ) => ( { name : `${ f.provider }/${ f.caseId }`, fixture : loadFixture( ROOT, `${ f.provider }/${ f.caseId }` ) } ) ), new Date() );

        if( stale.length )
        {
            console.warn( `[recorded fixtures] ${ stale.length } fixture(s) older than 180 days; consider \`npm run record:fixtures\`:\n  ${ stale.join( '\n  ' ) }` );
        }

        expect( Array.isArray( stale ) ).toBe( true );
    } );

    it( 'AE7: an adapter request change surfaces as a ReplayMismatchError with a body diff', async () =>
    {
        const spec = providerSpec( 'openai' );
        const replay = replayFetch( { dir : ROOT, name : 'openai/generate' } );
        vi.stubGlobal( 'fetch', replay.fetch );

        const { model } = buildContext( spec, 'replay-key', replay.fixture.model );
        const error = await model.generate( { messages : [ { role : 'user', content : 'Reply with the single word: pong' } ], maxTokens : 65 } ).catch( ( e: unknown ) => e );

        expect( error ).toBeInstanceOf( ReplayMismatchError );
        expect( ( error as ReplayMismatchError ).diff.join( '\n' ) ).toMatch( /max_tokens|max_completion_tokens/ );
    } );

    describe.each( providers )( '%s', ( provider ) =>
    {
        const spec = providerSpec( provider );

        it.each( all.filter( ( f ) => f.provider === provider ).map( ( f ) => f.caseId ) )( '%s', async ( caseId ) =>
        {
            const liveCase = CASES.find( ( c ) => c.id === caseId );
            expect( liveCase, `fixture ${ provider }/${ caseId } has no matching case` ).toBeDefined();

            const name = `${ provider }/${ caseId }`;
            const replay = replayFetch( { dir : ROOT, name } );
            vi.stubGlobal( 'fetch', replay.fetch );

            const context = buildContext( spec, 'replay-key', replay.fixture.model );

            expect( liveCase!.applies( context.model.capabilities, spec ) ).toBe( true );

            await liveCase!.run( context );
            replay.assertAllUsed();
        } );
    } );
} );
