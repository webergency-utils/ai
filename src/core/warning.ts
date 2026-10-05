/**
 * Shared warning event shape for library components.
 * Each component emits through its own `on( 'warning' )` channel — there is no global bus.
 */
export interface WarningEvent
{
    code     : string
    message  : string
    details? : unknown
}

export type WarningListener = ( event: WarningEvent ) => void;

/**
 * Small subscribe/emit helper matching SpendTracker's unsubscribe-returning `on()`.
 */
export class WarningEmitter
{
    readonly #listeners = new Set<WarningListener>();

    public on( listener: WarningListener ): () => void
    {
        this.#listeners.add( listener );

        return () => this.off( listener );
    }

    public off( listener: WarningListener ): void
    {
        this.#listeners.delete( listener );
    }

    public emit( event: WarningEvent ): void
    {
        for( const listener of this.#listeners )
        {
            try
            {
                listener( event );
            }
            catch
            {
                // Listener failures must not break the emitter.
            }
        }
    }

    public get size(): number
    {
        return this.#listeners.size;
    }
}
