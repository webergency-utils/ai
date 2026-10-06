import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import { StorageInstrument } from './instrument.js';
import { PathEscapeError } from '../core/error.js';
import { assertNoNul } from './path.js';

export interface FileMetadata
{
    path         : string
    size         : number
    createdAt    : Date
    updatedAt    : Date
    contentType? : string
}

export interface FileStoreOptions
{
    tracker?        : SpendTracker
    storagePricing? : UnitCostRegistry
}

export interface FileStoreOperationOptions
{
    context?     : ExecutionContext
    /** Stored content type for backends that persist one (object stores); ignored by memory and disk stores. */
    contentType? : string
}

export interface IFileStore
{
    write( filePath: string, content: Uint8Array | string | ReadableStream<Uint8Array>, options?: FileStoreOperationOptions ): Promise<FileMetadata>
    read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    exists( filePath: string ): Promise<boolean>
    getMetadata( filePath: string ): Promise<FileMetadata | null>
}

export class MemoryFileStore implements IFileStore
{
    readonly #files      = new Map<string, { data: Uint8Array, metadata: FileMetadata }>();
    readonly #instrument : StorageInstrument;

    constructor( options: FileStoreOptions = {} )
    {
        this.#instrument = new StorageInstrument( 'file', options );
    }

    public async write(
        filePath: string,
        content: Uint8Array | string | ReadableStream<Uint8Array>,
        options?: FileStoreOperationOptions
    ): Promise<FileMetadata>
    {
        return this.#instrument.run( 'write', options?.context, { path : filePath }, async ( ctx ) =>
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
            const metadata: FileMetadata =
                {
                    path      : filePath,
                    size      : data.byteLength,
                    createdAt : existing ? existing.metadata.createdAt : now,
                    updatedAt : now
                };

            this.#files.set( filePath, { data, metadata } );
            this.#instrument.spend( 'file_write', data.byteLength, 'bytes', ctx );

            return metadata;
        } );
    }

    public async read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    {
        return this.#instrument.run( 'read', options?.context, { path : filePath }, async ( ctx ) =>
        {
            const file = this.#files.get( filePath );

            if( !file ){return null;}

            this.#instrument.spend( 'file_read', file.data.byteLength, 'bytes', ctx );

            return new Uint8Array( file.data );
        } );
    }

    public async readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    {
        return this.#instrument.run( 'readStream', options?.context, { path : filePath }, async ( ctx ) =>
        {
            const file = this.#files.get( filePath );

            if( !file ){return null;}

            const data = file.data;

            this.#instrument.spend( 'file_read', data.byteLength, 'bytes', ctx );

            return new ReadableStream<Uint8Array>( {
                start( controller )
                {
                    controller.enqueue( data );
                    controller.close();
                }
            } );
        } );
    }

    public async delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    {
        return this.#instrument.run( 'delete', options?.context, { path : filePath }, async ( ctx ) =>
        {
            const deleted = this.#files.delete( filePath );

            if( deleted )
            {
                this.#instrument.spend( 'file_delete', 1, 'operations', ctx );
            }

            return deleted;
        } );
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
    readonly #baseDir    : string;
    readonly #instrument : StorageInstrument;

    constructor( baseDir: string, options: FileStoreOptions = {} )
    {
        this.#baseDir = path.resolve( baseDir );
        this.#instrument = new StorageInstrument( 'file', options );
    }

    public async write(
        filePath: string,
        content: Uint8Array | string | ReadableStream<Uint8Array>,
        options?: FileStoreOperationOptions
    ): Promise<FileMetadata>
    {
        const fullPath = this.resolveSafePath( filePath );

        return this.#instrument.run( 'write', options?.context, { path : filePath }, async ( ctx ) =>
        {
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
                    let settled = false;
                    const fail = ( err: unknown ): void =>
                    {
                        if( settled ){return;}

                        settled = true;
                        writeStream.destroy();
                        reject( err );
                    };
                    const ok = (): void =>
                    {
                        if( settled ){return;}

                        settled = true;
                        resolve();
                    };

                    nodeStream.on( 'error', fail );
                    writeStream.on( 'error', fail );
                    writeStream.on( 'finish', ok );
                    nodeStream.pipe( writeStream );
                } );
            }

            const stat = await fsPromises.stat( fullPath );

            this.#instrument.spend( 'file_write', stat.size, 'bytes', ctx );

            return { path : filePath, size : stat.size, createdAt : stat.birthtime, updatedAt : stat.mtime };
        } );
    }

    public async read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        return this.#instrument.run( 'read', options?.context, { path : filePath }, async ( ctx ) =>
        {
            try
            {
                const buffer = await fsPromises.readFile( fullPath );

                this.#instrument.spend( 'file_read', buffer.byteLength, 'bytes', ctx );

                return new Uint8Array( buffer.buffer, buffer.byteOffset, buffer.byteLength );
            }
            catch( err: unknown )
            {
                if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' ){return null;}

                throw err;
            }
        } );
    }

    public async readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        return this.#instrument.run( 'readStream', options?.context, { path : filePath }, async ( ctx ) =>
        {
            try
            {
                await fsPromises.access( fullPath );

                const stat = await fsPromises.stat( fullPath );
                const nodeStream = fs.createReadStream( fullPath );

                this.#instrument.spend( 'file_read', stat.size, 'bytes', ctx );

                return Readable.toWeb( nodeStream ) as ReadableStream<Uint8Array>;
            }
            catch( err: unknown )
            {
                if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' ){return null;}

                throw err;
            }
        } );
    }

    public async delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    {
        const fullPath = this.resolveSafePath( filePath );

        return this.#instrument.run( 'delete', options?.context, { path : filePath }, async ( ctx ) =>
        {
            try
            {
                await fsPromises.unlink( fullPath );
                this.#instrument.spend( 'file_delete', 1, 'operations', ctx );

                return true;
            }
            catch( err: unknown )
            {
                if( ( err as NodeJS.ErrnoException ).code === 'ENOENT' ){return false;}

                throw err;
            }
        } );
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
        assertNoNul( filePath );

        const fullPath = path.resolve( this.#baseDir, filePath );
        const rel = path.relative( this.#baseDir, fullPath );

        // Reject parent-directory traversal, but allow names that merely start with ".." (R34).
        const segments = rel.split( path.sep );

        if( 
            path.isAbsolute( rel ) 
            || segments.some( ( segment ) => {return segment === '..';} ) 
        )
        {
            throw new PathEscapeError( 
                filePath, 
                `Access denied: path '${filePath}' traverses outside root directory` 
            );
        }

        // Resolve symlinks when the path already exists so a link cannot escape the root.
        try
        {
            const realBase = fs.realpathSync.native( this.#baseDir );
            const parentDir = path.dirname( fullPath );

            if( fs.existsSync( parentDir ) )
            {
                const realParent = fs.realpathSync.native( parentDir );
                const candidate = path.join( realParent, path.basename( fullPath ) );
                const realRel = path.relative( realBase, candidate );
                const realSegments = realRel.split( path.sep );

                if( 
                    path.isAbsolute( realRel ) 
                    || realSegments.some( ( segment ) => {return segment === '..';} ) 
                )
                {
                    throw new PathEscapeError( 
                        filePath, 
                        `Access denied: path '${filePath}' escapes store root via symlink` 
                    );
                }

                if( fs.existsSync( fullPath ) )
                {
                    const realFile = fs.realpathSync.native( fullPath );
                    const fileRel = path.relative( realBase, realFile );
                    const fileSegments = fileRel.split( path.sep );

                    if( 
                        path.isAbsolute( fileRel ) 
                        || fileSegments.some( ( segment ) => {return segment === '..';} ) 
                    )
                    {
                        throw new PathEscapeError( 
                            filePath, 
                            `Access denied: path '${filePath}' escapes store root via symlink` 
                        );
                    }

                    return realFile;
                }

                return candidate;
            }
        }
        catch( err )
        {
            if( err instanceof PathEscapeError )
            {
                throw err;
            }

            // Fall through to the resolved path when realpath is unavailable.
        }

        return fullPath;
    }
}
