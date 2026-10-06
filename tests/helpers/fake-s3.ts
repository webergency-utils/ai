import { createHash } from 'node:crypto';
import { sha256Hex, signRequest } from '../../src/storage/adapters/s3-sigv4.js';

export interface FakeS3Request
{
    method : string
    url    : URL
    key    : string
    query  : Record<string, string>
    body   : Uint8Array
}

export interface FakeS3Failure
{
    match    : ( req: FakeS3Request ) => boolean
    status   : number
    code?    : string
    message? : string
    /** How many matching requests fail; default: all. */
    times?   : number
}

export interface FakeS3Options
{
    bucket?          : string
    accessKeyId?     : string
    secretAccessKey? : string
    region?          : string
    pathStyle?       : boolean
}

interface StoredObject
{
    data         : Uint8Array
    contentType? : string
    lastModified : Date
}

function xmlError( status: number, code: string, message: string ): Response
{
    return new Response( `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status, headers : { 'content-type' : 'application/xml' } } );
}

function etagOf( data: Uint8Array ): string
{
    return `"${createHash( 'md5' ).update( data ).digest( 'hex' )}"`;
}

/**
 * Minimal in-memory S3 behind a `fetch` function: PutObject, GetObject, HeadObject, DeleteObject and the multipart
 * calls. Every request's SigV4 signature is recomputed and verified, so a mismatch between the signed and the sent
 * request (wrong path encoding, host, headers) fails like it would against real S3.
 */
export class FakeS3
{
    public readonly objects  = new Map<string, StoredObject>();
    public readonly uploads  = new Map<string, { key: string, parts: Map<number, Uint8Array>, contentType?: string }>();
    public readonly requests : FakeS3Request[] = [];
    public readonly failures : FakeS3Failure[] = [];
    readonly #opts           : Required<FakeS3Options>;
    #uploadCounter           = 0;

    constructor( options: FakeS3Options = {} )
    {
        this.#opts = {
            bucket          : options.bucket ?? 'test-bucket',
            accessKeyId     : options.accessKeyId ?? 'AKIDEXAMPLE',
            secretAccessKey : options.secretAccessKey ?? 'secret/KEY+example',
            region          : options.region ?? 'us-east-1',
            pathStyle       : options.pathStyle ?? true
        };
    }

    public get credentials(): { accessKeyId: string, secretAccessKey: string }
    {
        return { accessKeyId : this.#opts.accessKeyId, secretAccessKey : this.#opts.secretAccessKey };
    }

    public readonly fetch = async ( input: string | URL | Request, init: RequestInit = {} ): Promise<Response> =>
    {
        const url = new URL( input instanceof Request ? input.url : input );
        const method = ( init.method ?? 'GET' ).toUpperCase();
        const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
        const headers = new Headers( init.headers );
        const query = Object.fromEntries( [ ...url.searchParams.entries() ] );
        const key = this.#keyOf( url );

        if( key === null ){return xmlError( 404, 'NoSuchBucket', 'The specified bucket does not exist' );}

        const req: FakeS3Request = { method, url, key, query, body };

        this.requests.push( req );

        const denied = this.#verify( method, url, headers, body );

        if( denied ){return denied;}

        for( const failure of this.failures )
        {
            if( failure.match( req ) && ( failure.times === undefined || failure.times > 0 ) )
            {
                if( failure.times !== undefined ){failure.times--;}

                return xmlError( failure.status, failure.code ?? 'InternalError', failure.message ?? 'injected failure' );
            }
        }

        return this.#dispatch( req, headers );
    };

    /** Requests that hit `key` (decoded, bucket excluded). */
    public requestsFor( key: string ): FakeS3Request[]
    {
        return this.requests.filter( ( r ) => {return r.key === key;} );
    }

    #keyOf( url: URL ): string | null
    {
        const path = decodeURIComponent( url.pathname );

        if( this.#opts.pathStyle )
        {
            const prefix = `/${this.#opts.bucket}`;

            if( path !== prefix && !path.startsWith( `${prefix}/` ) ){return null;}

            return path.slice( prefix.length + 1 );
        }

        if( url.hostname.split( '.' )[0] !== this.#opts.bucket ){return null;}

        return path.slice( 1 );
    }

    #verify( method: string, url: URL, headers: Headers, body: Uint8Array ): Response | null
    {
        const authorization = headers.get( 'authorization' );
        const amzDate = headers.get( 'x-amz-date' );
        const payloadHash = headers.get( 'x-amz-content-sha256' );

        if( !authorization || !amzDate || !payloadHash ){return xmlError( 403, 'AccessDenied', 'Missing authentication headers' );}

        if( payloadHash !== sha256Hex( body ) ){return xmlError( 400, 'XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.' );}

        const signedNames = /SignedHeaders=([^,]+)/.exec( authorization )?.[1]?.split( ';' ) ?? [];
        const signedHeaders: Record<string, string> = {};

        for( const name of signedNames )
        {
            if( name === 'host' || name === 'x-amz-date' ){continue;}

            const value = headers.get( name );

            if( value === null ){return xmlError( 403, 'AccessDenied', `Signed header '${name}' was not sent` );}

            signedHeaders[name] = value;
        }

        const now = new Date( amzDate.replace( /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z' ) );
        const expected = signRequest( {
            method,
            url,
            headers     : signedHeaders,
            payloadHash,
            region      : this.#opts.region,
            service     : 's3',
            credentials : this.credentials,
            now
        } );

        if( expected.authorization !== authorization )
        {
            return xmlError( 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.' );
        }

        return null;
    }

    #dispatch( req: FakeS3Request, headers: Headers ): Response
    {
        const { method, key, query, body } = req;

        if( method === 'POST' && 'uploads' in query )
        {
            const id = `upload-${++this.#uploadCounter}`;

            this.uploads.set( id, { key, parts : new Map(), contentType : headers.get( 'content-type' ) ?? undefined } );

            return new Response( `<InitiateMultipartUploadResult><Bucket>${this.#opts.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>` );
        }

        if( method === 'PUT' && query.uploadId )
        {
            const upload = this.uploads.get( query.uploadId );

            if( !upload ){return xmlError( 404, 'NoSuchUpload', 'The specified upload does not exist.' );}

            upload.parts.set( Number( query.partNumber ), body );

            return new Response( null, { headers : { etag : etagOf( body ) } } );
        }

        if( method === 'POST' && query.uploadId )
        {
            const upload = this.uploads.get( query.uploadId );

            if( !upload ){return xmlError( 404, 'NoSuchUpload', 'The specified upload does not exist.' );}

            const listed = [ ...new TextDecoder().decode( body ).matchAll( /<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g ) ];
            const chunks: Uint8Array[] = [];

            for( const [ , number, etag ] of listed )
            {
                const part = upload.parts.get( Number( number ) );

                if( !part || etagOf( part ) !== etag ){return xmlError( 400, 'InvalidPart', `Part ${number} not found or ETag mismatch` );}

                chunks.push( part );
            }

            const data = new Uint8Array( chunks.reduce( ( n, c ) => {return n + c.byteLength;}, 0 ) );
            let offset = 0;

            for( const c of chunks ){data.set( c, offset ); offset += c.byteLength;}

            this.objects.set( key, { data, contentType : upload.contentType, lastModified : new Date() } );
            this.uploads.delete( query.uploadId );

            return new Response( `<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>` );
        }

        if( method === 'DELETE' && query.uploadId )
        {
            this.uploads.delete( query.uploadId );

            return new Response( null, { status : 204 } );
        }

        if( method === 'PUT' )
        {
            this.objects.set( key, { data : body, contentType : headers.get( 'content-type' ) ?? undefined, lastModified : new Date() } );

            return new Response( null, { headers : { etag : etagOf( body ) } } );
        }

        if( method === 'DELETE' )
        {
            this.objects.delete( key );

            return new Response( null, { status : 204 } );
        }

        const object = this.objects.get( key );

        if( method === 'HEAD' )
        {
            if( !object ){return new Response( null, { status : 404 } );}

            return new Response( null, { headers : this.#objectHeaders( object ) } );
        }

        if( method === 'GET' )
        {
            if( !object ){return xmlError( 404, 'NoSuchKey', 'The specified key does not exist.' );}

            return new Response( object.data as BodyInit, { headers : this.#objectHeaders( object ) } );
        }

        return xmlError( 405, 'MethodNotAllowed', `${method} not supported` );
    }

    #objectHeaders( object: StoredObject ): Record<string, string>
    {
        return {
            'content-length' : String( object.data.byteLength ),
            'content-type'   : object.contentType ?? 'application/octet-stream',
            'last-modified'  : object.lastModified.toUTCString(),
            etag             : etagOf( object.data )
        };
    }
}
