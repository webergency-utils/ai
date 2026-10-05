import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { ExecutionContext } from '../agent/context.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { UnitCostRegistry } from '../spend/unit-registry.js';
import type { CategorySpendInput } from '../spend/types.js';
import { PathEscapeError } from '../core/error.js';

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
    context? : ExecutionContext
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
    readonly #files           = new Map<string, { data: Uint8Array, metadata: FileMetadata }>();
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( options: FileStoreOptions = {} )
    {
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async write( 
        filePath: string, 
        content: Uint8Array | string | ReadableStream<Uint8Array>, 
        options?: FileStoreOperationOptions 
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

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'file_write',
            units       : data.byteLength,
            unitType    : 'bytes'
        }, options?.context );

        return metadata;
    }

    public async read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    {
        const file = this.#files.get( filePath );

        if( !file )
        {
            return null;
        }

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'file_read',
            units       : file.data.byteLength,
            unitType    : 'bytes'
        }, options?.context );

        return new Uint8Array( file.data );
    }

    public async readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    {
        const file = this.#files.get( filePath );

        if( !file )
        {
            return null;
        }

        const data = file.data;

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'file_read',
            units       : data.byteLength,
            unitType    : 'bytes'
        }, options?.context );

        return new ReadableStream<Uint8Array>( 
            {
                start( controller )
                {
                    controller.enqueue( data );
                    controller.close();
                }
            } );
    }

    public async delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    {
        const deleted = this.#files.delete( filePath );

        if( deleted )
        {
            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'file_delete',
                units       : 1,
                unitType    : 'operations'
            }, options?.context );
        }

        return deleted;
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

    #reportSpend( entry: CategorySpendInput, context?: ExecutionContext ): void
    {
        if( this.#storagePricing && entry.costUSD === undefined )
        {
            const resolved = this.#storagePricing.resolveCost( entry );

            if( resolved > 0 )
            {
                entry.costUSD = resolved;
            }
        }

        if( context )
        {
            context.reportSpend( entry );
        }
        else if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( entry );
        }
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
    readonly #baseDir         : string;
    readonly #tracker?        : SpendTracker;
    readonly #storagePricing? : UnitCostRegistry;

    constructor( baseDir: string, options: FileStoreOptions = {} )
    {
        this.#baseDir = path.resolve( baseDir );
        this.#tracker = options.tracker;
        this.#storagePricing = options.storagePricing;
    }

    public async write( 
        filePath: string, 
        content: Uint8Array | string | ReadableStream<Uint8Array>, 
        options?: FileStoreOperationOptions 
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
                let settled = false;
                const fail = ( err: unknown ): void => 
                {
                    if( settled ){ return }

                    settled = true;
                    writeStream.destroy();
                    reject( err );
                };
                const ok = (): void => 
                {
                    if( settled ){ return }

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

        this.#reportSpend( {
            category    : 'storage',
            subcategory : 'file_write',
            units       : stat.size,
            unitType    : 'bytes'
        }, options?.context );

        return {
            path      : filePath,
            size      : stat.size,
            createdAt : stat.birthtime,
            updatedAt : stat.mtime
        };
    }

    public async read( filePath: string, options?: FileStoreOperationOptions ): Promise<Uint8Array | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            const buffer = await fsPromises.readFile( fullPath );

            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'file_read',
                units       : buffer.byteLength,
                unitType    : 'bytes'
            }, options?.context );

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

    public async readStream( filePath: string, options?: FileStoreOperationOptions ): Promise<ReadableStream<Uint8Array> | null>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            await fsPromises.access( fullPath );
            const stat = await fsPromises.stat( fullPath );
            const nodeStream = fs.createReadStream( fullPath );

            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'file_read',
                units       : stat.size,
                unitType    : 'bytes'
            }, options?.context );

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

    public async delete( filePath: string, options?: FileStoreOperationOptions ): Promise<boolean>
    {
        const fullPath = this.resolveSafePath( filePath );

        try
        {
            await fsPromises.unlink( fullPath );

            this.#reportSpend( {
                category    : 'storage',
                subcategory : 'file_delete',
                units       : 1,
                unitType    : 'operations'
            }, options?.context );

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

    #reportSpend( entry: CategorySpendInput, context?: ExecutionContext ): void
    {
        if( this.#storagePricing && entry.costUSD === undefined )
        {
            const resolved = this.#storagePricing.resolveCost( entry );

            if( resolved > 0 )
            {
                entry.costUSD = resolved;
            }
        }

        if( context )
        {
            context.reportSpend( entry );
        }
        else if( this.#tracker )
        {
            this.#tracker.recordCategorySpend( entry );
        }
    }

    private resolveSafePath( filePath: string ): string
    {
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
