import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export interface FileMetadata
{
    path         : string
    size         : number
    createdAt    : Date
    updatedAt    : Date
    contentType? : string
}

export interface IFileStore
{
    write( filePath: string, content: Uint8Array | string | ReadableStream<Uint8Array> ): Promise<FileMetadata>
    read( filePath: string ): Promise<Uint8Array | null>
    readStream( filePath: string ): Promise<ReadableStream<Uint8Array> | null>
    delete( filePath: string ): Promise<boolean>
    exists( filePath: string ): Promise<boolean>
    getMetadata( filePath: string ): Promise<FileMetadata | null>
}

export class MemoryFileStore implements IFileStore
{
    readonly #files = new Map<string, { data: Uint8Array, metadata: FileMetadata }>();

    public async write( 
        filePath: string, 
        content: Uint8Array | string | ReadableStream<Uint8Array> 
    ): Promise<FileMetadata>
    {
        let data: Uint8Array;

        if( typeof content === 'string' )
        {
            data = new TextEncoder().encode( content );
        }
        else if( content instanceof Uint8Array )
        {
            data = new Uint8Array( content );
        }
        else
        {
            data = await this.readWebStream( content );
        }

        const now = new Date();
        const existing = this.#files.get( filePath );
        const createdAt = existing ? existing.metadata.createdAt : now;

        const metadata: FileMetadata = 
            {
                path      : filePath,
                size      : data.byteLength,
                createdAt,
                updatedAt : now
            };

        this.#files.set( filePath, { data, metadata } );

        return metadata;
    }

    public async read( filePath: string ): Promise<Uint8Array | null>
    {
        const file = this.#files.get( filePath );

        if( !file )
        {
            return null;
        }

        return new Uint8Array( file.data );
    }

    public async readStream( filePath: string ): Promise<ReadableStream<Uint8Array> | null>
    {
        const file = this.#files.get( filePath );

        if( !file )
        {
            return null;
        }

        const data = file.data;

        return new ReadableStream<Uint8Array>( 
            {
                start( controller )
                {
                    controller.enqueue( data );
                    controller.close();
                }
            } );
    }

    public async delete( filePath: string ): Promise<boolean>
    {
        return this.#files.delete( filePath );
    }

    public async exists( filePath: string ): Promise<boolean>
    {
        return this.#files.has( filePath );
    }

    public async getMetadata( filePath: string ): Promise<FileMetadata | null>
    {
        const file = this.#files.get( filePath );

        return file ? structuredClone( file.metadata ) : null;
    }

    private async readWebStream( stream: ReadableStream<Uint8Array> ): Promise<Uint8Array>
    {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        try
        {
            while( true )
            {
                const { done, value } = await reader.read();

                if( done )
                {
                    break;
                }

                if( value )
                {
                    chunks.push( value );
                    totalLength += value.byteLength;
                }
            }
        }
        finally
        {
            reader.releaseLock();
        }

        const result = new Uint8Array( totalLength );
        let offset = 0;

        for( const chunk of chunks )
        {
            result.set( chunk, offset );
            offset += chunk.byteLength;
        }

        return result;
    }
}

export class LocalDiskFileStore implements IFileStore
{
    readonly #baseDir: string;

    constructor( baseDir: string )
    {
        this.#baseDir = path.resolve( baseDir );
    }

    public async write( 
        filePath: string, 
        content: Uint8Array | string | ReadableStream<Uint8Array> 
    ): Promise<FileMetadata>
    {
        const fullPath = this.resolveSafePath( filePath );
        await fsPromises.mkdir( path.dirname( fullPath ), { recursive : true } );

        if( typeof content === 'string' )
        {
            await fsPromises.writeFile( fullPath, content, 'utf8' );
        }
        else if( content instanceof Uint8Array )
        {
            await fsPromises.writeFile( fullPath, content );
        }
        else
        {
            const nodeStream = Readable.fromWeb( content as unknown as NodeReadableStream );
            const writeStream = fs.createWriteStream( fullPath );
            await new Promise<void>( ( resolve, reject ) => 
            {
                nodeStream.pipe( writeStream );
                writeStream.on( 'finish', () => {resolve();} );
                writeStream.on( 'error', ( err ) => {reject( err );} );
            } );
        }

        const stat = await fsPromises.stat( fullPath );

        return {
            path      : filePath,
            size      : stat.size,
            createdAt : stat.birthtime,
            updatedAt : stat.mtime
        };
    }

    public async read( filePath: string ): Promise<Uint8Array | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            const buffer = await fsPromises.readFile( fullPath );

            return new Uint8Array( buffer.buffer, buffer.byteOffset, buffer.byteLength );
        }
        catch( err: unknown )
        {
            if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' )
            {
                return null;
            }

            throw err;
        }
    }

    public async readStream( filePath: string ): Promise<ReadableStream<Uint8Array> | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            await fsPromises.access( fullPath );
            const nodeStream = fs.createReadStream( fullPath );

            return Readable.toWeb( nodeStream ) as ReadableStream<Uint8Array>;
        }
        catch( err: unknown )
        {
            if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' )
            {
                return null;
            }

            throw err;
        }
    }

    public async delete( filePath: string ): Promise<boolean>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            await fsPromises.unlink( fullPath );

            return true;
        }
        catch( err: unknown )
        {
            if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' )
            {
                return false;
            }

            throw err;
        }
    }

    public async exists( filePath: string ): Promise<boolean>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            await fsPromises.access( fullPath );

            return true;
        }
        catch
        {
            return false;
        }
    }

    public async getMetadata( filePath: string ): Promise<FileMetadata | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            const stat = await fsPromises.stat( fullPath );

            return {
                path      : filePath,
                size      : stat.size,
                createdAt : stat.birthtime,
                updatedAt : stat.mtime
            };
        }
        catch( err: unknown )
        {
            if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' )
            {
                return null;
            }

            throw err;
        }
    }

    private resolveSafePath( filePath: string ): string
    {
        const fullPath = path.resolve( this.#baseDir, filePath );
        const rel = path.relative( this.#baseDir, fullPath );

        if( rel.startsWith( '..' ) || path.isAbsolute( rel ) )
        {
            throw new Error( `Access denied: path '${filePath}' traverses outside root directory` );
        }

        return fullPath;
    }
}
