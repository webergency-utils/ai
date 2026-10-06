/**
 * Record/replay harness for provider wire formats (Area 8, R12-R14).
 *
 * - `recordingFetch( realFetch, { dir, name } )` wraps a fetch implementation, scrubs each
 *   request/response pair and writes `<dir>/<name>.json` when `save()` is called.
 * - `replayFetch( { dir, name } )` serves the recorded responses in order and throws
 *   `ReplayMismatchError` (with a diff) when the outgoing request drifts from the recording.
 *
 * Scrubbing is mandatory: anything that looks like a credential makes the recorder throw
 * instead of writing the file (see `assertFixtureSafe`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REQUEST_HEADER_ALLOWLIST = [ 'content-type', 'anthropic-version', 'openai-beta' ] as const;
export const RESPONSE_HEADER_ALLOWLIST = [ 'content-type' ] as const;

/** Query parameters whose values are replaced before anything is stored. */
export const REDACTED_QUERY_KEYS = [ 'key', 'api_key', 'apikey', 'access_token' ] as const;
export const REDACTED = 'REDACTED';

/** Body keys that carry per-call identifiers; ignored when comparing requests. */
export const VOLATILE_KEYS = [ 'request_id', 'requestId' ] as const;

export const SECRET_PATTERNS: ReadonlyArray<{ name: string, pattern: RegExp }> =
    [
        { name : 'Anthropic key', pattern : /\bsk-ant-[A-Za-z0-9_-]{6,}/ },
        { name : 'sk- key',       pattern : /\bsk-[A-Za-z0-9_-]{6,}/ },
        { name : 'Google key',    pattern : /\bAIza[0-9A-Za-z_-]{10,}/ },
        { name : 'Groq key',      pattern : /\bgsk_[A-Za-z0-9]{6,}/ },
        { name : 'Bearer token',  pattern : /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/i },
        { name : 'key= query',    pattern : /[?&](?:key|api_key|apikey|access_token)=(?!REDACTED(?:&|$|"))[^&"\s]+/i }
    ];

export class ReplayMismatchError extends Error
{
    public readonly diff : string[];

    constructor( message: string, diff: string[] )
    {
        super( `${ message }\n${ diff.map( ( line ) => `  ${ line }` ).join( '\n' ) }` );
        this.name = 'ReplayMismatchError';
        this.diff = diff;
    }
}

export class UnsafeFixtureError extends Error
{
    constructor( message: string )
    {
        super( message );
        this.name = 'UnsafeFixtureError';
    }
}

export interface RecordedRequest
{
    method  : string
    url     : string
    headers : Record<string, string>
    body?   : unknown
}

export interface RecordedResponse
{
    status  : number
    headers : Record<string, string>
    /** Parsed JSON, or text for non-JSON bodies. Absent for streamed responses. */
    body?   : unknown
    /** Streamed responses (SSE/NDJSON) as the text chunks received, in order. */
    chunks? : string[]
}

export interface RecordedInteraction
{
    request  : RecordedRequest
    response : RecordedResponse
}

export interface RecordedFixture
{
    /** `recorded` = captured from a live provider; `synthetic` = hand-authored from the provider's documented wire format. */
    source       : 'recorded' | 'synthetic'
    provider     : string
    model        : string
    recordedAt   : string
    note?        : string
    interactions : RecordedInteraction[]
}

type FetchLike = ( input: string | URL | Request, init?: RequestInit ) => Promise<Response>;

export interface RecordingOptions
{
    dir       : string
    name      : string
    provider  : string
    model     : string
    source?   : RecordedFixture['source']
    note?     : string
    now?      : () => Date
}

function fixturePath( dir: string, name: string ): string
{
    return path.join( dir, `${ name }.json` );
}

export function redactUrl( rawUrl: string ): string
{
    const url = new URL( rawUrl );

    for( const key of [ ...url.searchParams.keys() ] )
    {
        if( ( REDACTED_QUERY_KEYS as readonly string[] ).includes( key.toLowerCase() ) )
        {
            url.searchParams.set( key, REDACTED );
        }
    }

    return url.toString();
}

function allowlistHeaders( headers: Headers, allow: readonly string[] ): Record<string, string>
{
    const out: Record<string, string> = {};

    for( const name of allow )
    {
        const value = headers.get( name );

        if( value !== null )
        {
            out[name] = value;
        }
    }

    return out;
}

function parseBody( text: string ): unknown
{
    if( text === '' )
    {
        return undefined;
    }

    try
    {
        return JSON.parse( text );
    }
    catch
    {
        return text;
    }
}

/**
 * Throws when a fixture could leak a credential: a header outside the allowlist,
 * a secret-looking value anywhere in the serialized data, or an un-redacted `key=` URL query.
 */
export function assertFixtureSafe( fixture: RecordedFixture ): void
{
    fixture.interactions.forEach( ( interaction, index ) =>
    {
        for( const header of Object.keys( interaction.request.headers ) )
        {
            if( !( REQUEST_HEADER_ALLOWLIST as readonly string[] ).includes( header.toLowerCase() ) )
            {
                throw new UnsafeFixtureError( `interaction ${ index }: request header "${ header }" is not in the allowlist` );
            }
        }

        for( const header of Object.keys( interaction.response.headers ) )
        {
            if( !( RESPONSE_HEADER_ALLOWLIST as readonly string[] ).includes( header.toLowerCase() ) )
            {
                throw new UnsafeFixtureError( `interaction ${ index }: response header "${ header }" is not in the allowlist` );
            }
        }
    } );

    const serialized = JSON.stringify( fixture );

    for( const { name, pattern } of SECRET_PATTERNS )
    {
        const match = pattern.exec( serialized );

        if( match )
        {
            throw new UnsafeFixtureError( `fixture contains a value matching ${ name } (${ match[0].slice( 0, 6 ) }…); refusing to write it` );
        }
    }
}

/** Scan serialized fixture text for secrets (used by the repo-wide scan test). */
export function findSecrets( text: string ): string[]
{
    return SECRET_PATTERNS.filter( ( { pattern } ) => pattern.test( text ) ).map( ( { name } ) => name );
}

export interface Recorder
{
    fetch : FetchLike
    /** Validates and writes the fixture; returns the file path. Throws `UnsafeFixtureError` before touching disk. */
    save() : string
    readonly interactions : RecordedInteraction[]
}

export function recordingFetch( realFetch: FetchLike, options: RecordingOptions ): Recorder
{
    const interactions: RecordedInteraction[] = [];

    const recorded: FetchLike = async ( input, init ) =>
    {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const requestHeaders = new Headers( init?.headers );
        const bodyText = typeof init?.body === 'string' ? init.body : undefined;

        const response = await realFetch( input, init );
        const clone = response.clone();
        const contentType = clone.headers.get( 'content-type' ) ?? '';
        const streamed = /event-stream|ndjson|x-ndjson/i.test( contentType );

        const recordedResponse: RecordedResponse =
            {
                status  : clone.status,
                headers : allowlistHeaders( clone.headers, RESPONSE_HEADER_ALLOWLIST )
            };

        if( streamed && clone.body )
        {
            const chunks: string[] = [];
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();

            for( ;; )
            {
                const { done, value } = await reader.read();

                if( done )
                {
                    break;
                }

                chunks.push( decoder.decode( value, { stream : true } ) );
            }

            recordedResponse.chunks = chunks;
        }
        else
        {
            recordedResponse.body = parseBody( await clone.text() );
        }

        interactions.push(
            {
                request :
            {
                method  : ( init?.method ?? 'GET' ).toUpperCase(),
                url     : redactUrl( url ),
                headers : allowlistHeaders( requestHeaders, REQUEST_HEADER_ALLOWLIST ),
                body    : bodyText === undefined ? undefined : parseBody( bodyText )
            },
                response : recordedResponse
            } );

        return response;
    };

    return {
        fetch : recorded,
        interactions,
        save()
        {
            const fixture: RecordedFixture =
                {
                    source     : options.source ?? 'recorded',
                    provider   : options.provider,
                    model      : options.model,
                    recordedAt : ( options.now?.() ?? new Date() ).toISOString(),
                    ...( options.note ? { note : options.note } : {} ),
                    interactions
                };

            assertFixtureSafe( fixture );

            const file = fixturePath( options.dir, options.name );
            mkdirSync( path.dirname( file ), { recursive : true } );
            writeFileSync( file, `${ JSON.stringify( fixture, null, 4 ) }\n` );

            return file;
        }
    };
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

function canonicalize( value: unknown, ignore: ReadonlySet<string> ): unknown
{
    if( Array.isArray( value ) )
    {
        return value.map( ( item ) => canonicalize( item, ignore ) );
    }

    if( value && typeof value === 'object' )
    {
        const out: Record<string, unknown> = {};

        for( const key of Object.keys( value ).sort() )
        {
            if( !ignore.has( key ) )
            {
                out[key] = canonicalize( ( value as Record<string, unknown> )[key], ignore );
            }
        }

        return out;
    }

    return value;
}

/** Path-addressed differences between two canonical JSON values. */
export function diffJson( expected: unknown, actual: unknown, at = 'body' ): string[]
{
    if( JSON.stringify( expected ) === JSON.stringify( actual ) )
    {
        return [];
    }

    const isObject = ( v: unknown ): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray( v );

    if( isObject( expected ) && isObject( actual ) )
    {
        const lines: string[] = [];

        for( const key of new Set( [ ...Object.keys( expected ), ...Object.keys( actual ) ] ) )
        {
            if( !( key in actual ) )
            {
                lines.push( `- ${ at }.${ key }: recorded ${ JSON.stringify( expected[key] ) }, missing from request` );
            }
            else if( !( key in expected ) )
            {
                lines.push( `+ ${ at }.${ key }: request sent ${ JSON.stringify( actual[key] ) }, not in recording` );
            }
            else
            {
                lines.push( ...diffJson( expected[key], actual[key], `${ at }.${ key }` ) );
            }
        }

        return lines;
    }

    if( Array.isArray( expected ) && Array.isArray( actual ) && expected.length === actual.length )
    {
        return expected.flatMap( ( item, i ) => diffJson( item, actual[i], `${ at }[${ i }]` ) );
    }

    return [ `~ ${ at }: recorded ${ JSON.stringify( expected ) }, request sent ${ JSON.stringify( actual ) }` ];
}

function comparableUrl( rawUrl: string ): { path: string, query: Record<string, string> }
{
    const url = new URL( rawUrl );
    const query: Record<string, string> = {};

    for( const [ key, value ] of [ ...url.searchParams.entries() ].sort( ( a, b ) => a[0].localeCompare( b[0] ) ) )
    {
        if( !( REDACTED_QUERY_KEYS as readonly string[] ).includes( key.toLowerCase() ) )
        {
            query[key] = value;
        }
    }

    return { path : url.pathname, query };
}

export interface ReplayOptions
{
    dir          : string
    name         : string
    /** Extra body keys to ignore when comparing requests (at any depth). */
    ignoreKeys?  : string[]
}

export interface Replayer
{
    fetch : FetchLike
    readonly fixture : RecordedFixture
    /** Interactions served so far. */
    readonly served : number
    /** Throws when recorded interactions were never requested (stale fixture). */
    assertAllUsed() : void
}

export function loadFixture( dir: string, name: string ): RecordedFixture
{
    return JSON.parse( readFileSync( fixturePath( dir, name ), 'utf8' ) ) as RecordedFixture;
}

export function replayFetch( options: ReplayOptions ): Replayer
{
    const fixture = loadFixture( options.dir, options.name );
    const ignore = new Set<string>( [ ...VOLATILE_KEYS, ...( options.ignoreKeys ?? [] ) ] );
    let cursor = 0;

    const replay: FetchLike = async ( input, init ) =>
    {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = ( init?.method ?? 'GET' ).toUpperCase();
        const expected = fixture.interactions[cursor];

        if( !expected )
        {
            throw new ReplayMismatchError( `${ options.name }: unexpected extra request #${ cursor + 1 } (${ method } ${ new URL( url ).pathname })`, [ `+ request not in recording (${ fixture.interactions.length } recorded)` ] );
        }

        const diff: string[] = [];

        if( expected.request.method !== method )
        {
            diff.push( `~ method: recorded ${ expected.request.method }, request sent ${ method }` );
        }

        const want = comparableUrl( expected.request.url );
        const got = comparableUrl( url );

        if( want.path !== got.path )
        {
            diff.push( `~ path: recorded ${ want.path }, request sent ${ got.path }` );
        }

        diff.push( ...diffJson( want.query, got.query, 'query' ) );

        const sentBody = typeof init?.body === 'string' ? parseBody( init.body ) : undefined;
        diff.push( ...diffJson( canonicalize( expected.request.body, ignore ), canonicalize( sentBody, ignore ), 'body' ) );

        if( diff.length )
        {
            throw new ReplayMismatchError( `${ options.name }: request #${ cursor + 1 } drifted from the recording`, diff );
        }

        cursor++;

        const headers = new Headers( expected.response.headers );

        if( expected.response.chunks )
        {
            const encoder = new TextEncoder();
            const chunks = expected.response.chunks;
            const stream = new ReadableStream<Uint8Array>(
                {
                    start( controller )
                    {
                        for( const chunk of chunks )
                        {
                            controller.enqueue( encoder.encode( chunk ) );
                        }

                        controller.close();
                    }
                } );

            return new Response( stream, { status : expected.response.status, headers } );
        }

        const body = expected.response.body;
        const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify( body );

        return new Response( text, { status : expected.response.status, headers } );
    };

    return {
        fetch : replay,
        fixture,
        get served() {return cursor;},
        assertAllUsed()
        {
            if( cursor !== fixture.interactions.length )
            {
                throw new ReplayMismatchError( `${ options.name }: ${ fixture.interactions.length - cursor } recorded interaction(s) were never requested`, [ `- served ${ cursor } of ${ fixture.interactions.length }` ] );
            }
        }
    };
}

/** Fixtures of source `recorded` older than `maxAgeDays` (default 180), for a CI warning (R16). */
export function staleFixtures( fixtures: Array<{ name: string, fixture: RecordedFixture }>, now: Date, maxAgeDays = 180 ): string[]
{
    const limit = maxAgeDays * 24 * 60 * 60 * 1_000;

    return fixtures
        .filter( ( { fixture } ) => fixture.source === 'recorded' && now.getTime() - new Date( fixture.recordedAt ).getTime() > limit )
        .map( ( { name, fixture } ) => `${ name } (${ fixture.model }) recorded ${ fixture.recordedAt }` );
}
