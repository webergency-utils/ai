import { describe } from 'vitest';

export interface ContractHandle<T>
{
    store        : T
    dispose?     : () => Promise<void>
    /** Moves time forward for TTL checks; defaults to a real sleep when omitted. */
    advanceTime? : ( ms: number ) => Promise<void>
}

export type ContractFactory<T> = () => Promise<ContractHandle<T>> | ContractHandle<T>;

export interface ContractOptions
{
    /** When truthy the whole suite is reported as skipped (never as passed). */
    skip? : boolean
}

/** `describe` that registers as skipped when `options.skip` is set. */
export function contractSuite( name: string, options: ContractOptions | undefined, body: () => void ): void
{
    describe.skipIf( options?.skip === true )( name, body );
}

let counter = 0;

/** Unique, identifier-safe name used to isolate test data / tables between tests. */
export function uniqueName( prefix: string = 't' ): string
{
    counter++;

    return `${prefix}_${Date.now().toString( 36 )}_${counter}_${Math.floor( Math.random() * 1e6 ).toString( 36 )}`;
}

export function sleep( ms: number ): Promise<void>
{
    return new Promise( ( resolve ) => {setTimeout( resolve, ms );} );
}
