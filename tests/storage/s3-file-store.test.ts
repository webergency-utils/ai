import { describe, it, expect } from 'vitest';
import { S3FileStore, StorageError, extractXmlTag } from '../../src/storage/index.js';
import type { S3FileStoreOptions } from '../../src/storage/index.js';
import { InvalidInputError, PathEscapeError } from '../../src/core/error.js';
import { SimpleExecutionContext } from '../../src/agent/context.js';
import { FakeS3 } from '../helpers/fake-s3.js';
import type { FakeS3Request } from '../helpers/fake-s3.js';

function setup( over: Partial<S3FileStoreOptions> = {}, fakeOptions: ConstructorParameters<typeof FakeS3>[0] = {} )
{
    const fake = new FakeS3( fakeOptions );
    const store = new S3FileStore( {
        endpoint                : 'http://s3.test:9000',
        region                  : 'us-east-1',
        bucket                  : 'test-bucket',
        credentials             : fake.credentials,
        fetch                   : fake.fetch,
        multipartThresholdBytes : 10,
        partSizeBytes           : 10,
        ...over
    } );

    return { fake, store };
}

function chunked( ...chunks: Array<string | Uint8Array> ): ReadableStream<Uint8Array>
{
    const enc = new TextEncoder();
    let i = 0;

    return new ReadableStream<Uint8Array>( {
        pull( controller )
        {
            if( i < chunks.length )
            {
                const c = chunks[i++];

                controller.enqueue( typeof c === 'string' ? enc.encode( c ) : c );
            }
            else
            {
                controller.close();
            }
        }
    } );
}

const methods = ( reqs: FakeS3Request[] ): string[] => {return reqs.map( ( r ) => {return `${r.method}${r.url.search ? ` ${r.url.search}` : ''}`;} );};

describe( 'S3FileStore construction', () =>
{
    const base = { region : 'us-east-1', bucket : 'b', credentials : { accessKeyId : 'a', secretAccessKey : 's' } };

    it( 'validates options', () =>
    {
        expect( () => {return new S3FileStore( { ...base, region : '' } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, bucket : '' } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, bucket : 'a/b' } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, credentials : undefined as never } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, endpoint : 'not a url' } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, endpoint : 'ftp://host' } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, multipartThresholdBytes : 0 } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, partSizeBytes : 1.5 } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, maxReadBytes : -1 } );} ).toThrow( InvalidInputError );
        expect( () => {return new S3FileStore( { ...base, prefix : '../x' } );} ).toThrow( PathEscapeError );
        expect( () => {return new S3FileStore( base );} ).not.toThrow();
    } );
} );

describe( 'S3FileStore addressing and signing (R16, R19)', () =>
{
    it( 'uses path style for custom endpoints and applies the key prefix with URI encoding', async () =>
    {
        const { fake, store } = setup( { prefix : 'tenant a/' } );

        await store.write( 'dir/sp ace/ünï+$.txt', 'x' );

        const req = fake.requests[0];

        expect( req.url.origin ).toBe( 'http://s3.test:9000' );
        expect( req.url.pathname ).toBe( '/test-bucket/tenant%20a/dir/sp%20ace/%C3%BCn%C3%AF%2B%24.txt' );
        expect( req.key ).toBe( 'tenant a/dir/sp ace/ünï+$.txt' );
        expect( [ ...fake.objects.keys() ] ).toEqual( [ 'tenant a/dir/sp ace/ünï+$.txt' ] );
    } );

    it( 'uses virtual-host style when requested', async () =>
    {
        const { fake, store } = setup( { endpoint : 'https://s3.amazonaws.com', forcePathStyle : false }, { pathStyle : false } );

        await store.write( 'a/b.txt', 'x' );

        expect( fake.requests[0].url.href ).toBe( 'https://test-bucket.s3.amazonaws.com/a/b.txt' );
        expect( await store.read( 'a/b.txt' ) ).toEqual( new TextEncoder().encode( 'x' ) );
    } );

    it( 'defaults to the regional AWS endpoint in virtual-host style', async () =>
    {
        const { fake, store } = setup( { endpoint : undefined, region : 'eu-west-1' }, { pathStyle : false, region : 'eu-west-1' } );

        await store.write( 'k', 'x' );

        expect( fake.requests[0].url.href ).toBe( 'https://test-bucket.s3.eu-west-1.amazonaws.com/k' );
    } );

    it( 'signs with a rotating credentials provider and a session token', async () =>
    {
        let calls = 0;
        const fake = new FakeS3();
        const store = new S3FileStore( {
            endpoint    : 'http://s3.test',
            region      : 'us-east-1',
            bucket      : 'test-bucket',
            fetch       : fake.fetch,
            credentials : async () => {calls++; return { ...fake.credentials, sessionToken : `tok-${calls}` };}
        } );

        await store.write( 'a', 'x' );
        await store.read( 'a' );

        expect( calls ).toBe( 2 );
    } );

    it( 'fails with SignatureDoesNotMatch details when credentials are wrong', async () =>
    {
        const { store } = setup( { credentials : { accessKeyId : 'AKIDEXAMPLE', secretAccessKey : 'wrong' } } );
        const err = await store.write( 'a', 'x' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.details ).toMatchObject( { status : 403, code : 'SignatureDoesNotMatch' } );
    } );

    it( 'rejects traversal before any request is made', async () =>
    {
        const { fake, store } = setup();

        await expect( store.write( '../x', 'a' ) ).rejects.toBeInstanceOf( PathEscapeError );
        await expect( store.read( '/abs' ) ).rejects.toBeInstanceOf( PathEscapeError );
        await expect( store.exists( 'a/../../b' ) ).rejects.toBeInstanceOf( PathEscapeError );
        await expect( store.write( 'nul\0', 'a' ) ).rejects.toBeInstanceOf( PathEscapeError );
        await expect( store.write( '', 'a' ) ).rejects.toBeInstanceOf( InvalidInputError );
        expect( fake.requests ).toHaveLength( 0 );
    } );

    it( 'collapses empty and dot segments into one canonical key', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'a//b/./c.txt', 'x' );

        expect( [ ...fake.objects.keys() ] ).toEqual( [ 'a/b/c.txt' ] );
    } );
} );

describe( 'S3FileStore single-part operations', () =>
{
    it( 'sends content type from options, then extension, then octet-stream', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'a.json', '{}' );
        await store.write( 'b.PNG', new Uint8Array( [ 1 ] ) );
        await store.write( 'c', 'x' );
        await store.write( 'd.txt', 'x', { contentType : 'text/x-custom' } );

        expect( [ 'a.json', 'b.PNG', 'c', 'd.txt' ].map( ( k ) => {return fake.objects.get( k )!.contentType;} ) )
            .toEqual( [ 'application/json', 'image/png', 'application/octet-stream', 'text/x-custom' ] );
        expect( ( await store.getMetadata( 'a.json' ) )!.contentType ).toBe( 'application/json' );
    } );

    it( 'HEAD-based metadata reports size and Last-Modified', async () =>
    {
        const { store } = setup();

        await store.write( 'a.txt', 'hello' );

        const meta = await store.getMetadata( 'a.txt' );

        expect( meta ).toMatchObject( { path : 'a.txt', size : 5 } );
        expect( Math.abs( meta!.updatedAt.getTime() - Date.now() ) ).toBeLessThan( 5000 );
        expect( meta!.createdAt ).toEqual( meta!.updatedAt );
    } );

    it( 'distinguishes 404 (missing) from 403 and 5xx (errors) for every operation', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'a', 'x' );
        fake.failures.push( { match : ( r ) => {return r.key === 'a' && r.method !== 'PUT';}, status : 403, code : 'AccessDenied', message : 'Access Denied' } );

        for( const run of [
            () => {return store.read( 'a' );},
            () => {return store.readStream( 'a' );},
            () => {return store.exists( 'a' );},
            () => {return store.getMetadata( 'a' );},
            () => {return store.delete( 'a' );}
        ] )
        {
            const err = await run().then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

            expect( err ).toBeInstanceOf( StorageError );
            expect( err.backend ).toBe( 's3' );
            // HEAD responses carry no body, so only GET errors expose the S3 code.
            expect( ( err.details as { status: number } ).status ).toBe( 403 );
        }

        fake.failures.length = 0;
        fake.failures.push( { match : ( r ) => {return r.method === 'PUT';}, status : 503, code : 'SlowDown', message : 'Reduce your request rate.' } );

        const put = await store.write( 'b', 'x' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( put.details ).toMatchObject( { status : 503, code : 'SlowDown' } );
        expect( put.message ).toContain( 'SlowDown' );
        expect( put.message ).toContain( 'Reduce your request rate.' );
    } );

    it( 'treats a 404 on read, readStream, exists, metadata and delete as missing', async () =>
    {
        const { store } = setup();

        expect( await store.read( 'nope' ) ).toBeNull();
        expect( await store.readStream( 'nope' ) ).toBeNull();
        expect( await store.exists( 'nope' ) ).toBe( false );
        expect( await store.getMetadata( 'nope' ) ).toBeNull();
        expect( await store.delete( 'nope' ) ).toBe( false );
    } );

    it( 'delete issues HEAD then DELETE, and skips DELETE for missing keys', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'a', 'x' );
        fake.requests.length = 0;

        expect( await store.delete( 'a' ) ).toBe( true );
        expect( methods( fake.requests ) ).toEqual( [ 'HEAD', 'DELETE' ] );

        fake.requests.length = 0;
        expect( await store.delete( 'a' ) ).toBe( false );
        expect( methods( fake.requests ) ).toEqual( [ 'HEAD' ] );
    } );

    it( 'wraps network failures in StorageError', async () =>
    {
        const store = new S3FileStore( {
            endpoint    : 'http://s3.test',
            region      : 'r',
            bucket      : 'b',
            credentials : { accessKeyId : 'a', secretAccessKey : 's' },
            fetch       : async () => {throw new TypeError( 'fetch failed' );}
        } );
        const err = await store.read( 'a' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.message ).toContain( 'fetch failed' );
        expect( err.operation ).toBe( 'file.read' );
    } );
} );

describe( 'S3FileStore reads (R18)', () =>
{
    it( 'refuses objects above maxReadBytes by Content-Length without reading the body', async () =>
    {
        const { fake, store } = setup( { maxReadBytes : 8 } );

        await store.write( 'big', '123456789' );
        await store.write( 'ok', '12345678' );

        const err = await store.read( 'big' ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.message ).toContain( 'maxReadBytes' );
        expect( new TextDecoder().decode( ( await store.read( 'ok' ) )! ) ).toBe( '12345678' );
        expect( fake.requestsFor( 'big' ).filter( ( r ) => {return r.method === 'GET';} ) ).toHaveLength( 1 );
    } );

    it( 'enforces maxReadBytes on the streamed body when Content-Length is absent or lies', async () =>
    {
        const body = new Uint8Array( 20 );
        const store = new S3FileStore( {
            endpoint     : 'http://s3.test',
            region       : 'r',
            bucket       : 'b',
            credentials  : { accessKeyId : 'a', secretAccessKey : 's' },
            maxReadBytes : 8,
            fetch        : async () => {return new Response( chunked( body.subarray( 0, 6 ), body.subarray( 6 ) ) );}
        } );

        await expect( store.read( 'x' ) ).rejects.toThrow( /maxReadBytes/ );
    } );

    it( 'readStream hands back the response body without buffering it', async () =>
    {
        let pulled = 0;
        const source = new ReadableStream<Uint8Array>( {
            pull( controller )
            {
                if( pulled < 5 )
                {
                    controller.enqueue( new Uint8Array( [ pulled++ ] ) );
                }
                else
                {
                    controller.close();
                }
            }
        }, { highWaterMark : 0 } );
        const store = new S3FileStore( {
            endpoint    : 'http://s3.test',
            region      : 'r',
            bucket      : 'b',
            credentials : { accessKeyId : 'a', secretAccessKey : 's' },
            fetch       : async () => {return new Response( source, { headers : { 'content-length' : '5' } } );}
        } );
        const stream = await store.readStream( 'x' );

        expect( pulled ).toBe( 0 );

        const reader = stream!.getReader();

        expect( ( await reader.read() ).value ).toEqual( new Uint8Array( [ 0 ] ) );
        expect( pulled ).toBe( 1 );
    } );
} );

describe( 'S3FileStore writes and multipart (R17)', () =>
{
    it( 'uses a single PutObject for streams at or below the threshold', async () =>
    {
        const { fake, store } = setup();
        const meta = await store.write( 'a.txt', chunked( '12345', '67890' ) );

        expect( meta.size ).toBe( 10 );
        expect( methods( fake.requests ) ).toEqual( [ 'PUT' ] );
        expect( new TextDecoder().decode( fake.objects.get( 'a.txt' )!.data ) ).toBe( '1234567890' );
    } );

    it( 'switches to multipart above the threshold with sequential parts and a final short part', async () =>
    {
        const { fake, store } = setup();
        const meta = await store.write( 'a.txt', chunked( 'abcdef', 'ghijkl', 'mnopqrstuvwx', 'yz' ) );

        expect( meta.size ).toBe( 26 );
        expect( methods( fake.requests ) ).toEqual( [ 'POST ?uploads', 'PUT ?partNumber=1&uploadId=upload-1', 'PUT ?partNumber=2&uploadId=upload-1', 'PUT ?partNumber=3&uploadId=upload-1', 'POST ?uploadId=upload-1' ] );
        expect( [ ...fake.requests.filter( ( r ) => {return r.query.partNumber;} ) ].map( ( r ) => {return r.body.byteLength;} ) ).toEqual( [ 10, 10, 6 ] );
        expect( new TextDecoder().decode( fake.objects.get( 'a.txt' )!.data ) ).toBe( 'abcdefghijklmnopqrstuvwxyz' );
        expect( fake.uploads.size ).toBe( 0 );
        expect( fake.objects.get( 'a.txt' )!.contentType ).toBe( 'text/plain' );
    } );

    it( 'handles content that is an exact multiple of the part size and many tiny chunks', async () =>
    {
        const { fake, store } = setup();
        const tiny = Array.from( { length : 30 }, ( _, i ) => {return String.fromCharCode( 97 + ( i % 26 ) );} );

        await store.write( 'exact', chunked( '0123456789', '0123456789' ) );
        await store.write( 'tiny', chunked( ...tiny ) );

        expect( fake.objects.get( 'exact' )!.data.byteLength ).toBe( 20 );
        expect( new TextDecoder().decode( fake.objects.get( 'tiny' )!.data ) ).toBe( tiny.join( '' ) );
        expect( fake.requests.filter( ( r ) => {return r.key === 'exact' && r.query.partNumber;} ).map( ( r ) => {return r.body.byteLength;} ) ).toEqual( [ 10, 10 ] );
    } );

    it( 'skips empty chunks and writes an empty stream as an empty object', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'e', chunked( new Uint8Array(), new Uint8Array() ) );

        expect( fake.objects.get( 'e' )!.data.byteLength ).toBe( 0 );
        expect( methods( fake.requests ) ).toEqual( [ 'PUT' ] );
    } );

    it( 'aborts the multipart upload and rejects with StorageError when part 2 fails (AE8)', async () =>
    {
        const { fake, store } = setup();

        fake.failures.push( { match : ( r ) => {return r.query.partNumber === '2';}, status : 500, code : 'InternalError', message : 'We encountered an internal error.' } );

        const err = await store.write( 'a.txt', chunked( 'abcdefghij', 'klmnopqrst', 'uvwxyz' ) ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.details ).toMatchObject( { status : 500, code : 'InternalError' } );
        expect( methods( fake.requests ).at( -1 ) ).toBe( 'DELETE ?uploadId=upload-1' );
        expect( fake.uploads.size ).toBe( 0 );
        expect( fake.objects.has( 'a.txt' ) ).toBe( false );
    } );

    it( 'aborts when the source stream errors mid-upload', async () =>
    {
        const { fake, store } = setup();
        let n = 0;
        const broken = new ReadableStream<Uint8Array>( {
            pull( controller )
            {
                if( n++ < 3 )
                {
                    controller.enqueue( new TextEncoder().encode( 'abcdefghij' ) );
                }
                else
                {
                    controller.error( new Error( 'source exploded' ) );
                }
            }
        } );

        const err = await store.write( 'a', broken ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err ).toBeInstanceOf( StorageError );
        expect( err.message ).toContain( 'source exploded' );
        expect( fake.uploads.size ).toBe( 0 );
        expect( methods( fake.requests ).at( -1 ) ).toBe( 'DELETE ?uploadId=upload-1' );
    } );

    it( 'still rejects with the original error when AbortMultipartUpload itself fails', async () =>
    {
        const { fake, store } = setup();

        fake.failures.push( { match : ( r ) => {return r.query.partNumber === '2';}, status : 500, code : 'InternalError' } );
        fake.failures.push( { match : ( r ) => {return r.method === 'DELETE';}, status : 500, code : 'AbortFailed' } );

        const err = await store.write( 'a', chunked( 'abcdefghij', 'klmnopqrst', 'u' ) ).then( () => {return null;}, ( e: unknown ) => {return e;} ) as StorageError;

        expect( err.details ).toMatchObject( { code : 'InternalError' } );
    } );

    it( 'fails and aborts when CreateMultipartUpload gives no UploadId or CompleteMultipartUpload returns an error body', async () =>
    {
        const noId = new S3FileStore( {
            endpoint                : 'http://s3.test', region                  : 'r', bucket                  : 'b', credentials             : { accessKeyId : 'a', secretAccessKey : 's' },
            multipartThresholdBytes : 2, partSizeBytes           : 2,
            fetch                   : async () => {return new Response( '<Nothing/>' );}
        } );

        await expect( noId.write( 'a', chunked( 'abc' ) ) ).rejects.toThrow( /UploadId/ );

        const { fake, store } = setup();
        const inner = fake.fetch;
        const wrapped = new S3FileStore( {
            endpoint                : 'http://s3.test', region                  : 'us-east-1', bucket                  : 'test-bucket', credentials             : fake.credentials,
            multipartThresholdBytes : 4, partSizeBytes           : 4,
            fetch                   : async ( url, init ) =>
            {
                const res = await inner( url, init );

                if( init?.method === 'POST' && String( url ).includes( 'uploadId' ) )
                {
                    return new Response( '<Error><Code>InternalError</Code><Message>boom</Message></Error>', { status : 200 } );
                }

                return res;
            }
        } );

        await expect( wrapped.write( 'a', chunked( 'abcdefgh', 'ij' ) ) ).rejects.toThrow( /CompleteMultipartUpload failed: InternalError: boom/ );
        expect( store ).toBeDefined();
    } );

    it( 'fails when a part response has no ETag', async () =>
    {
        const { fake } = setup();
        const inner = fake.fetch;
        const store = new S3FileStore( {
            endpoint                : 'http://s3.test', region                  : 'us-east-1', bucket                  : 'test-bucket', credentials             : fake.credentials,
            multipartThresholdBytes : 4, partSizeBytes           : 4,
            fetch                   : async ( url, init ) =>
            {
                const res = await inner( url, init );

                return init?.method === 'PUT' && String( url ).includes( 'partNumber' ) ? new Response( null, { status : 200 } ) : res;
            }
        } );

        await expect( store.write( 'a', chunked( 'abcdefgh' ) ) ).rejects.toThrow( /no ETag/ );
        expect( fake.uploads.size ).toBe( 0 );
    } );

    it( 'caps multipart uploads at 10,000 parts', async () =>
    {
        const { fake, store } = setup( { multipartThresholdBytes : 1, partSizeBytes : 1 } );
        const huge = new ReadableStream<Uint8Array>( {
            pull( controller ){controller.enqueue( new Uint8Array( 20_000 ) );}
        } );

        await expect( store.write( 'a', huge ) ).rejects.toThrow( /10000 parts/ );
        expect( fake.uploads.size ).toBe( 0 );
    } );

    it( 'writes strings and byte arrays as one PutObject regardless of size', async () =>
    {
        const { fake, store } = setup();

        await store.write( 'a', 'x'.repeat( 100 ) );
        await store.write( 'b', new Uint8Array( 100 ) );

        expect( methods( fake.requests ) ).toEqual( [ 'PUT', 'PUT' ] );
    } );
} );

describe( 'S3FileStore instrumentation', () =>
{
    it( 'emits storage:file spans and bytes/operations spend', async () =>
    {
        const spans: string[] = [];
        const spend: Array<[ string | undefined, number | undefined, string | undefined ]> = [];
        const ctx = new SimpleExecutionContext( {
            onSpanEnd : ( s ) => {spans.push( s.name );},
            onSpend   : ( e ) => {spend.push( [ e.subcategory, e.units, e.unitType ] );}
        } );
        const { store } = setup();

        await store.write( 'a', 'hello', { context : ctx } );
        await store.read( 'a', { context : ctx } );
        await store.readStream( 'a', { context : ctx } );
        await store.delete( 'a', { context : ctx } );
        await store.delete( 'a', { context : ctx } );

        expect( spans ).toEqual( [ 'storage:file:write', 'storage:file:read', 'storage:file:readStream', 'storage:file:delete', 'storage:file:delete' ] );
        expect( spend ).toEqual( [
            [ 'file_write', 5, 'bytes' ],
            [ 'file_read', 5, 'bytes' ],
            [ 'file_read', 5, 'bytes' ],
            [ 'file_delete', 1, 'operations' ]
        ] );
    } );
} );

describe( 'extractXmlTag', () =>
{
    it( 'extracts and unescapes the first matching element', () =>
    {
        expect( extractXmlTag( '<Error><Code>AccessDenied</Code><Message>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;</Message></Error>', 'Message' ) ).toBe( 'a & b <c> "d" \'e\'' );
        expect( extractXmlTag( '<A>1</A><A>2</A>', 'A' ) ).toBe( '1' );
        expect( extractXmlTag( '<A>multi\nline</A>', 'A' ) ).toBe( 'multi\nline' );
        expect( extractXmlTag( '<A></A>', 'A' ) ).toBe( '' );
        expect( extractXmlTag( '<B>1</B>', 'A' ) ).toBeUndefined();
        expect( extractXmlTag( '', 'A' ) ).toBeUndefined();
    } );
} );
