import { CancelledError } from '../core/error.js';

export interface OrderedBatchOptions<T, R>
{
    /** Maximum number of `run` calls in flight. */
    limit    : number
    /** Aborting it fails the batch with `CancelledError` once the dispatcher notices. */
    signal   : AbortSignal
    /** Items for which this returns true run alone: nothing overlaps them. */
    barrier? : ( item: T ) => boolean
    /** Receives a signal that is aborted as soon as the batch fails, so siblings can stop early. */
    run      : ( item: T, index: number, signal: AbortSignal ) => Promise<R>
    /** Called once per item, strictly in item order, only for results whose whole prefix finished. */
    commit   : ( item: T, result: R, index: number ) => Promise<void>
}

/**
 * Runs `items` with bounded concurrency and commits their results in item order (never in
 * completion order). The first failure of `run` or `commit` aborts the siblings, stops all
 * further commits, waits for in-flight work to settle, and is then rethrown, so every
 * committed result is part of a contiguous prefix.
 */
export async function runOrdered<T, R>( items: T[], options: OrderedBatchOptions<T, R> ): Promise<void>
{
    if( !Number.isInteger( options.limit ) || options.limit < 1 )
    {
        throw new RangeError( `runOrdered limit must be an integer >= 1, got ${String( options.limit )}` );
    }

    const controller = new AbortController();
    const inflight = new Set<Promise<void>>();
    const finished = new Map<number, R>();
    let failure: { error: unknown } | undefined;
    let cursor = 0;
    let barrierRunning = false;
    let commitChain: Promise<void> = Promise.resolve();

    const fail = ( error: unknown ): void => 
    {
        failure ??= { error };
        controller.abort( error );
    };

    const link = () => {controller.abort( options.signal.reason );};

    if( options.signal.aborted )
    {
        link();
    }
    else
    {
        options.signal.addEventListener( 'abort', link, { once : true } );
    }

    const flush = (): void => 
    {
        commitChain = commitChain.then( async () => 
        {
            while( !failure && finished.has( cursor ) )
            {
                const index = cursor++;
                const result = finished.get( index ) as R;

                finished.delete( index );

                await options.commit( items[ index ] as T, result, index );
            }
        } ).catch( fail );
    };

    const start = ( index: number, isBarrier: boolean ): void => 
    {
        const task = ( async () => 
        {
            try
            {
                finished.set( index, await options.run( items[ index ] as T, index, controller.signal ) );
                flush();
            }
            catch( error )
            {
                fail( error );
            }
        } )();

        inflight.add( task );

        void task.then( () => 
        {
            inflight.delete( task );
            barrierRunning = isBarrier ? false : barrierRunning;
        } );
    };

    try
    {
        for( let i = 0; i < items.length; i++ )
        {
            const isBarrier = options.barrier?.( items[ i ] as T ) ?? false;

            while( !failure && !controller.signal.aborted && ( inflight.size >= options.limit || barrierRunning || ( isBarrier && inflight.size > 0 ) ) )
            {
                await Promise.race( inflight );
            }

            if( !failure && controller.signal.aborted )
            {
                fail( new CancelledError( 'Agent execution cancelled', controller.signal.reason ) );
            }

            if( failure )
            {
                break;
            }

            barrierRunning = isBarrier ? true : barrierRunning;
            start( i, isBarrier );
        }

        // Tasks never reject; they record their failure instead.
        await Promise.all( inflight );
        await commitChain;
    }
    finally
    {
        options.signal.removeEventListener( 'abort', link );
    }

    if( failure )
    {
        throw failure.error;
    }
}
