import { AIError } from '../core/error.js';
import type { DecisionResponse } from '../core/decision.js';
import type { ExecutionContext } from '../agent/context.js';
import { decideWithContext } from '../agent/decision.js';
import type { SpendTracker } from '../spend/tracker.js';
import { createMeteredDecisionModel } from '../providers/metered.js';
import type { IDocumentStore } from '../storage/document.js';
import type { Workflow } from './workflow.js';
import type { 
    StepContext, 
    StepNode, 
    ConditionNode, 
    RouteNode,
    DecisionNode,
    WorkflowNode
} from './nodes.js';
import { WorkflowEventEmitter, type WorkflowEvent, type WorkflowEventListener } from './events.js';

export type WorkflowRunStatus = 
    | 'running' 
    | 'completed' 
    | 'suspended' 
    | 'failed'
    | 'claiming';

export interface WorkflowRunResult
{
    runId               : string
    status              : WorkflowRunStatus
    outputs             : Record<string, unknown>
    state               : Record<string, unknown>
    suspendedAtStepId?  : string
    suspendedWaitIds?   : string[]
    skippedSteps?       : string[]
    error?              : Error | SerializedWorkflowError
}

export interface SerializedWorkflowError
{
    name    : string
    message : string
    stack?  : string
}

export interface WorkflowResumeOptions
{
    waitId    : string
    data      : unknown
    /** Force claim takeover after a crashed resume left status `claiming`. */
    takeover? : boolean
    owner?    : string
}

export interface WorkflowRunnerOptions
{
    checkpointStore? : IDocumentStore
    collection?      : string
    /** Decision steps run inside a `model` span of this context, so they appear in traces. */
    context?         : ExecutionContext
    /** Meters decision-step spend (Jev: input tokens only). */
    tracker?         : SpendTracker
}

interface PendingWait
{
    id     : string
    prompt : string
}

interface ClaimInfo
{
    owner     : string
    claimedAt : number
}

interface SavedWorkflowState
{
    runId             : string
    status            : WorkflowRunStatus
    inputs            : Record<string, unknown>
    outputs           : Record<string, unknown>
    state             : Record<string, unknown>
    completedSteps    : string[]
    skippedSteps      : string[]
    suspendedAtStepId : string
    pendingWaits      : PendingWait[]
    claim?            : ClaimInfo
    error?            : SerializedWorkflowError
    timestamp         : number
    version?          : number
}

function sleep( ms: number, signal?: AbortSignal ): Promise<void>
{
    if( ms <= 0 )
    {
        return Promise.resolve();
    }

    return new Promise( ( resolve, reject ) => 
    {
        if( signal?.aborted )
        {
            reject( signal.reason ?? new AIError( 'Aborted', 'WORKFLOW_ABORTED' ) );

            return;
        }

        const timer = setTimeout( () => 
        {
            signal?.removeEventListener( 'abort', onAbort );
            resolve();
        }, ms );

        const onAbort = (): void => 
        {
            clearTimeout( timer );
            reject( signal?.reason ?? new AIError( 'Aborted', 'WORKFLOW_ABORTED' ) );
        };

        signal?.addEventListener( 'abort', onAbort, { once : true } );
    } );
}

function serializeError( err: unknown ): SerializedWorkflowError
{
    if( err instanceof Error )
    {
        return { name : err.name, message : err.message, stack : err.stack };
    }

    return { name : 'Error', message : String( err ) };
}

export class WorkflowRunner
{
    readonly #workflow: Workflow;
    readonly #checkpointStore?: IDocumentStore;
    readonly #collection: string;
    readonly #context?: ExecutionContext;
    readonly #tracker?: SpendTracker;
    readonly #events = new WorkflowEventEmitter();

    constructor( workflow: Workflow, options: WorkflowRunnerOptions = {} )
    {
        this.#workflow = workflow;
        this.#checkpointStore = options.checkpointStore;
        this.#collection = options.collection ?? 'workflow_checkpoints';
        this.#context = options.context;
        this.#tracker = options.tracker;
    }

    public on( eventType: Parameters<WorkflowEventEmitter['on']>[0], listener: WorkflowEventListener ): void
    {
        this.#events.on( eventType, listener );
    }

    public async execute( 
        initialInput: Record<string, unknown> = {}, 
        runId?: string 
    ): Promise<WorkflowRunResult>
    {
        if( this.#workflow.hasWaitNodes() && !this.#checkpointStore )
        {
            throw new AIError( 
                'Workflow contains wait steps but no checkpointStore was configured', 
                'WORKFLOW_WAIT_REQUIRES_STORE' 
            );
        }

        const effectiveRunId = runId ?? `run_${Date.now()}_${Math.random().toString( 36 ).slice( 2, 7 )}`;
        const stepOutputs: Record<string, unknown> = {};
        const state: Record<string, unknown> = {};
        const completedSteps = new Set<string>();
        const skippedSteps = new Set<string>();

        this.emit( 'workflow_start', effectiveRunId );

        return this.runExecutionLoop( 
            effectiveRunId, 
            initialInput, 
            stepOutputs, 
            state, 
            completedSteps,
            skippedSteps
        );
    }

    public async resume( 
        runId: string, 
        signalOrOptions: unknown | WorkflowResumeOptions 
    ): Promise<WorkflowRunResult>
    {
        if( !this.#checkpointStore )
        {
            throw new AIError( 
                'Cannot resume workflow without a configured checkpointStore', 
                'WORKFLOW_NO_CHECKPOINT_STORE' 
            );
        }

        const options: WorkflowResumeOptions = this.#normalizeResumeOptions( signalOrOptions );
        const owner = options.owner ?? `owner_${Date.now()}_${Math.random().toString( 36 ).slice( 2, 7 )}`;

        const meta = await this.#checkpointStore.getWithMeta<SavedWorkflowState>( this.#collection, runId );

        if( !meta )
        {
            throw new AIError( 
                `No suspended workflow run found for ID '${runId}'`, 
                'WORKFLOW_RESUME_NOT_FOUND' 
            );
        }

        const saved = meta.doc;

        if( saved.status === 'claiming' )
        {
            if( !options.takeover )
            {
                throw new AIError( 
                    `Workflow run '${runId}' is claimed and requires takeover`, 
                    'WORKFLOW_RESUME_CLAIMED' 
                );
            }
        }
        else if( saved.status !== 'suspended' )
        {
            throw new AIError( 
                `No suspended workflow run found for ID '${runId}'`, 
                'WORKFLOW_RESUME_NOT_FOUND' 
            );
        }

        const pending = saved.pendingWaits ?? [];
        const waitId = options.waitId || saved.suspendedAtStepId;

        if( !pending.some( ( w ) => {return w.id === waitId;} ) && waitId !== saved.suspendedAtStepId )
        {
            throw new AIError( 
                `Wait '${waitId}' is not pending on run '${runId}'`, 
                'WORKFLOW_WAIT_NOT_PENDING' 
            );
        }

        const claim: ClaimInfo = { owner, claimedAt : Date.now() };
        const claimedDoc: SavedWorkflowState = {
            ...saved,
            status : 'claiming',
            claim
        };

        const cas = await this.#checkpointStore.conditionalWrite( 
            this.#collection, 
            runId, 
            claimedDoc as unknown as Record<string, unknown>, 
            { expectedVersion : meta.version } 
        );

        if( !cas.written )
        {
            throw new AIError( 
                `Concurrent resume rejected for run '${runId}'`, 
                'WORKFLOW_RESUME_CONFLICT' 
            );
        }

        const stepOutputs = { ...saved.outputs };
        const state = { ...saved.state };
        const completedSteps = new Set<string>( saved.completedSteps );
        const skippedSteps = new Set<string>( saved.skippedSteps ?? [] );

        stepOutputs[waitId] = options.data;
        completedSteps.add( waitId );

        const remainingWaits = pending.filter( ( w ) => {return w.id !== waitId;} );

        this.emit( 'workflow_resumed', runId, waitId, options.data );

        if( remainingWaits.length > 0 )
        {
            await this.#persist( {
                runId,
                status            : 'suspended',
                inputs            : saved.inputs,
                outputs           : stepOutputs,
                state,
                completedSteps    : Array.from( completedSteps ),
                skippedSteps      : Array.from( skippedSteps ),
                suspendedAtStepId : remainingWaits[0].id,
                pendingWaits      : remainingWaits,
                timestamp         : Date.now()
            } );

            return {
                runId,
                status            : 'suspended',
                outputs           : stepOutputs,
                state,
                suspendedAtStepId : remainingWaits[0].id,
                suspendedWaitIds  : remainingWaits.map( ( w ) => {return w.id;} ),
                skippedSteps      : Array.from( skippedSteps )
            };
        }

        return this.runExecutionLoop( 
            runId, 
            saved.inputs, 
            stepOutputs, 
            state, 
            completedSteps,
            skippedSteps
        );
    }

    #normalizeResumeOptions( signalOrOptions: unknown ): WorkflowResumeOptions
    {
        if( 
            signalOrOptions 
            && typeof signalOrOptions === 'object' 
            && 'waitId' in ( signalOrOptions as object ) 
            && 'data' in ( signalOrOptions as object ) 
        )
        {
            return signalOrOptions as WorkflowResumeOptions;
        }

        // Legacy: resume(runId, signalData) — wait id filled from checkpoint.
        return { waitId : '', data : signalOrOptions };
    }

    private async runExecutionLoop(
        runId: string,
        inputs: Record<string, unknown>,
        stepOutputs: Record<string, unknown>,
        state: Record<string, unknown>,
        completedSteps: Set<string>,
        skippedSteps: Set<string>
    ): Promise<WorkflowRunResult>
    {
        const abortByFailure = new AbortController();
        let firstError: unknown;

        try
        {
            while( true )
            {
                if( abortByFailure.signal.aborted )
                {
                    break;
                }

                this.#cascadeSkips( completedSteps, skippedSteps );

                const ready = this.#readySteps( completedSteps, skippedSteps );

                if( ready.length === 0 )
                {
                    break;
                }

                const waits = ready.filter( ( id ) => {return this.#workflow.getNode( id )?.type === 'wait';} );
                const actionable = ready.filter( ( id ) => {return this.#workflow.getNode( id )?.type !== 'wait';} );

                // Run non-wait ready steps in parallel (R18).
                if( actionable.length > 0 )
                {
                    const results = await Promise.all( actionable.map( ( stepId ) => 
                    {
                        return this.#executeNode( 
                            stepId, 
                            runId, 
                            inputs, 
                            stepOutputs, 
                            state, 
                            completedSteps, 
                            skippedSteps, 
                            abortByFailure.signal 
                        );
                    } ) );

                    for( const result of results )
                    {
                        if( result.kind === 'failed' )
                        {
                            firstError = result.error;
                            abortByFailure.abort( result.error );
                        }
                    }

                    if( firstError )
                    {
                        break;
                    }

                    await this.#checkpointProgress( runId, inputs, stepOutputs, state, completedSteps, skippedSteps );
                    continue;
                }

                // All remaining ready nodes are waits — suspend with every wait reached (R53).
                if( waits.length > 0 )
                {
                    const pendingWaits: PendingWait[] = waits.map( ( id ) => 
                    {
                        const node = this.#workflow.getNode( id )!;

                        return {
                            id,
                            prompt : node.type === 'wait' ? node.prompt : ''
                        };
                    } );

                    await this.#persist( {
                        runId,
                        status            : 'suspended',
                        inputs,
                        outputs           : stepOutputs,
                        state,
                        completedSteps    : Array.from( completedSteps ),
                        skippedSteps      : Array.from( skippedSteps ),
                        suspendedAtStepId : pendingWaits[0].id,
                        pendingWaits,
                        timestamp         : Date.now()
                    } );

                    this.emit( 'workflow_suspended', runId, pendingWaits[0].id );

                    return {
                        runId,
                        status            : 'suspended',
                        outputs           : stepOutputs,
                        state,
                        suspendedAtStepId : pendingWaits[0].id,
                        suspendedWaitIds  : pendingWaits.map( ( w ) => {return w.id;} ),
                        skippedSteps      : Array.from( skippedSteps )
                    };
                }
            }
        }
        catch( err )
        {
            firstError = err;
        }

        if( firstError )
        {
            const serialized = serializeError( firstError );

            await this.#persist( {
                runId,
                status            : 'failed',
                inputs,
                outputs           : stepOutputs,
                state,
                completedSteps    : Array.from( completedSteps ),
                skippedSteps      : Array.from( skippedSteps ),
                suspendedAtStepId : '',
                pendingWaits      : [],
                error             : serialized,
                timestamp         : Date.now()
            } );

            this.emit( 'step_failed', runId, undefined, firstError );

            return {
                runId,
                status       : 'failed',
                outputs      : stepOutputs,
                state,
                skippedSteps : Array.from( skippedSteps ),
                error        : firstError instanceof Error ? firstError : new Error( serialized.message )
            };
        }

        this.emit( 'workflow_complete', runId, undefined, stepOutputs );

        await this.#persist( {
            runId,
            status            : 'completed',
            inputs,
            outputs           : stepOutputs,
            state,
            completedSteps    : Array.from( completedSteps ),
            skippedSteps      : Array.from( skippedSteps ),
            suspendedAtStepId : '',
            pendingWaits      : [],
            timestamp         : Date.now()
        } );

        return {
            runId,
            status       : 'completed',
            outputs      : stepOutputs,
            state,
            skippedSteps : Array.from( skippedSteps )
        };
    }

    #readySteps( completed: Set<string>, skipped: Set<string> ): string[]
    {
        const ready: string[] = [];

        for( const [ id, node ] of this.#workflow.getNodes() )
        {
            if( completed.has( id ) || skipped.has( id ) )
            {
                continue;
            }

            if( this.#isReady( node, completed, skipped ) )
            {
                ready.push( id );
            }
        }

        return ready;
    }

    #isReady( node: WorkflowNode, completed: Set<string>, skipped: Set<string> ): boolean
    {
        const deps = node.dependencies;

        if( deps.length === 0 )
        {
            // Branch targets also need their router completed (implicit edge).
            if( this.#isBranchTarget( node.id ) )
            {
                const router = this.#findRouterFor( node.id );

                return router ? completed.has( router ) || skipped.has( router ) : true;
            }

            return true;
        }

        let anyCompleted = false;

        for( const dep of deps )
        {
            if( !completed.has( dep ) && !skipped.has( dep ) )
            {
                return false;
            }

            if( completed.has( dep ) )
            {
                anyCompleted = true;
            }
        }

        // Join after branch: run when at least one dependency completed (session contract).
        return anyCompleted || deps.length === 0;
    }

    #isBranchTarget( stepId: string ): boolean
    {
        for( const node of this.#workflow.getNodes().values() )
        {
            if( node.branchTargets?.includes( stepId ) )
            {
                return true;
            }
        }

        return false;
    }

    #findRouterFor( stepId: string ): string | undefined
    {
        for( const node of this.#workflow.getNodes().values() )
        {
            if( node.branchTargets?.includes( stepId ) )
            {
                return node.id;
            }
        }

        return undefined;
    }

    #cascadeSkips( completed: Set<string>, skipped: Set<string> ): void
    {
        let changed = true;

        while( changed )
        {
            changed = false;

            for( const [ id, node ] of this.#workflow.getNodes() )
            {
                if( completed.has( id ) || skipped.has( id ) )
                {
                    continue;
                }

                if( node.dependencies.length === 0 )
                {
                    continue;
                }

                const allSkipped = node.dependencies.every( ( dep ) => {return skipped.has( dep );} );

                if( allSkipped )
                {
                    skipped.add( id );
                    changed = true;
                }
            }
        }
    }

    async #executeNode(
        stepId: string,
        runId: string,
        inputs: Record<string, unknown>,
        stepOutputs: Record<string, unknown>,
        state: Record<string, unknown>,
        completedSteps: Set<string>,
        skippedSteps: Set<string>,
        signal: AbortSignal
    ): Promise<{ kind: 'ok' } | { kind: 'failed', error: unknown }>
    {
        if( signal.aborted )
        {
            return { kind : 'failed', error : signal.reason ?? new AIError( 'Aborted', 'WORKFLOW_ABORTED' ) };
        }

        const node = this.#workflow.getNode( stepId )!;
        const context: StepContext = {
            runId,
            stepId,
            inputs,
            stepOutputs,
            state,
            signal
        };

        try
        {
            if( node.type === 'condition' )
            {
                const conditionNode = node as ConditionNode;
                const result = await conditionNode.predicate( context );
                const chosen = result ? conditionNode.ifTrue : conditionNode.ifFalse;
                const notChosen = result ? conditionNode.ifFalse : conditionNode.ifTrue;

                stepOutputs[stepId] = { outcome : result, nextStep : chosen, branch : result ? 'true' : 'false' };
                completedSteps.add( stepId );
                skippedSteps.add( notChosen );

                return { kind : 'ok' };
            }

            if( node.type === 'route' )
            {
                const routeNode = node as RouteNode;
                const branchName = await routeNode.choose( context );
                const chosen = routeNode.branches[branchName];

                if( !chosen )
                {
                    throw new AIError( 
                        `Route '${stepId}' chose unknown branch '${branchName}'`, 
                        'WORKFLOW_UNKNOWN_BRANCH' 
                    );
                }

                stepOutputs[stepId] = { branch : branchName, nextStep : chosen };
                completedSteps.add( stepId );

                for( const [ name, target ] of Object.entries( routeNode.branches ) )
                {
                    if( name !== branchName )
                    {
                        skippedSteps.add( target );
                    }
                }

                return { kind : 'ok' };
            }

            if( node.type === 'decision' )
            {
                return await this.#executeDecision( 
                    node as DecisionNode, 
                    context, 
                    inputs, 
                    stepOutputs, 
                    completedSteps, 
                    skippedSteps, 
                    signal 
                );
            }

            if( node.type === 'step' )
            {
                const stepNode = node as StepNode;
                this.emit( 'step_start', runId, stepId );

                const maxAttempts = ( stepNode.retries ?? 0 ) + 1;
                let lastError: unknown;

                for( let attempt = 1; attempt <= maxAttempts; attempt++ )
                {
                    if( signal.aborted )
                    {
                        throw signal.reason ?? new AIError( 'Aborted', 'WORKFLOW_ABORTED' );
                    }

                    try
                    {
                        const inputForStep = this.#resolveStepInput( node, inputs, stepOutputs, completedSteps );
                        const output = await stepNode.handler( inputForStep, context );
                        stepOutputs[stepId] = output;
                        completedSteps.add( stepId );
                        this.emit( 'step_complete', runId, stepId, output );

                        return { kind : 'ok' };
                    }
                    catch( err )
                    {
                        lastError = err;

                        if( attempt < maxAttempts )
                        {
                            const delayMs = Math.min( 0.5 * ( 2 ** ( attempt - 1 ) ), 8 ) * 1000;
                            await sleep( delayMs, signal );
                        }
                    }
                }

                this.emit( 'step_failed', runId, stepId, lastError );

                return { kind : 'failed', error : lastError };
            }

            return { kind : 'ok' };
        }
        catch( err )
        {
            return { kind : 'failed', error : err };
        }
    }

    /**
     * Decision step (R16-R20): one call to the decision model, then the routing function picks
     * a declared branch. A failed call follows the step retry policy and never tries another model.
     */
    async #executeDecision(
        node: DecisionNode,
        context: StepContext,
        inputs: Record<string, unknown>,
        stepOutputs: Record<string, unknown>,
        completedSteps: Set<string>,
        skippedSteps: Set<string>,
        signal: AbortSignal
    ): Promise<{ kind: 'ok' } | { kind: 'failed', error: unknown }>
    {
        const { runId, stepId } = context;

        this.emit( 'step_start', runId, stepId );

        const maxAttempts = node.retries + 1;
        let response: DecisionResponse | undefined;
        let lastError: unknown;

        for( let attempt = 1; attempt <= maxAttempts && !response; attempt++ )
        {
            if( signal.aborted )
            {
                lastError = signal.reason ?? new AIError( 'Aborted', 'WORKFLOW_ABORTED' );
                break;
            }

            try
            {
                const upstream = this.#resolveStepInput( node, inputs, stepOutputs, completedSteps );
                const data = typeof node.input === 'function' ? await node.input( upstream, context ) : node.input;

                response = await this.#callDecision( node, data, signal );
            }
            catch( err )
            {
                lastError = err;

                if( attempt < maxAttempts )
                {
                    try
                    {
                        await sleep( Math.min( 0.5 * ( 2 ** ( attempt - 1 ) ), 8 ) * 1000, signal );
                    }
                    catch( abortError )
                    {
                        lastError = abortError;
                        break;
                    }
                }
            }
        }

        if( !response )
        {
            this.emit( 'step_failed', runId, stepId, lastError );

            return { kind : 'failed', error : lastError };
        }

        try
        {
            const branchName = await node.route( response.answers as never, context );

            if( typeof branchName !== 'string' || !Object.prototype.hasOwnProperty.call( node.branches, branchName ) )
            {
                throw new AIError( 
                    `Decision '${stepId}' routed to undeclared branch '${String( branchName )}'`, 
                    'WORKFLOW_UNKNOWN_BRANCH',
                    { declared : Object.keys( node.branches ) } 
                );
            }

            const chosen = node.branches[ branchName ];

            stepOutputs[ stepId ] = 
                {
                    answers    : response.answers,
                    calibrated : response.calibrated,
                    model      : response.model,
                    branch     : branchName,
                    nextStep   : chosen
                };
            completedSteps.add( stepId );

            for( const target of Object.values( node.branches ) )
            {
                if( target !== chosen )
                {
                    skippedSteps.add( target );
                }
            }

            this.emit( 'step_complete', runId, stepId, stepOutputs[ stepId ] );

            return { kind : 'ok' };
        }
        catch( err )
        {
            this.emit( 'step_failed', runId, stepId, err );

            return { kind : 'failed', error : err };
        }
    }

    async #callDecision( node: DecisionNode, input: Parameters<DecisionNode['model']['decide']>[0]['input'], signal: AbortSignal ): Promise<DecisionResponse>
    {
        const request = 
            {
                input,
                questions : node.questions,
                signal,
                // The workflow retry policy governs retries; stacking transport retries would multiply attempts.
                retry     : false as const,
                ...( node.timeoutMs !== undefined ? { timeoutMs : node.timeoutMs } : {} )
            };

        if( this.#context )
        {
            return decideWithContext( this.#context, node.model, request, { 
                tracker    : this.#tracker, 
                name       : `workflow:decision:${node.id}`,
                attributes : { 'workflow.stepId' : node.id } 
            } );
        }

        const model = this.#tracker 
            ? createMeteredDecisionModel( node.model, { tracker : this.#tracker } ) 
            : node.model;

        return model.decide( request );
    }

    #resolveStepInput( 
        node: WorkflowNode, 
        inputs: Record<string, unknown>, 
        stepOutputs: Record<string, unknown>,
        completedSteps: Set<string>
    ): unknown
    {
        const deps = node.dependencies;

        if( deps.length === 0 )
        {
            return inputs;
        }

        if( deps.length === 1 )
        {
            return stepOutputs[deps[0]];
        }

        // Multi-dep join: map of completed dependency outputs only (R20).
        const map: Record<string, unknown> = {};

        for( const dep of deps )
        {
            if( completedSteps.has( dep ) )
            {
                map[dep] = stepOutputs[dep];
            }
        }

        return map;
    }

    async #checkpointProgress( 
        runId: string, 
        inputs: Record<string, unknown>, 
        stepOutputs: Record<string, unknown>, 
        state: Record<string, unknown>, 
        completedSteps: Set<string>, 
        skippedSteps: Set<string> 
    ): Promise<void>
    {
        await this.#persist( {
            runId,
            status            : 'running',
            inputs,
            outputs           : stepOutputs,
            state,
            completedSteps    : Array.from( completedSteps ),
            skippedSteps      : Array.from( skippedSteps ),
            suspendedAtStepId : '',
            pendingWaits      : [],
            timestamp         : Date.now()
        } );
    }

    async #persist( saved: SavedWorkflowState ): Promise<void>
    {
        if( !this.#checkpointStore )
        {
            return;
        }

        await this.#checkpointStore.set( 
            this.#collection, 
            saved.runId, 
            saved as unknown as Record<string, unknown> 
        );
    }

    private emit( type: WorkflowEvent['type'], runId: string, stepId?: string, payload?: unknown ): void
    {
        this.#events.emit( {
            type,
            runId,
            stepId,
            payload,
            timestamp : Date.now()
        } );
    }
}
