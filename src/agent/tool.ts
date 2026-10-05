import type { JsonSchema } from '@webergency-utils/typechecker';
import { validateSchema } from '@webergency-utils/typechecker';
import type { ToolDefinition } from '../core/types.js';
import { InvalidInputError } from '../core/error.js';
import type { ExecutionContext } from './context.js';

export interface ToolRunOptions
{
    /** Cancellation signal of the surrounding agent run (derived when sibling tools run in parallel). */
    signal? : AbortSignal
}

export type ToolExecutor<TArgs = Record<string, unknown>, TResult = unknown> = 
    ( args: TArgs, context?: ExecutionContext, options?: ToolRunOptions ) => Promise<TResult>;

export interface ToolConfig<TArgs = Record<string, unknown>, TResult = unknown>
{
    name        : string
    description : string
    parameters  : JsonSchema | Record<string, unknown>
    execute     : ToolExecutor<TArgs, TResult>
    /**
     * Set to `false` for tools that must not overlap with any other tool call
     * when the agent runs with `toolConcurrency` greater than 1. Defaults to `true`.
     */
    parallelSafe? : boolean
}

export class Tool<TArgs = Record<string, unknown>, TResult = unknown>
{
    public readonly name        : string;
    public readonly description : string;
    public readonly parameters  : JsonSchema | Record<string, unknown>;
    public readonly parallelSafe : boolean;
    readonly #executor          : ToolExecutor<TArgs, TResult>;

    constructor( config: ToolConfig<TArgs, TResult> )
    {
        this.name = config.name;
        this.description = config.description;
        this.parameters = config.parameters;
        this.parallelSafe = config.parallelSafe ?? true;
        this.#executor = config.execute;
    }

    public async run( rawArgs: unknown, context?: ExecutionContext, options?: ToolRunOptions ): Promise<TResult>
    {
        let validArgs: TArgs;

        if( this.parameters && typeof this.parameters === 'object' && Object.keys( this.parameters ).length > 0 )
        {
            const validation = validateSchema<TArgs>( this.parameters as JsonSchema, rawArgs, 'strip' );

            if( !validation.success )
            {
                const errorMsg = validation.errors && validation.errors.length > 0
                    ? validation.errors.map( ( e ) => `${e.path || 'root'}: ${e.error}` ).join( ', ' )
                    : 'Validation failed';

                throw new InvalidInputError( 
                    `Invalid arguments for tool '${this.name}': ${errorMsg}`, 
                    validation.errors 
                );
            }

            validArgs = validation.data !== undefined ? validation.data : ( ( rawArgs ?? {} ) as TArgs );
        }
        else
        {
            validArgs = ( rawArgs ?? {} ) as TArgs;
        }

        return this.#executor( validArgs, context, options );
    }

    public toDefinition(): ToolDefinition
    {
        return {
            name        : this.name,
            description : this.description,
            parameters  : this.parameters
        };
    }
}

export function createTool<TArgs = Record<string, unknown>, TResult = unknown>( 
    config: ToolConfig<TArgs, TResult> 
): Tool<TArgs, TResult>
{
    return new Tool<TArgs, TResult>( config );
}
