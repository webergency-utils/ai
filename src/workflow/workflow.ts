import { AIError } from '../core/error.js';
import type { 
    DecisionAnswers, 
    DecisionInput, 
    DecisionModel, 
    DecisionQuestions 
} from '../core/decision.js';
import { assertQuestion } from '../core/decision.js';
import type { 
    WorkflowNode, 
    StepHandler, 
    StepContext,
    DecisionNode
} from './nodes.js';

export interface StepOptions
{
    dependencies? : string[]
    retries?      : number
}

export interface WaitOptions
{
    prompt?       : string
    dependencies? : string[]
}

export interface ConditionOptions
{
    ifTrue        : string
    ifFalse       : string
    dependencies? : string[]
}

export interface RouteOptions
{
    branches      : Record<string, string>
    dependencies? : string[]
}

export interface DecisionStepOptions<Q extends DecisionQuestions, B extends Record<string, string>, TIn = unknown>
{
    /** Jev, a language-model decision adapter, or any other decision model. */
    model         : DecisionModel
    questions     : Q
    /** Input data for every question: a fixed value, or built from the upstream step output. */
    input         : DecisionInput | ( ( input: TIn, context: StepContext ) => DecisionInput | Promise<DecisionInput> )
    /** Declared branches: branch name to the id of the node that runs when it is chosen. */
    branches      : B
    /** Receives the typed answers and returns the name of a declared branch. */
    route         : ( answers: DecisionAnswers<Q>, context: StepContext ) => ( keyof B & string ) | Promise<keyof B & string>
    dependencies? : string[]
    /** Extra attempts after a failed decision call (default 0), spaced like step retries. */
    retries?      : number
    timeoutMs?    : number
}

export class Workflow
{
    public readonly name: string;
    readonly #nodes = new Map<string, WorkflowNode>();

    constructor( name: string )
    {
        this.name = name;
    }

    public step<TIn = unknown, TOut = unknown>( 
        id: string, 
        handler: StepHandler<TIn, TOut>, 
        options: StepOptions = {} 
    ): this
    {
        if( this.#nodes.has( id ) )
        {
            throw new AIError( `Node '${id}' is already defined in workflow '${this.name}'`, 'WORKFLOW_DUPLICATE_NODE' );
        }

        this.#nodes.set( id, {
            id,
            type         : 'step',
            handler      : handler as StepHandler<unknown, unknown>,
            retries      : options.retries ?? 0,
            dependencies : options.dependencies ?? []
        } );

        return this;
    }

    public wait( id: string, options: WaitOptions = {} ): this
    {
        if( this.#nodes.has( id ) )
        {
            throw new AIError( `Node '${id}' is already defined in workflow '${this.name}'`, 'WORKFLOW_DUPLICATE_NODE' );
        }

        this.#nodes.set( id, {
            id,
            type         : 'wait',
            prompt       : options.prompt ?? '',
            dependencies : options.dependencies ?? []
        } );

        return this;
    }

    public condition( 
        id: string, 
        predicate: ( context: StepContext ) => boolean | Promise<boolean>, 
        options: ConditionOptions 
    ): this
    {
        if( this.#nodes.has( id ) )
        {
            throw new AIError( `Node '${id}' is already defined in workflow '${this.name}'`, 'WORKFLOW_DUPLICATE_NODE' );
        }

        // Sugar over named-branch routing (KTD6).
        this.#nodes.set( id, {
            id,
            type          : 'condition',
            predicate,
            ifTrue        : options.ifTrue,
            ifFalse       : options.ifFalse,
            dependencies  : options.dependencies ?? [],
            branchTargets : [ options.ifTrue, options.ifFalse ]
        } );

        return this;
    }

    public route( 
        id: string, 
        choose: ( context: StepContext ) => string | Promise<string>, 
        options: RouteOptions 
    ): this
    {
        if( this.#nodes.has( id ) )
        {
            throw new AIError( `Node '${id}' is already defined in workflow '${this.name}'`, 'WORKFLOW_DUPLICATE_NODE' );
        }

        const targets = Object.values( options.branches );

        this.#nodes.set( id, {
            id,
            type          : 'route',
            choose,
            branches      : { ...options.branches },
            dependencies  : options.dependencies ?? [],
            branchTargets : targets
        } );

        return this;
    }

    /**
     * Decision step: one call to a decision model, then a typed routing function picks the
     * next branch. Only that branch runs; the others are skipped. The answers become the step
     * output and are saved in the checkpoint, so a resumed run never asks again.
     */
    public decision<Q extends DecisionQuestions, const B extends Record<string, string>, TIn = unknown>( 
        id: string, 
        options: DecisionStepOptions<Q, B, TIn> 
    ): this
    {
        if( this.#nodes.has( id ) )
        {
            throw new AIError( `Node '${id}' is already defined in workflow '${this.name}'`, 'WORKFLOW_DUPLICATE_NODE' );
        }

        const names = Object.keys( options.questions );

        if( names.length === 0 )
        {
            throw new AIError( `Decision '${id}' needs at least one question`, 'WORKFLOW_INVALID_DECISION' );
        }

        for( const name of names )
        {
            assertQuestion( name, options.questions[ name ] );
        }

        const branchNames = Object.keys( options.branches );

        if( branchNames.length === 0 )
        {
            throw new AIError( `Decision '${id}' needs at least one branch`, 'WORKFLOW_INVALID_DECISION' );
        }

        this.#nodes.set( id, {
            id,
            type          : 'decision',
            model         : options.model,
            questions     : options.questions,
            input         : options.input as DecisionNode['input'],
            route         : options.route as unknown as DecisionNode['route'],
            branches      : { ...options.branches },
            retries       : options.retries ?? 0,
            ...( options.timeoutMs !== undefined ? { timeoutMs : options.timeoutMs } : {} ),
            dependencies  : options.dependencies ?? [],
            branchTargets : Object.values( options.branches )
        } );

        return this;
    }

    public hasWaitNodes(): boolean
    {
        for( const node of this.#nodes.values() )
        {
            if( node.type === 'wait' )
            {
                return true;
            }
        }

        return false;
    }

    public getNode( id: string ): WorkflowNode | undefined
    {
        return this.#nodes.get( id );
    }

    public getNodes(): Map<string, WorkflowNode>
    {
        return new Map( this.#nodes );
    }

    public topologicalSort(): string[]
    {
        const inDegree = new Map<string, number>();
        const adj = new Map<string, string[]>();

        for( const id of this.#nodes.keys() )
        {
            inDegree.set( id, 0 );
            adj.set( id, [] );
        }

        const addEdge = ( from: string, to: string ): void => 
        {
            if( !this.#nodes.has( from ) )
            {
                throw new AIError( 
                    `Node '${to}' depends on undefined node '${from}'`, 
                    'WORKFLOW_INVALID_DEPENDENCY' 
                );
            }

            adj.get( from )!.push( to );
            inDegree.set( to, ( inDegree.get( to ) ?? 0 ) + 1 );
        };

        for( const node of this.#nodes.values() )
        {
            for( const dep of node.dependencies )
            {
                addEdge( dep, node.id );
            }

            // Implicit ordering edges from routers to branch targets (R20).
            if( node.branchTargets )
            {
                for( const target of node.branchTargets )
                {
                    if( !this.#nodes.has( target ) )
                    {
                        throw new AIError( 
                            `Node '${node.id}' routes to undefined node '${target}'`, 
                            'WORKFLOW_INVALID_DEPENDENCY' 
                        );
                    }

                    const targetNode = this.#nodes.get( target )!;

                    // Avoid double-counting when the branch target already lists the router as a dep.
                    if( !targetNode.dependencies.includes( node.id ) )
                    {
                        addEdge( node.id, target );
                    }
                }
            }
        }

        const queue: string[] = [];

        for( const [ id, deg ] of inDegree.entries() )
        {
            if( deg === 0 )
            {
                queue.push( id );
            }
        }

        const order: string[] = [];

        while( queue.length > 0 )
        {
            const curr = queue.shift()!;
            order.push( curr );

            for( const neighbor of ( adj.get( curr ) ?? [] ) )
            {
                const newDeg = ( inDegree.get( neighbor ) ?? 0 ) - 1;
                inDegree.set( neighbor, newDeg );

                if( newDeg === 0 )
                {
                    queue.push( neighbor );
                }
            }
        }

        if( order.length !== this.#nodes.size )
        {
            throw new AIError( 
                `Cycle detected in workflow '${this.name}' DAG`, 
                'WORKFLOW_CYCLE_ERROR' 
            );
        }

        return order;
    }
}
