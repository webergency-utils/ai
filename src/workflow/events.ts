export type WorkflowEventType = 
    | 'workflow_start'
    | 'step_start'
    | 'step_complete'
    | 'step_failed'
    | 'workflow_suspended'
    | 'workflow_resumed'
    | 'workflow_complete';

export interface WorkflowEvent
{
    type      : WorkflowEventType
    runId     : string
    stepId?   : string
    payload?  : unknown
    timestamp : number
}

export type WorkflowEventListener = ( event: WorkflowEvent ) => void;

export class WorkflowEventEmitter
{
    readonly #listeners = new Map<WorkflowEventType | '*', Set<WorkflowEventListener>>();

    public on( eventType: WorkflowEventType | '*', listener: WorkflowEventListener ): void
    {
        let set = this.#listeners.get( eventType );

        if( !set )
        {
            set = new Set();
            this.#listeners.set( eventType, set );
        }

        set.add( listener );
    }

    public off( eventType: WorkflowEventType | '*', listener: WorkflowEventListener ): void
    {
        const set = this.#listeners.get( eventType );

        if( set )
        {
            set.delete( listener );
        }
    }

    public emit( event: WorkflowEvent ): void
    {
        const specific = this.#listeners.get( event.type );

        if( specific )
        {
            for( const fn of specific )
            {
                fn( event );
            }
        }

        const wildcards = this.#listeners.get( '*' );

        if( wildcards )
        {
            for( const fn of wildcards )
            {
                fn( event );
            }
        }
    }
}
