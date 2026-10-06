import { describe, it, expect } from 'vitest';
import { awsUriEncode, canonicalQueryString, deriveSigningKey, sha256Hex, signRequest, EMPTY_PAYLOAD_SHA256 } from '../../src/storage/adapters/s3-sigv4.js';

const S3_CREDS = { accessKeyId : 'AKIAIOSFODNN7EXAMPLE', secretAccessKey : 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_DATE = new Date( '2013-05-24T00:00:00Z' );

describe( 'SigV4 published test vectors', () =>
{
    it( 'matches the AWS Signature V4 test suite "get-vanilla"', () =>
    {
        const signed = signRequest( {
            method           : 'GET',
            url              : 'https://example.amazonaws.com/',
            payloadHash      : EMPTY_PAYLOAD_SHA256,
            region           : 'us-east-1',
            service          : 'service',
            credentials      : { accessKeyId : 'AKIDEXAMPLE', secretAccessKey : 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
            now              : new Date( '2015-08-30T12:36:00Z' ),
            doubleEncodePath : true
        } );

        expect( signed.canonicalRequest ).toBe(
            'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        );
        expect( sha256Hex( signed.canonicalRequest ) ).toBe( 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63' );
        expect( signed.signature ).toBe( '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31' );
        expect( signed.authorization ).toBe(
            'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
        );
    } );

    it( 'matches the S3 documentation example "GET Object" with a Range header', () =>
    {
        const signed = signRequest( {
            method      : 'GET',
            url         : 'https://examplebucket.s3.amazonaws.com/test.txt',
            headers     : { Range : 'bytes=0-9', 'x-amz-content-sha256' : EMPTY_PAYLOAD_SHA256 },
            payloadHash : EMPTY_PAYLOAD_SHA256,
            region      : 'us-east-1',
            service     : 's3',
            credentials : S3_CREDS,
            now         : S3_DATE
        } );

        expect( signed.canonicalRequest ).toBe(
            'GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        );
        expect( signed.signature ).toBe( 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41' );
    } );

    it( 'matches the S3 documentation example "PUT Object" (encoded key, storage class header)', () =>
    {
        const body = 'Welcome to Amazon S3.';
        const signed = signRequest( {
            method  : 'PUT',
            url     : 'https://examplebucket.s3.amazonaws.com/test%24file.text',
            headers : {
                Date                   : 'Fri, 24 May 2013 00:00:00 GMT',
                'x-amz-storage-class'  : 'REDUCED_REDUNDANCY',
                'x-amz-content-sha256' : sha256Hex( body )
            },
            payloadHash : sha256Hex( body ),
            region      : 'us-east-1',
            service     : 's3',
            credentials : S3_CREDS,
            now         : S3_DATE
        } );

        expect( sha256Hex( body ) ).toBe( '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072' );
        expect( signed.signature ).toBe( '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd' );
    } );

    it( 'matches the S3 documentation example "GET Bucket Lifecycle" (valueless query parameter)', () =>
    {
        const signed = signRequest( {
            method      : 'GET',
            url         : 'https://examplebucket.s3.amazonaws.com/?lifecycle',
            headers     : { 'x-amz-content-sha256' : EMPTY_PAYLOAD_SHA256 },
            payloadHash : EMPTY_PAYLOAD_SHA256,
            region      : 'us-east-1',
            service     : 's3',
            credentials : S3_CREDS,
            now         : S3_DATE
        } );

        expect( signed.canonicalRequest.split( '\n' )[2] ).toBe( 'lifecycle=' );
        expect( signed.signature ).toBe( 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543' );
    } );

    it( 'matches the S3 documentation example "GET Bucket (List Objects)" (sorted query parameters)', () =>
    {
        const signed = signRequest( {
            method      : 'GET',
            url         : 'https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2',
            headers     : { 'x-amz-content-sha256' : EMPTY_PAYLOAD_SHA256 },
            payloadHash : EMPTY_PAYLOAD_SHA256,
            region      : 'us-east-1',
            service     : 's3',
            credentials : S3_CREDS,
            now         : S3_DATE
        } );

        expect( signed.canonicalRequest.split( '\n' )[2] ).toBe( 'max-keys=2&prefix=J' );
        expect( signed.signature ).toBe( '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7' );
    } );

    it( 'derives the documented signing key', () =>
    {
        const key = deriveSigningKey( 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam' );

        expect( key.toString( 'hex' ) ).toBe( 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d' );
    } );
} );

describe( 'SigV4 building blocks', () =>
{
    it( 'percent-encodes everything except unreserved characters', () =>
    {
        expect( awsUriEncode( 'a b/c$d+e~f-g_h.i' ) ).toBe( 'a%20b%2Fc%24d%2Be~f-g_h.i' );
        expect( awsUriEncode( 'a b/c', true ) ).toBe( 'a%20b/c' );
        expect( awsUriEncode( 'ünï\'()*!' ) ).toBe( '%C3%BCn%C3%AF%27%28%29%2A%21' );
        expect( awsUriEncode( '' ) ).toBe( '' );
    } );

    it( 'canonicalizes queries: sorting, encoding, empty values, duplicate names', () =>
    {
        expect( canonicalQueryString( '' ) ).toBe( '' );
        expect( canonicalQueryString( '?' ) ).toBe( '' );
        expect( canonicalQueryString( '?b=2&a=1' ) ).toBe( 'a=1&b=2' );
        expect( canonicalQueryString( '?uploads' ) ).toBe( 'uploads=' );
        expect( canonicalQueryString( '?k=a%2Fb+c' ) ).toBe( 'k=a%2Fb%2Bc' );
        expect( canonicalQueryString( '?a=2&a=1' ) ).toBe( 'a=1&a=2' );
        expect( canonicalQueryString( '?partNumber=1&uploadId=X%2FY' ) ).toBe( 'partNumber=1&uploadId=X%2FY' );
    } );

    it( 'adds the session token to the signed headers', () =>
    {
        const signed = signRequest( {
            method      : 'GET',
            url         : 'https://h.example/',
            payloadHash : EMPTY_PAYLOAD_SHA256,
            region      : 'r',
            service     : 's3',
            credentials : { ...S3_CREDS, sessionToken : 'TOKEN' },
            now         : S3_DATE
        } );

        expect( signed.headers['x-amz-security-token'] ).toBe( 'TOKEN' );
        expect( signed.authorization ).toContain( 'SignedHeaders=host;x-amz-date;x-amz-security-token' );
    } );

    it( 'normalizes header whitespace and case, and includes non-default ports in host', () =>
    {
        const signed = signRequest( {
            method      : 'put',
            url         : 'http://localhost:9000/b/k',
            headers     : { 'Content-Type' : '  text/plain   ;  charset=utf-8 ' },
            payloadHash : EMPTY_PAYLOAD_SHA256,
            region      : 'r',
            service     : 's3',
            credentials : S3_CREDS,
            now         : S3_DATE
        } );

        expect( signed.canonicalRequest ).toContain( 'content-type:text/plain ; charset=utf-8\n' );
        expect( signed.canonicalRequest ).toContain( 'host:localhost:9000\n' );
        expect( signed.canonicalRequest.startsWith( 'PUT\n' ) ).toBe( true );
    } );

    it( 'is deterministic and responds to every input', () =>
    {
        const base = { method : 'GET', url : 'https://h.example/a', payloadHash : EMPTY_PAYLOAD_SHA256, region : 'r', service : 's3', credentials : S3_CREDS, now : S3_DATE };
        const sig = ( over: object ): string => {return signRequest( { ...base, ...over } ).signature;};

        expect( sig( {} ) ).toBe( sig( {} ) );
        expect( sig( { url : 'https://h.example/b' } ) ).not.toBe( sig( {} ) );
        expect( sig( { region : 'q' } ) ).not.toBe( sig( {} ) );
        expect( sig( { now : new Date( '2013-05-24T00:00:01Z' ) } ) ).not.toBe( sig( {} ) );
        expect( sig( { credentials : { ...S3_CREDS, secretAccessKey : 'other' } } ) ).not.toBe( sig( {} ) );
    } );
} );
