import { AIError } from '../core/error.js';
import type { 
    WorkflowNode, 
    StepHandler, 
    StepContext 
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
            type         : 'condition',
            predicate,
            ifTrue       : options.ifTrue,
            ifFalse      : options.ifFalse,
            dependencies : options.dependencies ?? [],
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
