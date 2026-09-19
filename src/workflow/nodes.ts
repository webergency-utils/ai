export interface StepContext
{
    runId       : string
    stepId      : string
    inputs      : Record<string, unknown>
    stepOutputs : Record<string, unknown>
    state       : Record<string, unknown>
}

export type StepHandler<TIn = unknown, TOut = unknown> = 
    ( input: TIn, context: StepContext ) => Promise<TOut>;

export type NodeType = 'step' | 'wait' | 'condition';

export interface BaseNode
{
    id           : string
    type         : NodeType
    dependencies : string[]
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

export type WorkflowNode = StepNode | WaitNode | ConditionNode;
