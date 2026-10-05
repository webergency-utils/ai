import type { DecisionInput, DecisionModel, DecisionQuestions } from '../core/decision.js';

export interface StepContext
{
    runId       : string
    stepId      : string
    inputs      : Record<string, unknown>
    stepOutputs : Record<string, unknown>
    state       : Record<string, unknown>
    signal?     : AbortSignal
}

export type StepHandler<TIn = unknown, TOut = unknown> = 
    ( input: TIn, context: StepContext ) => Promise<TOut>;

export type NodeType = 'step' | 'wait' | 'condition' | 'route' | 'decision';

export interface BaseNode
{
    id           : string
    type         : NodeType
    dependencies : string[]
    /** Branch targets reached only via routing (ordering / skip), not data deps (R20). */
    branchTargets? : string[]
}

export interface StepNode extends BaseNode
{
    type    : 'step'
    handler : StepHandler<unknown, unknown>
    retries : number
}

export interface WaitNode extends BaseNode
{
    type   : 'wait'
    prompt : string
}

export interface ConditionNode extends BaseNode
{
    type      : 'condition'
    predicate : ( context: StepContext ) => boolean | Promise<boolean>
    ifTrue    : string
    ifFalse   : string
}

export interface RouteNode extends BaseNode
{
    type     : 'route'
    choose   : ( context: StepContext ) => string | Promise<string>
    branches : Record<string, string>
}

/**
 * Asks one decision model several questions in a single call, then routes to exactly one
 * named branch. Types are erased here; {@link Workflow.decision} keeps them at the call site.
 */
export interface DecisionNode extends BaseNode
{
    type      : 'decision'
    model     : DecisionModel
    questions : DecisionQuestions
    input     : DecisionInput | ( ( input: unknown, context: StepContext ) => DecisionInput | Promise<DecisionInput> )
    route     : ( answers: never, context: StepContext ) => string | Promise<string>
    /** Branch name to target node id. */
    branches  : Record<string, string>
    /** Re-asks on failure; the workflow retry policy governs, so transport retries are off. */
    retries   : number
    timeoutMs? : number
}

export type WorkflowNode = StepNode | WaitNode | ConditionNode | RouteNode | DecisionNode;
