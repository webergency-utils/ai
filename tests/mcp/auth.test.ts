import { describe, it, expect, vi } from 'vitest';
import 
{
    MCPAuthError,
    MCPClient,
    StreamableHTTPTransport,
    applyAuth,
    authorizedFetch,
    formatBearerChallenge,
    parseWWWAuthenticate,
    selectChallenge,
    type MCPAuthOptions
} from '../../src/mcp/index.js';
import { jsonResponse } from '../helpers/http.js';

describe( 'parseWWWAuthenticate (R16)', () => 
{
    it( 'parses Bearer params with quoted values, including resource_metadata and scope', () => 
    {
        const [ challenge ] = parseWWWAuthenticate( 
            'Bearer realm="mcp", error="invalid_token", scope="read write", resource_metadata="https://x.example/.well-known/oauth-protected-resource"' 
        );

        expect( challenge.scheme ).toBe( 'Bearer' );
        expect( challenge.params ).toEqual( {
            realm             : 'mcp',
            error             : 'invalid_token',
            scope             : 'read write',
            resource_metadata : 'https://x.example/.well-known/oauth-protected-resource'
        } );
    } );

    it( 'handles commas and escaped quotes inside quoted strings, and unquoted tokens', () => 
    {
        const [ challenge ] = parseWWWAuthenticate( 'Bearer error_description="bad, \\"token\\"", error=invalid_token' );

        expect( challenge.params.error_description ).toBe( 'bad, "token"' );
        expect( challenge.params.error ).toBe( 'invalid_token' );
    } );

    it( 'lower-cases parameter names and tolerates spaces around =', () => 
    {
        const [ challenge ] = parseWWWAuthenticate( 'Bearer Realm = "r"' );

        expect( challenge.params ).toEqual( { realm : 'r' } );
    } );

    it( 'parses several challenges and selects Bearer', () => 
    {
        const challenges = parseWWWAuthenticate( 'Basic realm="b", Bearer error="invalid_token", Digest nonce="n"' );

        expect( challenges.map( ( c ) => {return c.scheme;} ) ).toEqual( [ 'Basic', 'Bearer', 'Digest' ] );
        expect( challenges[0].params ).toEqual( { realm : 'b' } );
        expect( challenges[2].params ).toEqual( { nonce : 'n' } );
        expect( selectChallenge( challenges )?.scheme ).toBe( 'Bearer' );
    } );

    it( 'handles a bare scheme and selects the first challenge when there is no Bearer', () => 
    {
        const challenges = parseWWWAuthenticate( 'Negotiate' );

        expect( challenges ).toEqual( [ { scheme : 'Negotiate', params : {} } ] );
        expect( selectChallenge( challenges )?.scheme ).toBe( 'Negotiate' );
    } );

    it( 'returns nothing for empty / missing headers and never loops on garbage', () => 
    {
        expect( parseWWWAuthenticate( null ) ).toEqual( [] );
        expect( parseWWWAuthenticate( '' ) ).toEqual( [] );
        expect( selectChallenge( [] ) ).toBeUndefined();
        expect( () => {return parseWWWAuthenticate( '=== """ ,,, \\ Bearer a="unterminated' );} ).not.toThrow();
    } );
} );

describe( 'formatBearerChallenge', () => 
{
    it( 'formats and round-trips through the parser, escaping quotes', () => 
    {
        const header = formatBearerChallenge( { 
            error            : 'invalid_token', 
            errorDescription : 'say "hi"', 
            scope            : 'a b', 
            resourceMetadata : 'https://x.example/meta' 
        } );
        const [ challenge ] = parseWWWAuthenticate( header );

        expect( challenge.params ).toEqual( {
            error             : 'invalid_token',
            error_description : 'say "hi"',
            scope             : 'a b',
            resource_metadata : 'https://x.example/meta'
        } );
    } );

    it( 'is a bare Bearer without parameters', () => 
    {
        expect( formatBearerChallenge() ).toBe( 'Bearer' );
    } );
} );

describe( 'applyAuth (R15)', () => 
{
    it( 'merges static headers with provider headers, provider wins', async () => 
    {
        const headers = await applyAuth( { 
            headers      : { 'x-a' : '1', authorization : 'static' }, 
            authProvider : { getHeaders : async () => {return { authorization : 'Bearer provided' };} } 
        } );

        expect( headers ).toEqual( { 'x-a' : '1', authorization : 'Bearer provided' } );
    } );

    it( 'works with nothing configured', async () => 
    {
        expect( await applyAuth( {} ) ).toEqual( {} );
    } );
} );

describe( 'authorizedFetch 401/403 rule (R16, R17)', () => 
{
    const unauthorized = ( header = 'Bearer error="invalid_token", resource_metadata="https://x.example/meta"' ): Response => 
    {
        return new Response( 'nope', { status : 401, headers : { 'www-authenticate' : header } } );
    };

    function run( fetchImpl: typeof fetch, auth: MCPAuthOptions, url = 'https://mcp.example/rpc?key=secretquery' ): Promise<Response>
    {
        return authorizedFetch( { fetch : fetchImpl, url, init : { method : 'POST', body : '{}' }, headers : () => {return { 'content-type' : 'application/json' };}, auth } );
    }

    it( 'sends protocol headers plus auth headers (auth wins collisions)', async () => 
    {
        const seen: Headers[] = [];
        const fetchImpl = vi.fn( async ( _url: unknown, init?: RequestInit ) => 
        {
            seen.push( new Headers( init?.headers ) );

            return jsonResponse( {} );
        } ) as unknown as typeof fetch;

        await run( fetchImpl, { headers : { 'X-Static' : 's', 'Content-Type' : 'text/plain' }, authProvider : { getHeaders : async () => {return { Authorization : 'Bearer t1' };} } } );

        expect( seen[0].get( 'authorization' ) ).toBe( 'Bearer t1' );
        expect( seen[0].get( 'x-static' ) ).toBe( 's' );
        expect( seen[0].get( 'content-type' ) ).toBe( 'text/plain' );
    } );

    it( 'AE8: retries exactly once when onUnauthorized returns true, with the refreshed token', async () => 
    {
        let token = 'old';
        const used: Array<string | null> = [];
        const fetchImpl = vi.fn( async ( _url: unknown, init?: RequestInit ) => 
        {
            used.push( new Headers( init?.headers ).get( 'authorization' ) );

            return used.length === 1 ? unauthorized() : jsonResponse( { ok : true } );
        } ) as unknown as typeof fetch;

        const onUnauthorized = vi.fn( async () => 
        {
            token = 'new';

            return true;
        } );

        const response = await run( fetchImpl, { authProvider : { getHeaders : async () => {return { authorization : `Bearer ${token}` };}, onUnauthorized } } );

        expect( response.status ).toBe( 200 );
        expect( used ).toEqual( [ 'Bearer old', 'Bearer new' ] );
        expect( onUnauthorized ).toHaveBeenCalledTimes( 1 );
        expect( onUnauthorized.mock.calls[0] as unknown[] ).toEqual( [ expect.objectContaining( { 
            status           : 401, 
            url              : 'https://mcp.example/rpc', 
            resourceMetadata : 'https://x.example/meta' 
        } ) ] );
    } );

    it( 'AE8: a second 401 throws MCPAuthError without a third attempt', async () => 
    {
        const fetchImpl = vi.fn( async () => {return unauthorized();} ) as unknown as typeof fetch;
        const onUnauthorized = vi.fn( async () => {return true;} );

        const failure = await run( fetchImpl, { authProvider : { getHeaders : async () => {return { authorization : 'Bearer SECRET-TOKEN' };}, onUnauthorized } } ).catch( ( e: unknown ) => {return e;} );

        expect( failure ).toBeInstanceOf( MCPAuthError );
        expect( failure ).toMatchObject( { 
            code             : 'MCP_UNAUTHORIZED', 
            status           : 401, 
            resourceMetadata : 'https://x.example/meta', 
            challenge        : { scheme : 'Bearer', params : { error : 'invalid_token' } } 
        } );
        expect( fetchImpl ).toHaveBeenCalledTimes( 2 );
        expect( onUnauthorized ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'throws MCP_UNAUTHORIZED immediately when onUnauthorized returns false or is absent', async () => 
    {
        const fetchImpl = vi.fn( async () => {return unauthorized();} ) as unknown as typeof fetch;

        await expect( run( fetchImpl, { authProvider : { getHeaders : async () => {return {};}, onUnauthorized : async () => {return false;} } } ) ).rejects.toMatchObject( { code : 'MCP_UNAUTHORIZED' } );
        await expect( run( fetchImpl, {} ) ).rejects.toMatchObject( { code : 'MCP_UNAUTHORIZED' } );
        expect( fetchImpl ).toHaveBeenCalledTimes( 2 );
    } );

    it( '403 throws MCP_FORBIDDEN without calling onUnauthorized or retrying', async () => 
    {
        const fetchImpl = vi.fn( async () => {return new Response( 'no', { status : 403 } );} ) as unknown as typeof fetch;
        const onUnauthorized = vi.fn( async () => {return true;} );

        const failure = await run( fetchImpl, { authProvider : { getHeaders : async () => {return {};}, onUnauthorized } } ).catch( ( e: unknown ) => {return e;} );

        expect( failure ).toBeInstanceOf( MCPAuthError );
        expect( failure ).toMatchObject( { code : 'MCP_FORBIDDEN', status : 403 } );
        expect( onUnauthorized ).not.toHaveBeenCalled();
        expect( fetchImpl ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'never puts tokens, header values or the query string into errors', async () => 
    {
        const fetchImpl = vi.fn( async () => {return unauthorized();} ) as unknown as typeof fetch;

        const failure = await run( 
            fetchImpl, 
            { headers : { 'x-api-key' : 'STATIC-SECRET' }, authProvider : { getHeaders : async () => {return { authorization : 'Bearer SECRET-TOKEN' };} } } 
        ).catch( ( e: unknown ) => {return e as MCPAuthError;} ) as MCPAuthError;

        const dump = `${failure.message}\n${JSON.stringify( failure.details )}\n${failure.stack ?? ''}`;

        expect( dump ).not.toContain( 'SECRET-TOKEN' );
        expect( dump ).not.toContain( 'STATIC-SECRET' );
        expect( dump ).not.toContain( 'secretquery' );
    } );

    it( 'propagates a failing getHeaders instead of sending an unauthenticated request', async () => 
    {
        const fetchImpl = vi.fn() as unknown as typeof fetch;

        await expect( run( fetchImpl, { authProvider : { getHeaders : async () => {throw new Error( 'token store down' );} } } ) ).rejects.toThrow( 'token store down' );
        expect( fetchImpl ).not.toHaveBeenCalled();
    } );

    it( 'reports an unparseable URL as <invalid url> in errors', async () => 
    {
        const fetchImpl = vi.fn( async () => {return new Response( null, { status : 403 } );} ) as unknown as typeof fetch;

        await expect( run( fetchImpl, {}, 'not a url' ) ).rejects.toMatchObject( { details : expect.objectContaining( { url : '<invalid url>' } ) } );
    } );
} );

describe( 'StreamableHTTPTransport auth integration (R15-R17)', () => 
{
    const init = { protocolVersion : '2025-06-18', capabilities : { tools : {} }, serverInfo : { name : 's', version : '1' } };

    function bearerServer( validToken: string ): { fetch: typeof fetch, seen: Array<string | null> }
    {
        const seen: Array<string | null> = [];
        const impl = async ( _url: unknown, init2?: RequestInit ): Promise<Response> => 
        {
            const headers = new Headers( init2?.headers );
            seen.push( headers.get( 'authorization' ) );

            if( headers.get( 'authorization' ) !== `Bearer ${validToken}` )
            {
                return new Response( 'denied', { status : 401, headers : { 'www-authenticate' : 'Bearer error="invalid_token", resource_metadata="https://mcp.example/meta"' } } );
            }

            const body = JSON.parse( init2?.body as string ) as { id?: number };

            return body.id === undefined
                ? new Response( null, { status : 202 } )
                : jsonResponse( { jsonrpc : '2.0', id : body.id, result : init } );
        };

        return { fetch : impl as unknown as typeof fetch, seen };
    }

    it( 'AE8: refreshes once on 401 through the transport and then connects', async () => 
    {
        const { fetch: fetchImpl, seen } = bearerServer( 'fresh' );
        let token = 'stale';
        const onUnauthorized = vi.fn( async () => 
        {
            token = 'fresh';

            return true;
        } );
        const client = new MCPClient( new StreamableHTTPTransport( 'https://mcp.example/rpc', { 
            fetch        : fetchImpl, 
            authProvider : { getHeaders : async () => {return { authorization : `Bearer ${token}` };}, onUnauthorized } 
        } ) );

        await client.connect();

        expect( seen.slice( 0, 2 ) ).toEqual( [ 'Bearer stale', 'Bearer fresh' ] );
        expect( seen.every( ( v, i ) => {return i === 0 || v === 'Bearer fresh';} ) ).toBe( true );
        expect( onUnauthorized ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'a persistent 401 rejects connect() with MCPAuthError carrying the challenge, and closes', async () => 
    {
        const { fetch: fetchImpl } = bearerServer( 'never' );
        const client = new MCPClient( new StreamableHTTPTransport( 'https://mcp.example/rpc', { 
            fetch        : fetchImpl, 
            authProvider : { getHeaders : async () => {return { authorization : 'Bearer wrong' };}, onUnauthorized : async () => {return true;} } 
        } ) );

        const failure = await client.connect().catch( ( e: unknown ) => {return e;} );

        expect( failure ).toBeInstanceOf( MCPAuthError );
        expect( failure ).toMatchObject( { code : 'MCP_UNAUTHORIZED', resourceMetadata : 'https://mcp.example/meta' } );
        expect( `${( failure as Error ).message}${JSON.stringify( ( failure as MCPAuthError ).details )}` ).not.toContain( 'wrong' );
    } );

    it( 'static headers are sent with every request', async () => 
    {
        const { fetch: fetchImpl, seen } = bearerServer( 'static' );
        const client = new MCPClient( new StreamableHTTPTransport( 'https://mcp.example/rpc', { fetch : fetchImpl, headers : { Authorization : 'Bearer static' } } ) );

        await client.connect();
        await client.close();

        expect( seen.length ).toBeGreaterThanOrEqual( 2 );
        expect( seen.every( ( v ) => {return v === 'Bearer static';} ) ).toBe( true );
    } );

    it( '403 rejects connect() with MCP_FORBIDDEN', async () => 
    {
        const client = new MCPClient( new StreamableHTTPTransport( 'https://mcp.example/rpc', { fetch : ( async () => {return new Response( null, { status : 403 } );} ) as unknown as typeof fetch } ) );

        await expect( client.connect() ).rejects.toMatchObject( { code : 'MCP_FORBIDDEN', status : 403 } );
    } );
} );
