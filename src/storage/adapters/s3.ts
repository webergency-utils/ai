import { InvalidInputError } from '../../core/error.js';
import { StorageError, wrapStorageError } from '../errors.js';
import type { FileMetadata, FileStoreOperationOptions, IFileStore } from '../file.js';
import { StorageInstrument } from '../instrument.js';
import type { StorageInstrumentOptions } from '../instrument.js';
import { normalizeStorePath } from '../path.js';
import { awsUriEncode, EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest } from './s3-sigv4.js';
import type { AwsCredentials } from './s3-sigv4.js';

export type S3Credentials = AwsCredentials;

const MIB = 1024 * 1024;
const MAX_PARTS = 10_000;
const ERROR_BODY_LIMIT = 64 * 1024;

const MIME_TYPES: Record<string, string> =
    {
        txt  : 'text/plain',
        md   : 'text/markdown',
        csv  : 'text/csv',
        html : 'text/html',
        css  : 'text/css',
        js   : 'text/javascript',
        json : 'application/json',
        xml  : 'application/xml',
        pdf  : 'application/pdf',
        zip  : 'application/zip',
        gz   : 'application/gzip',
        png  : 'image/png',
        jpg  : 'image/jpeg',
        jpeg : 'image/jpeg',
        gif  : 'image/gif',
        webp : 'image/webp',
        svg  : 'image/svg+xml',
        mp3  : 'audio/mpeg',
        wav  : 'audio/wav',
        mp4  : 'video/mp4',
        webm : 'video/webm'
    };

export interface S3FileStoreOptions extends StorageInstrumentOptions
{
    /** Service endpoint (`https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`, ...). Default: AWS S3 for `region`. */
    endpoint?                : string
    region                   : string
    bucket                   : string
    /** Static credentials or a provider called before every request (rotating STS credentials). */
    credentials              : S3Credentials | ( () => Promise<S3Credentials> )
    /** Key prefix applied to every path (`ai/files`). */
    prefix?                  : string
    /** `https://host/bucket/key` instead of `https://bucket.host/key`. Defaults to `true` when a custom `endpoint` is given. */
    forcePathStyle?          : boolean
    /** Streamed writes larger than this switch to multipart upload. Default 8 MiB. */
    multipartThresholdBytes? : number
    /** Size of each multipart part. Default: the multipart threshold. S3 requires at least 5 MiB except for the last part. */
    partSizeBytes?           : number
    /** `read()` refuses objects larger than this. Default 256 MiB. */
    maxReadBytes?            : number
    /** Injected `fetch` (tests, proxies, custom agents). Default `globalThis.fetch`. */
    fetch?                   : typeof fetch
    /** Clock used for signing. */
    now?                     : () => Date
}

interface SendOptions
{
    query?   : Array<[ string, string ]>
    body?    : Uint8Array
    headers? : Record<string, string>
}

/** Extracts the text of the first `<tag>` element; the few response shapes needed here never nest or repeat it. */
export function extractXmlTag( xml: string, tag: string ): string | undefined
{
    const m = new RegExp( `<${tag}>([\\s\\S]*?)</${tag}>` ).exec( xml );

    if( !m ){return undefined;}

    return m[1]
        .replace( /&lt;/g, '<' )
        .replace( /&gt;/g, '>' )
        .replace( /&quot;/g, '"' )
        .replace( /&apos;/g, '\'' )
        .replace( /&amp;/g, '&' );
}

function contentTypeFor( filePath: string ): string
{
    const ext = /\.([A-Za-z0-9]+)$/.exec( filePath )?.[1]?.toLowerCase();

    return ( ext && MIME_TYPES[ext] ) || 'application/octet-stream';
}

function concat( chunks: Uint8Array[], total: number ): Uint8Array
{
    const out = new Uint8Array( total );
    let offset = 0;

    for( const chunk of chunks )
    {
        out.set( chunk, offset );
        offset += chunk.byteLength;
    }

    return out;
}

/**
 * `IFileStore` on any S3-compatible object store (AWS S3, Cloudflare R2, MinIO) using native `fetch` and SigV4.
 *
 * - Strings and byte arrays are one `PutObject`. Streams are buffered up to `multipartThresholdBytes`; beyond that a
 *   multipart upload is started, parts are uploaded sequentially, and any failure issues `AbortMultipartUpload`.
 * - `readStream` returns the response body without buffering; `read` buffers with a `maxReadBytes` guard.
 * - `exists`/`getMetadata`/`read` treat HTTP 404 as "missing"; every other non-2xx (including 403) throws `StorageError`
 *   whose `details` carry `{ status, code }` parsed from the S3 error XML.
 * - `delete` issues a `HEAD` first because `DeleteObject` succeeds for missing keys; it is therefore not atomic.
 * - S3 has no creation time: `createdAt` and `updatedAt` are both `Last-Modified` (or the write time after `write`).
 * - No retries; wrap `fetch` if you need them.
 */
export class S3FileStore implements IFileStore
{
    readonly #endpoint          : URL;
    readonly #region            : string;
    readonly #bucket            : string;
    readonly #credentials       : S3Credentials | ( () => Promise<S3Credentials> );
    readonly #prefix            : string;
    readonly #pathStyle         : boolean;
    readonly #threshold         : number;
    readonly #partSize          : number;
    readonly #maxReadBytes      : number;
    readonly #fetch             : typeof fetch;
    readonly #now               : () => Date;
    readonly #instrument        : StorageInstrument;

    constructor( options: S3FileStoreOptions )
    {
        if( !options.region ){throw new InvalidInputError( 'S3FileStore requires a region' );}
        if( !options.bucket || /[/\s]/.test( options.bucket ) ){throw new InvalidInputError( `Invalid S3 bucket name ${JSON.stringify( options.bucket )}` );}
        if( !options.credentials ){throw new InvalidInputError( 'S3FileStore requires credentials' );}

        try
        {
            this.#endpoint = new URL( options.endpoint ?? `https://s3.${options.region}.amazonaws.com` );
        }
        catch( err )
        {
            throw new InvalidInputError( `Invalid S3 endpoint ${JSON.stringify( options.endpoint )}`, { cause : err } );
        }

        if( this.#endpoint.protocol !== 'https:' && this.#endpoint.protocol !== 'http:' )
        {
            throw new InvalidInputError( `S3 endpoint must be http(s), got ${this.#endpoint.protocol}` );
        }

        this.#threshold = options.multipartThresholdBytes ?? 8 * MIB;
        this.#partSize = options.partSizeBytes ?? this.#threshold;
        this.#maxReadBytes = options.maxReadBytes ?? 256 * MIB;

        for( const [ label, value ] of [ [ 'multipartThresholdBytes', this.#threshold ], [ 'partSizeBytes', this.#partSize ], [ 'maxReadBytes', this.#maxReadBytes ] ] as const )
        {
            if( !Number.isInteger( value ) || value < 1 )
            {
                throw new InvalidInputError( `S3FileStore option '${label}' must be a positive integer, got ${value}` );
            }
        }

        this.#region = options.region;
        this.#bucket = options.bucket;
        this.#credentials = options.credentials;
        this.#prefix = options.prefix ? normalizeStorePath( options.prefix ) : '';
        this.#pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
        this.#fetch = options.fetch ?? ( ( ...args ) => {return globalThis.fetch( ...args );} );
        this.#now = options.now ?? ( () => {return new Date();} );
        this.#instrument = new StorageInstrument( 'file', options );
    }

    public async write(
        filePath: string,
        content: Uint8Array | string | ReadableStream<Uint8Array>,
        options?: FileStoreOperationOptions
    ): Promise<FileMetadata>
    {
        const key = this.#key( filePath );
        const contentType = options?.contentType ?? contentTypeFor( filePath );

        return this.#instrument.run( 'write', options?.context, { path : filePath }, async ( ctx ) =>
        {
            let size: number;

            if( typeof content === 'string' || content instanceof Uint8Array )
            {
                const bytes = typeof content === 'string' ? new TextEncoder().encode( content ) : content;

                await this.#putObject( key, bytes, contentType );
                size = bytes.byteLength;
            }
            else
            {
                size = await this.#writeStream( key, content, contentType );
            }

            this.#instrument.spend( 'file_write', size, 'bytes', ctx );

            const now = this.#now();

            return { path : filePath, size, createdAt : now, updatedAt : now, contentType };
        } );
    }

    public async read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    {
        const key = this.#key( filePath );

        return this.#instrument.run( 'read', options?.context, { path : filePath }, async ( ctx ) =>
        {
            const res = await this.#send( 'read', 'GET', key );

            if( res.status === 404 )
            {
                await res.body?.cancel();

                return null;
            }

            if( !res.ok ){throw await this.#failure( 'read', res, key );}

            const declared = Number( res.headers.get( 'content-length' ) );

            if( Number.isFinite( declared ) && declared > this.#maxReadBytes )
            {
                await res.body?.cancel();

                throw this.#tooLarge( key, declared );
            }

            const chunks: Uint8Array[] = [];
            let total = 0;

            if( res.body )
            {
                const reader = res.body.getReader();

                try
                {
                    while( true )
                    {
                        const { done, value } = await reader.read();

                        if( done ){break;}

                        total += value.byteLength;

                        if( total > this.#maxReadBytes )
                        {
                            await reader.cancel();

                            throw this.#tooLarge( key, total );
                        }

                        chunks.push( value );
                    }
                }
                catch( err )
                {
                    throw wrapStorageError( 's3', 'file.read', err );
                }
                finally
                {
                    reader.releaseLock();
                }
            }

            this.#instrument.spend( 'file_read', total, 'bytes', ctx );

            return concat( chunks, total );
        } );
    }

    public async readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    {
        const key = this.#key( filePath );

        return this.#instrument.run( 'readStream', options?.context, { path : filePath }, async ( ctx ) =>
        {
            const res = await this.#send( 'readStream', 'GET', key );

            if( res.status === 404 )
            {
                await res.body?.cancel();

                return null;
            }

            if( !res.ok ){throw await this.#failure( 'readStream', res, key );}

            this.#instrument.spend( 'file_read', Number( res.headers.get( 'content-length' ) ) || 0, 'bytes', ctx );

            return res.body ?? new ReadableStream<Uint8Array>( { start( controller ){controller.close();} } );
        } );
    }

    public async delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    {
        const key = this.#key( filePath );

        return this.#instrument.run( 'delete', options?.context, { path : filePath }, async ( ctx ) =>
        {
            if( !( await this.#head( 'delete', key ) ) ){return false;}

            const res = await this.#send( 'delete', 'DELETE', key );

            if( !res.ok && res.status !== 404 ){throw await this.#failure( 'delete', res, key );}

            await res.body?.cancel();
            this.#instrument.spend( 'file_delete', 1, 'operations', ctx );

            return true;
        } );
    }

    public async exists( filePath: string ): Promise<boolean>
    {
        return ( await this.#head( 'exists', this.#key( filePath ) ) ) !== null;
    }

    public async getMetadata( filePath: string ): Promise<FileMetadata | null>
    {
        const head = await this.#head( 'getMetadata', this.#key( filePath ) );

        if( !head ){return null;}

        const modified = head.get( 'last-modified' );
        const date = modified ? new Date( modified ) : this.#now();

        return {
            path        : filePath,
            size        : Number( head.get( 'content-length' ) ) || 0,
            createdAt   : date,
            updatedAt   : date,
            contentType : head.get( 'content-type' ) ?? undefined
        };
    }

    /* ---------------------------------------------------------------------- */

    #key( filePath: string ): string
    {
        const rel = normalizeStorePath( filePath );

        return this.#prefix ? `${this.#prefix}/${rel}` : rel;
    }

    #url( key: string | null, query: Array<[ string, string ]> = [] ): URL
    {
        const encodedKey = key === null ? '' : key.split( '/' ).map( ( s ) => {return awsUriEncode( s );} ).join( '/' );
        const basePath = this.#endpoint.pathname.replace( /\/+$/, '' );
        const qs = query.map( ( [ k, v ] ) => {return v === '' ? awsUriEncode( k ) : `${awsUriEncode( k )}=${awsUriEncode( v )}`;} ).join( '&' );
        const host = this.#pathStyle ? this.#endpoint.host : `${this.#bucket}.${this.#endpoint.host}`;
        const path = this.#pathStyle ? `${basePath}/${awsUriEncode( this.#bucket )}` : basePath;

        return new URL( `${this.#endpoint.protocol}//${host}${path}${encodedKey ? `/${encodedKey}` : '/'}${qs ? `?${qs}` : ''}` );
    }

    async #send( operation: string, method: string, key: string, send: SendOptions = {} ): Promise<Response>
    {
        const url = this.#url( key, send.query );
        const payloadHash = send.body ? sha256Hex( send.body ) : EMPTY_PAYLOAD_SHA256;

        try
        {
            const creds = typeof this.#credentials === 'function' ? await this.#credentials() : this.#credentials;
            const signed = signRequest( {
                method,
                url,
                headers     : { ...send.headers, 'x-amz-content-sha256' : payloadHash },
                payloadHash,
                region      : this.#region,
                service     : 's3',
                credentials : creds,
                now         : this.#now()
            } );
            const headers = { ...signed.headers };

            delete headers.host;

            return await this.#fetch( url, { method, headers, body : send.body as BodyInit | undefined } );
        }
        catch( err )
        {
            throw wrapStorageError( 's3', `file.${operation}`, err );
        }
    }

    /** `HEAD` helper: headers when the object exists, `null` for 404, a StorageError otherwise. */
    async #head( operation: string, key: string ): Promise<Headers | null>
    {
        const res = await this.#send( operation, 'HEAD', key );

        if( res.status === 404 ){return null;}

        if( !res.ok ){throw await this.#failure( operation, res, key );}

        return res.headers;
    }

    async #failure( operation: string, res: Response, key: string ): Promise<StorageError>
    {
        let xml = '';

        try
        {
            xml = ( await res.text() ).slice( 0, ERROR_BODY_LIMIT );
        }
        catch
        {
            // Body unreadable: report the status alone.
        }

        const code = extractXmlTag( xml, 'Code' );
        const message = extractXmlTag( xml, 'Message' );

        return new StorageError(
            's3',
            `file.${operation}`,
            `HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''} (key '${key}')`,
            undefined,
            { status : res.status, code, key }
        );
    }

    #tooLarge( key: string, bytes: number ): StorageError
    {
        return new StorageError(
            's3',
            'file.read',
            `object '${key}' is ${bytes}+ bytes, above maxReadBytes (${this.#maxReadBytes}); use readStream() instead`,
            undefined,
            { key, bytes, maxReadBytes : this.#maxReadBytes }
        );
    }

    async #putObject( key: string, body: Uint8Array, contentType: string ): Promise<void>
    {
        const res = await this.#send( 'write', 'PUT', key, { body, headers : { 'content-type' : contentType } } );

        if( !res.ok ){throw await this.#failure( 'write', res, key );}

        await res.body?.cancel();
    }

    async #writeStream( key: string, stream: ReadableStream<Uint8Array>, contentType: string ): Promise<number>
    {
        const reader = stream.getReader();
        let buffered: Uint8Array[] = [];
        let bufferedBytes = 0;
        let total = 0;
        let uploadId: string | undefined;
        const parts: Array<{ number: number, etag: string }> = [];

        const take = ( n: number ): Uint8Array =>
        {
            const all = concat( buffered, bufferedBytes );

            buffered = bufferedBytes > n ? [ all.subarray( n ) ] : [];
            bufferedBytes -= n;

            return all.subarray( 0, n );
        };
        const uploadPart = async ( bytes: Uint8Array ): Promise<void> =>
        {
            if( parts.length >= MAX_PARTS )
            {
                throw new StorageError( 's3', 'file.write', `multipart upload exceeds ${MAX_PARTS} parts; increase partSizeBytes`, undefined, { key } );
            }

            const number = parts.length + 1;
            const res = await this.#send( 'write', 'PUT', key, {
                query : [ [ 'partNumber', String( number ) ], [ 'uploadId', uploadId! ] ],
                body  : bytes
            } );

            if( !res.ok ){throw await this.#failure( 'write', res, key );}

            await res.body?.cancel();

            const etag = res.headers.get( 'etag' );

            if( !etag ){throw new StorageError( 's3', 'file.write', `part ${number} response had no ETag`, undefined, { key } );}

            parts.push( { number, etag } );
        };

        try
        {
            while( true )
            {
                const { done, value } = await reader.read();

                if( done ){break;}

                if( value.byteLength === 0 ){continue;}

                buffered.push( value );
                bufferedBytes += value.byteLength;
                total += value.byteLength;

                if( uploadId === undefined && bufferedBytes > this.#threshold )
                {
                    uploadId = await this.#createMultipart( key, contentType );
                }

                while( uploadId !== undefined && bufferedBytes >= this.#partSize )
                {
                    await uploadPart( take( this.#partSize ) );
                }
            }

            if( uploadId === undefined )
            {
                await this.#putObject( key, concat( buffered, bufferedBytes ), contentType );

                return total;
            }

            if( bufferedBytes > 0 )
            {
                await uploadPart( take( bufferedBytes ) );
            }

            await this.#completeMultipart( key, uploadId, parts );

            return total;
        }
        catch( err )
        {
            if( uploadId !== undefined )
            {
                await this.#abortMultipart( key, uploadId );
            }

            await reader.cancel().catch( () => {return undefined;} );

            throw wrapStorageError( 's3', 'file.write', err );
        }
        finally
        {
            reader.releaseLock();
        }
    }

    async #createMultipart( key: string, contentType: string ): Promise<string>
    {
        const res = await this.#send( 'write', 'POST', key, { query : [ [ 'uploads', '' ] ], headers : { 'content-type' : contentType } } );

        if( !res.ok ){throw await this.#failure( 'write', res, key );}

        const uploadId = extractXmlTag( await res.text(), 'UploadId' );

        if( !uploadId ){throw new StorageError( 's3', 'file.write', 'CreateMultipartUpload response had no UploadId', undefined, { key } );}

        return uploadId;
    }

    async #completeMultipart( key: string, uploadId: string, parts: Array<{ number: number, etag: string }> ): Promise<void>
    {
        const xml = `<CompleteMultipartUpload>${parts.map( ( p ) => {return `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag}</ETag></Part>`;} ).join( '' )}</CompleteMultipartUpload>`;
        const res = await this.#send( 'write', 'POST', key, {
            query   : [ [ 'uploadId', uploadId ] ],
            body    : new TextEncoder().encode( xml ),
            headers : { 'content-type' : 'application/xml' }
        } );

        if( !res.ok ){throw await this.#failure( 'write', res, key );}

        // S3 may answer 200 and still report failure in the body.
        const body = await res.text();

        if( /<Error>/.test( body ) )
        {
            throw new StorageError(
                's3',
                'file.write',
                `CompleteMultipartUpload failed: ${extractXmlTag( body, 'Code' ) ?? 'unknown'}: ${extractXmlTag( body, 'Message' ) ?? ''}`,
                undefined,
                { key, code : extractXmlTag( body, 'Code' ) }
            );
        }
    }

    /** Best effort: the original failure is what the caller needs to see. */
    async #abortMultipart( key: string, uploadId: string ): Promise<void>
    {
        try
        {
            const res = await this.#send( 'write', 'DELETE', key, { query : [ [ 'uploadId', uploadId ] ] } );

            await res.body?.cancel();
        }
        catch
        {
            // Ignored on purpose; a lifecycle rule should clean up incomplete uploads.
        }
    }
}
