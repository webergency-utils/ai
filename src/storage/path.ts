import { InvalidInputError, PathEscapeError } from '../core/error.js';

/** Rejects NUL bytes, which truncate paths in many native layers. */
export function assertNoNul( filePath: string ): void
{
    if( filePath.includes( '\0' ) )
    {
        throw new PathEscapeError( filePath.replace( /\0/g, '\\0' ), 'Access denied: path contains a NUL byte' );
    }
}

/**
 * Normalizes a store-relative path for key based backends using the same rules `LocalDiskFileStore` enforces:
 * no NUL bytes, no absolute paths and no `..` segments (either slash flavor). Empty and `.` segments are dropped.
 */
export function normalizeStorePath( filePath: string ): string
{
    assertNoNul( filePath );

    if( filePath.startsWith( '/' ) || filePath.startsWith( '\\' ) || /^[A-Za-z]:[\\/]/.test( filePath ) )
    {
        throw new PathEscapeError( filePath, `Access denied: path '${filePath}' is absolute` );
    }

    const segments: string[] = [];

    for( const segment of filePath.split( /[\\/]/ ) )
    {
        if( segment === '..' )
        {
            throw new PathEscapeError( filePath, `Access denied: path '${filePath}' traverses outside root directory` );
        }

        if( segment !== '' && segment !== '.' )
        {
            segments.push( segment );
        }
    }

    if( segments.length === 0 )
    {
        throw new InvalidInputError( 'File path must not be empty' );
    }

    return segments.join( '/' );
}
