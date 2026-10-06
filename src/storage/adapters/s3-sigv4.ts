import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials
{
    accessKeyId     : string
    secretAccessKey : string
    sessionToken?   : string
}

export interface SignRequestInput
{
    method         : string
    /** Absolute URL exactly as it will be requested. Its path must already be percent-encoded per SigV4 rules. */
    url            : string | URL
    /** Extra headers to sign (names are case-insensitive). `host` and `x-amz-date` are added automatically. */
    headers?       : Record<string, string>
    /** Lower-case hex SHA-256 of the body (or `UNSIGNED-PAYLOAD`). Callers that need `x-amz-content-sha256` add it to `headers`. */
    payloadHash    : string
    region         : string
    service        : string
    credentials    : AwsCredentials
    now?           : Date
    /** Encode the already-encoded path a second time. S3 signs the path once (default `false`); every other service doubles. */
    doubleEncodePath? : boolean
}

export interface SignedRequest
{
    /** All headers that were signed plus `authorization`, lower-cased. `host` is included for completeness. */
    headers          : Record<string, string>
    amzDate          : string
    canonicalRequest : string
    stringToSign     : string
    signature        : string
    authorization    : string
}

export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex( data: string | Uint8Array ): string
{
    return createHash( 'sha256' ).update( data ).digest( 'hex' );
}

function hmac( key: string | Uint8Array, data: string ): Buffer
{
    return createHmac( 'sha256', key ).update( data ).digest();
}

/** RFC 3986 percent-encoding as SigV4 requires: only `A-Z a-z 0-9 - _ . ~` stay literal (and `/` when `keepSlash`). */
export function awsUriEncode( value: string, keepSlash: boolean = false ): string
{
    let out = '';

    for( const byte of Buffer.from( value, 'utf8' ) )
    {
        const ch = String.fromCharCode( byte );

        if( /[A-Za-z0-9\-_.~]/.test( ch ) || ( keepSlash && ch === '/' ) )
        {
            out += ch;
        }
        else
        {
            out += `%${byte.toString( 16 ).toUpperCase().padStart( 2, '0' )}`;
        }
    }

    return out;
}

/** Sorted, re-encoded query string. Parses the raw query so `+` stays a literal plus. */
export function canonicalQueryString( search: string ): string
{
    const raw = search.startsWith( '?' ) ? search.slice( 1 ) : search;

    if( raw === '' ){return '';}

    const pairs = raw.split( '&' ).filter( ( p ) => {return p !== '';} ).map( ( pair ) =>
    {
        const eq = pair.indexOf( '=' );
        const name = eq === -1 ? pair : pair.slice( 0, eq );
        const value = eq === -1 ? '' : pair.slice( eq + 1 );

        return [ awsUriEncode( decodeURIComponent( name ) ), awsUriEncode( decodeURIComponent( value ) ) ] as const;
    } );

    pairs.sort( ( a, b ) => {return a[0] === b[0] ? ( a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0 ) : ( a[0] < b[0] ? -1 : 1 );} );

    return pairs.map( ( [ k, v ] ) => {return `${k}=${v}`;} ).join( '&' );
}

function amzDateOf( now: Date ): string
{
    return now.toISOString().replace( /[:-]|\.\d{3}/g, '' );
}

export function deriveSigningKey( secretAccessKey: string, dateStamp: string, region: string, service: string ): Buffer
{
    return hmac( hmac( hmac( hmac( `AWS4${secretAccessKey}`, dateStamp ), region ), service ), 'aws4_request' );
}

/** Computes an AWS Signature Version 4 `Authorization` header (header based signing, not presigned URLs). */
export function signRequest( input: SignRequestInput ): SignedRequest
{
    const url = typeof input.url === 'string' ? new URL( input.url ) : input.url;
    const amzDate = amzDateOf( input.now ?? new Date() );
    const dateStamp = amzDate.slice( 0, 8 );
    const headers: Record<string, string> = {};

    for( const [ name, value ] of Object.entries( input.headers ?? {} ) )
    {
        headers[name.toLowerCase()] = value.trim().replace( /\s+/g, ' ' );
    }

    headers.host = url.host;
    headers['x-amz-date'] = amzDate;

    if( input.credentials.sessionToken )
    {
        headers['x-amz-security-token'] = input.credentials.sessionToken;
    }

    const names = Object.keys( headers ).sort();
    const canonicalHeaders = names.map( ( n ) => {return `${n}:${headers[n]}\n`;} ).join( '' );
    const signedHeaders = names.join( ';' );
    const canonicalUri = input.doubleEncodePath ? awsUriEncode( url.pathname, true ) : url.pathname;
    const canonicalRequest = [
        input.method.toUpperCase(),
        canonicalUri,
        canonicalQueryString( url.search ),
        canonicalHeaders,
        signedHeaders,
        input.payloadHash
    ].join( '\n' );
    const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex( canonicalRequest )}`;
    const key = deriveSigningKey( input.credentials.secretAccessKey, dateStamp, input.region, input.service );
    const signature = hmac( key, stringToSign ).toString( 'hex' );
    const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        headers : { ...headers, authorization },
        amzDate,
        canonicalRequest,
        stringToSign,
        signature,
        authorization
    };
}
