import { AIError } from '../core/error.js';
import type { IDocumentStore } from '../storage/document.js';
import type { Workflow } from './workflow.js';
import type { StepContext, StepNode, ConditionNode } from './nodes.js';
import { WorkflowEventEmitter, type WorkflowEvent, type WorkflowEventListener } from './events.js';

export type WorkflowRunStatus = 'running' | 'completed' | 'suspended' | 'failed';

export interface WorkflowRunResult
{
    runId               : string
    status              : WorkflowRunStatus
    outputs             : Record<string, unknown>
    state               : Record<string, unknown>
    suspendedAtStepId?  : string
    error?              : Error
}

export interface WorkflowRunnerOptions
{
    checkpointStore? : IDocumentStore
    collection?      : string
}

interface SavedWorkflowState
{
    runId             : string
    status            : WorkflowRunStatus
    inputs            : Record<string, unknown>
    outputs           : Record<string, unknown>
    state             : Record<string, unknown>
    completedSteps    : string[]
    suspendedAtStepId : string
    timestamp         : number
}

export class WorkflowRunner
{
    readonly #workflow: Workflow;
    readonly #checkpointStore?: IDocumentStore;
    readonly #collection: string;
    readonly #events = new WorkflowEventEmitter();

    constructor( workflow: Workflow, options: WorkflowRunnerOptions = {} )
    {
        this.#workflow = workflow;
        this.#checkpointStore = options.checkpointStore;
        this.#collection = options.collection ?? 'workflow_checkpoints';
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
        const effectiveRunId = runId ?? `run_${Date.now()}_${Math.random().toString( 36 ).slice( 2, 7 )}`;
        const stepOutputs: Record<string, unknown> = {};
        const state: Record<string, unknown> = {};
        const completedSteps = new Set<string>();

        this.emit( 'workflow_start', effectiveRunId );

        return this.runExecutionLoop( 
            effectiveRunId, 
            initialInput, 
            stepOutputs, 
            state, 
            completedSteps 
        );
    }

    public async resume( runId: string, signalData: unknown ): Promise<WorkflowRunResult>
    {
        if( !this.#checkpointStore )
        {
            throw new AIError( 
                'Cannot resume workflow without a configured checkpointStore', 
                'WORKFLOW_NO_CHECKPOINT_STORE' 
            );
        }

        const saved = await this.#checkpointStore.get<SavedWorkflowState>( this.#collection, runId );

        if( !saved || saved.status !== 'suspended' )
        {
            throw new AIError( 
                `No suspended workflow run found for ID '${runId}'`, 
                'WORKFLOW_RESUME_NOT_FOUND' 
            );
        }

        const stepOutputs = saved.outputs;
        const state = saved.state;
        const completedSteps = new Set<string>( saved.completedSteps );

        // Inject external signal as output of the suspended WaitNode
        stepOutputs[saved.suspendedAtStepId] = signalData;
        completedSteps.add( saved.suspendedAtStepId );

        this.emit( 'workflow_resumed', runId, saved.suspendedAtStepId, signalData );

        return this.runExecutionLoop( 
            runId, 
            saved.inputs, 
            stepOutputs, 
            state, 
            completedSteps 
        );
    }

    private async runExecutionLoop(
        runId: string,
        inputs: Record<string, unknown>,
        stepOutputs: Record<string, unknown>,
        state: Record<string, unknown>,
        completedSteps: Set<string>
    ): Promise<WorkflowRunResult>
    {
        const executionOrder = this.#workflow.topologicalSort();

        for( const stepId of executionOrder )
        {
            if( completedSteps.has( stepId ) )
            {
                continue;
            }

            const node = this.#workflow.getNode( stepId )!;

            // Verify dependencies
            const canRun = node.dependencies.every( ( dep ) => {return completedSteps.has( dep );} );

            if( !canRun )
            {
                continue;
            }

            const context: StepContext = 
                {
                    runId,
                    stepId,
                    inputs,
                    stepOutputs,
                    state
                };

            if( node.type === 'wait' )
            {
                // Suspend execution and persist checkpoint
                if( this.#checkpointStore )
                {
                    const saved: SavedWorkflowState = 
                        {
                            runId,
                            status            : 'suspended',
                            inputs,
                            outputs           : stepOutputs,
                            state,
                            completedSteps    : Array.from( completedSteps ),
                            suspendedAtStepId : stepId,
                            timestamp         : Date.now()
                        };

                    await this.#checkpointStore.set( this.#collection, runId, saved as unknown as Record<string, unknown> );
                }

                this.emit( 'workflow_suspended', runId, stepId );

                return {
                    runId,
                    status            : 'suspended',
                    outputs           : stepOutputs,
                    state,
                    suspendedAtStepId : stepId
                };
            }

            if( node.type === 'condition' )
            {
                const conditionNode = node as ConditionNode;
                const result = await conditionNode.predicate( context );
                const nextStep = result ? conditionNode.ifTrue : conditionNode.ifFalse;

                stepOutputs[stepId] = { outcome : result, nextStep };
                completedSteps.add( stepId );
                continue;
            }

            if( node.type === 'step' )
            {
                const stepNode = node as StepNode;
                this.emit( 'step_start', runId, stepId );

                let stepError: unknown;
                let stepSuccess = false;
                let attempts = 0;
                const maxAttempts = ( stepNode.retries ?? 0 ) + 1;

                while( attempts < maxAttempts && !stepSuccess )
                {
                    attempts++;

                    try
                    {
                        const inputForStep = node.dependencies.length === 1 
                            ? stepOutputs[node.dependencies[0]] 
                            : inputs;

                        const output = await stepNode.handler( inputForStep, context );
                        stepOutputs[stepId] = output;
                        completedSteps.add( stepId );
                        stepSuccess = true;

                        this.emit( 'step_complete', runId, stepId, output );

                        if( this.#checkpointStore )
                        {
                            const checkpoint: SavedWorkflowState = 
                                {
                                    runId,
                                    status            : 'running',
                                    inputs,
                                    outputs           : stepOutputs,
                                    state,
                                    completedSteps    : Array.from( completedSteps ),
                                    suspendedAtStepId : '',
                                    timestamp         : Date.now()
                                };

                            await this.#checkpointStore.set( this.#collection, runId, checkpoint as unknown as Record<string, unknown> );
                        }
                    }
                    catch( err )
                    {
                        stepError = err;
                    }
                }

                if( !stepSuccess )
                {
                    this.emit( 'step_failed', runId, stepId, stepError );

                    const errObj = stepError instanceof Error ? stepError : new Error( String( stepError ) );

                    return {
                        runId,
                        status  : 'failed',
                        outputs : stepOutputs,
                        state,
                        error   : errObj
                    };
                }
            }
        }

        this.emit( 'workflow_complete', runId, undefined, stepOutputs );

        if( this.#checkpointStore )
        {
            const finalState: SavedWorkflowState = 
                {
                    runId,
                    status            : 'completed',
                    inputs,
                    outputs           : stepOutputs,
                    state,
                    completedSteps    : Array.from( completedSteps ),
                    suspendedAtStepId : '',
                    timestamp         : Date.now()
                };

            await this.#checkpointStore.set( this.#collection, runId, finalState as unknown as Record<string, unknown> );
        }

        return {
            runId,
            status  : 'completed',
            outputs : stepOutputs,
            state
        };
    }

    private emit( type: WorkflowEvent['type'], runId: string, stepId?: string, payload?: unknown ): void
    {
        this.#events.emit( 
            {
                type,
                runId,
                stepId,
                payload,
                timestamp : Date.now()
            } );
    }
}
