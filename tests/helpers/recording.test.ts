import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ReplayMismatchError, UnsafeFixtureError, assertFixtureSafe, diffJson, findSecrets, loadFixture,
    recordingFetch, redactUrl, replayFetch, staleFixtures, type RecordedFixture
} from './recording.js';
import { jsonResponse, sseResponse } from './http.js';

let dir: string;

beforeEach( () => {dir = mkdtempSync( path.join( tmpdir(), 'ai-rec-' ) );} );
afterEach( () => {rmSync( dir, { recursive : true, force : true } );} );

const base = { provider : 'openai', model : 'gpt-test' };

function post( fetch: ( url: string, init: RequestInit ) => Promise<Response>, body: unknown, url = 'https://api.example.com/v1/chat', headers: Record<string, string> = {} )
{
    return fetch( url, { method : 'POST', headers : { 'content-type' : 'application/json', ...headers }, body : JSON.stringify( body ) } );
}

describe( 'recordingFetch', () =>
{
    it( 'stores allowlisted headers only and redacts key= query values', async () =>
    {
        const rec = recordingFetch( async () => jsonResponse( { ok : true } ), { dir, name : 'case', ...base } );

        await post( rec.fetch, { a : 1 }, 'https://api.example.com/v1beta/models/m:generate?key=AIzaSyFAKEFAKEFAKEFAKE&alt=sse',
            { authorization : 'Bearer sk-secret-token-value', 'x-api-key' : 'sk-ant-secretsecret', 'anthropic-version' : '2023-06-01' } );

        const file = rec.save();
        const text = readFileSync( file, 'utf8' );
        const fixture = JSON.parse( text ) as RecordedFixture;

        expect( fixture.interactions[0]!.request.headers ).toEqual( { 'content-type' : 'application/json', 'anthropic-version' : '2023-06-01' } );
        expect( fixture.interactions[0]!.request.url ).toContain( 'key=REDACTED' );
        expect( fixture.interactions[0]!.request.url ).toContain( 'alt=sse' );
        expect( findSecrets( text ) ).toEqual( [] );
        expect( fixture.source ).toBe( 'recorded' );
        expect( fixture.provider ).toBe( 'openai' );
    } );

    it( 'AE6: refuses to write a fixture whose response body contains a key', async () =>
    {
        const rec = recordingFetch( async () => jsonResponse( { echo : 'your key is sk-live-abcdef1234567890' } ), { dir, name : 'leaky', ...base } );

        await post( rec.fetch, {} );

        expect( () => rec.save() ).toThrow( UnsafeFixtureError );
        expect( () => rec.save() ).toThrow( /sk- key/ );
        expect( existsSync( path.join( dir, 'leaky.json' ) ) ).toBe( false );
    } );

    it.each( [
        [ 'Anthropic', 'sk-ant-api03-abcdefghijkl' ],
        [ 'Google', 'AIzaSyA1234567890abcdef' ],
        [ 'Groq', 'gsk_abcdefghijklmnop' ],
        [ 'Bearer', 'Authorization: Bearer abcdef.ghijkl' ]
    ] )( 'refuses %s secrets in request bodies', async ( _label, secret ) =>
    {
        const rec = recordingFetch( async () => jsonResponse( {} ), { dir, name : 'x', ...base } );

        await post( rec.fetch, { prompt : secret } );

        expect( () => rec.save() ).toThrow( UnsafeFixtureError );
    } );

    it( 'does not flag ordinary words that contain "sk-"', () =>
    {
        expect( findSecrets( '{"text":"risk-based task-force disk-backed"}' ) ).toEqual( [] );
    } );

    it( 'rejects fixtures that carry a header outside the allowlist', () =>
    {
        const fixture: RecordedFixture = { ...base, source       : 'recorded', recordedAt   : new Date().toISOString(), interactions : [
            { request : { method : 'POST', url : 'https://x.test/', headers : { authorization : 'redacted' } }, response : { status : 200, headers : {} } }
        ] };

        expect( () => assertFixtureSafe( fixture ) ).toThrow( /request header "authorization"/ );

        fixture.interactions[0]!.request.headers = {};
        fixture.interactions[0]!.response.headers = { 'set-cookie' : 'a=b' };
        expect( () => assertFixtureSafe( fixture ) ).toThrow( /response header "set-cookie"/ );
    } );

    it( 'records streamed responses as a chunk list and replays them as a stream', async () =>
    {
        const events = [ 'data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: [DONE]\n\n' ];
        const rec = recordingFetch( async () => sseResponse( events ), { dir, name : 'stream', ...base, source : 'synthetic', note : 'unit test' } );

        const live = await post( rec.fetch, { stream : true } );
        expect( await live.text() ).toBe( events.join( '' ) );
        rec.save();

        const fixture = loadFixture( dir, 'stream' );
        expect( fixture.source ).toBe( 'synthetic' );
        expect( fixture.note ).toBe( 'unit test' );
        expect( fixture.interactions[0]!.response.chunks!.join( '' ) ).toBe( events.join( '' ) );
        expect( fixture.interactions[0]!.response.body ).toBeUndefined();

        const replay = replayFetch( { dir, name : 'stream' } );
        const res = await post( replay.fetch, { stream : true } );
        expect( res.headers.get( 'content-type' ) ).toContain( 'text/event-stream' );
        expect( await res.text() ).toBe( events.join( '' ) );
        replay.assertAllUsed();
    } );

    it( 'stores non-JSON bodies as text and empty bodies as absent', async () =>
    {
        let n = 0;
        const rec = recordingFetch( async () => ( n++ === 0 ? new Response( 'plain', { status : 500 } ) : new Response( null, { status : 204 } ) ), { dir, name : 'plain', ...base } );

        await rec.fetch( 'https://x.test/a' );
        await rec.fetch( 'https://x.test/b', { method : 'DELETE' } );
        rec.save();

        const fixture = loadFixture( dir, 'plain' );
        expect( fixture.interactions[0]!.response ).toMatchObject( { status : 500, body : 'plain' } );
        expect( fixture.interactions[0]!.request.method ).toBe( 'GET' );
        expect( fixture.interactions[1]!.response.body ).toBeUndefined();
        expect( fixture.interactions[1]!.request.method ).toBe( 'DELETE' );
    } );

    it( 'redactUrl leaves URLs without secrets untouched', () =>
    {
        expect( redactUrl( 'https://x.test/a?b=1' ) ).toBe( 'https://x.test/a?b=1' );
    } );
} );

describe( 'replayFetch', () =>
{
    async function record( request: unknown, response: unknown = { ok : true }, url = 'https://api.example.com/v1/chat' )
    {
        const rec = recordingFetch( async () => jsonResponse( response ), { dir, name : 'case', ...base } );
        await post( rec.fetch, request, url );
        rec.save();
    }

    it( 'serves the recorded response for a matching request, independent of key order', async () =>
    {
        await record( { model : 'm', max_tokens : 5, messages : [ { role : 'user', content : 'hi' } ] }, { id : 1 } );

        const replay = replayFetch( { dir, name : 'case' } );
        const res = await post( replay.fetch, { messages : [ { content : 'hi', role : 'user' } ], max_tokens : 5, model : 'm' } );

        expect( await res.json() ).toEqual( { id : 1 } );
        expect( replay.served ).toBe( 1 );
        replay.assertAllUsed();
    } );

    it( 'AE7: fails with a body diff when max_tokens is renamed', async () =>
    {
        await record( { model : 'm', max_tokens : 5 } );

        const replay = replayFetch( { dir, name : 'case' } );
        const error = await post( replay.fetch, { model : 'm', max_completion_tokens : 5 } ).catch( ( e ) => e );

        expect( error ).toBeInstanceOf( ReplayMismatchError );
        expect( error.diff ).toEqual( expect.arrayContaining( [
            expect.stringContaining( 'body.max_tokens' ),
            expect.stringContaining( 'body.max_completion_tokens' )
        ] ) );
        expect( error.message ).toContain( 'drifted from the recording' );
    } );

    it( 'ignores volatile keys and honours extra ignoreKeys', async () =>
    {
        await record( { model : 'm', request_id : 'a', trace : 'x' } );

        const replay = replayFetch( { dir, name : 'case', ignoreKeys : [ 'trace' ] } );
        await expect( post( replay.fetch, { model : 'm', request_id : 'b', trace : 'y' } ) ).resolves.toBeInstanceOf( Response );
    } );

    it( 'detects method, path and query drift', async () =>
    {
        await record( { a : 1 }, {}, 'https://api.example.com/v1/chat?alt=sse&key=AIzaSyFAKEFAKEFAKEFAKE' );

        const wrongMethod = replayFetch( { dir, name : 'case' } );
        await expect( wrongMethod.fetch( 'https://api.example.com/v1/chat?alt=sse', { method : 'GET' } ) ).rejects.toThrow( /method/ );

        const wrongPath = replayFetch( { dir, name : 'case' } );
        await expect( post( wrongPath.fetch, { a : 1 }, 'https://api.example.com/v2/chat?alt=sse' ) ).rejects.toThrow( /path: recorded \/v1\/chat/ );

        const wrongQuery = replayFetch( { dir, name : 'case' } );
        await expect( post( wrongQuery.fetch, { a : 1 }, 'https://api.example.com/v1/chat?alt=json' ) ).rejects.toThrow( /query\.alt/ );

        const secretQueryIgnored = replayFetch( { dir, name : 'case' } );
        await expect( post( secretQueryIgnored.fetch, { a : 1 }, 'https://api.example.com/v1/chat?alt=sse&key=whatever' ) ).resolves.toBeInstanceOf( Response );
    } );

    it( 'rejects extra requests and reports unused interactions', async () =>
    {
        await record( { a : 1 } );

        const replay = replayFetch( { dir, name : 'case' } );
        expect( () => replay.assertAllUsed() ).toThrow( /never requested/ );

        await post( replay.fetch, { a : 1 } );
        await expect( post( replay.fetch, { a : 1 } ) ).rejects.toThrow( /unexpected extra request #2/ );
    } );

    it( 'replays non-JSON text bodies and error statuses', async () =>
    {
        const rec = recordingFetch( async () => new Response( 'boom', { status : 503 } ), { dir, name : 'err', ...base } );
        await rec.fetch( 'https://x.test/a' );
        rec.save();

        const res = await replayFetch( { dir, name : 'err' } ).fetch( 'https://x.test/a' );
        expect( res.status ).toBe( 503 );
        expect( await res.text() ).toBe( 'boom' );
    } );
} );

describe( 'diffJson', () =>
{
    it( 'reports scalar, array and nested differences', () =>
    {
        expect( diffJson( { a : [ 1, 2 ], b : { c : 1 } }, { a : [ 1, 3 ], b : { c : 1 } } ) ).toEqual( [ '~ body.a[1]: recorded 2, request sent 3' ] );
        expect( diffJson( [ 1 ], [ 1, 2 ] ) ).toEqual( [ '~ body: recorded [1], request sent [1,2]' ] );
        expect( diffJson( { a : 1 }, { a : 1 } ) ).toEqual( [] );
    } );
} );

describe( 'staleFixtures (R16)', () =>
{
    const fixture = ( source: RecordedFixture['source'], recordedAt: string ): RecordedFixture => ( { ...base, source, recordedAt, interactions : [] } );

    it( 'flags recorded fixtures older than 180 days and ignores synthetic ones', () =>
    {
        const now = new Date( '2026-10-06T00:00:00Z' );
        const stale = staleFixtures( [
            { name : 'old', fixture : fixture( 'recorded', '2026-01-01T00:00:00Z' ) },
            { name : 'new', fixture : fixture( 'recorded', '2026-09-01T00:00:00Z' ) },
            { name : 'seed', fixture : fixture( 'synthetic', '2020-01-01T00:00:00Z' ) }
        ], now );

        expect( stale ).toHaveLength( 1 );
        expect( stale[0] ).toContain( 'old' );
    } );
} );

describe( 'R13: committed fixtures contain no secrets', () =>
{
    const root = fileURLToPath( new URL( '../fixtures/recorded/', import.meta.url ) );

    function walk( dirPath: string ): string[]
    {
        if( !existsSync( dirPath ) ) return [];

        return readdirSync( dirPath ).flatMap( ( entry ) =>
        {
            const full = path.join( dirPath, entry );

            return statSync( full ).isDirectory() ? walk( full ) : [ full ];
        } );
    }

    const files = walk( root );

    it( 'has recorded fixtures to scan', () =>
    {
        expect( files.length ).toBeGreaterThan( 0 );
    } );

    it.each( files.map( ( f ) => [ path.relative( root, f ), f ] ) )( '%s passes the safety scan', ( _name, file ) =>
    {
        const text = readFileSync( file!, 'utf8' );

        expect( findSecrets( text ) ).toEqual( [] );
        expect( () => assertFixtureSafe( JSON.parse( text ) ) ).not.toThrow();
    } );
} );
