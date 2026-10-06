import { AIError } from '../core/error.js';

/** Wraps a driver or transport failure raised by a storage backend. */
export class StorageError extends AIError
{
    public readonly backend   : string;
    public readonly operation : string;
    public readonly cause?    : unknown;

    constructor( backend: string, operation: string, message: string, cause?: unknown, details?: unknown )
    {
        super( `[${backend}] ${operation} failed: ${message}`, 'STORAGE_ERROR', details );
        this.name = 'StorageError';
        this.backend = backend;
        this.operation = operation;
        this.cause = cause;
    }
}

/** Describes any thrown value as a short human readable string. */
export function describeError( err: unknown ): string
{
    if( err instanceof Error ){return err.message;}

    return String( err );
}

/** Wraps `err` in a `StorageError` unless it already is an `AIError` (invalid input, path escape, ...). */
export function wrapStorageError( backend: string, operation: string, err: unknown ): AIError
{
    if( err instanceof AIError ){return err;}

    return new StorageError( backend, operation, describeError( err ), err );
}

/** Detects primary key / unique constraint violations across Postgres, SQLite and LibSQL drivers. */
export function isUniqueViolation( err: unknown ): boolean
{
    if( typeof err !== 'object' || err === null ){return false;}

    const e = err as { code? : unknown, message? : unknown, errcode? : unknown };
    const code = typeof e.code === 'string' ? e.code : '';

    if( code === '23505' || code.startsWith( 'SQLITE_CONSTRAINT' ) ){return true;}
    if( e.errcode === 1555 || e.errcode === 2067 ){return true;}

    return typeof e.message === 'string' && /unique constraint|duplicate key|primary key constraint/i.test( e.message );
}
