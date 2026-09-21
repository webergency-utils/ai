import type { JsonSchema } from '@webergency-utils/typechecker';
import { validateSchema } from '@webergency-utils/typechecker';
import type { ToolDefinition } from '../core/types.js';
import { InvalidInputError } from '../core/error.js';
import type { ExecutionContext } from './context.js';

export type ToolExecutor<TArgs = Record<string, unknown>, TResult = unknown> = 
    ( args: TArgs, context?: ExecutionContext ) => Promise<TResult>;

export interface ToolConfig<TArgs = Record<string, unknown>, TResult = unknown>
{
    name        : string
    description : string
    parameters  : JsonSchema | Record<string, unknown>
    execute     : ToolExecutor<TArgs, TResult>
}

export class Tool<TArgs = Record<string, unknown>, TResult = unknown>
{
    public readonly name        : string;
    public readonly description : string;
    public readonly parameters  : JsonSchema | Record<string, unknown>;
    readonly #executor          : ToolExecutor<TArgs, TResult>;

    constructor( config: ToolConfig<TArgs, TResult> )
    {
        this.name = config.name;
        this.description = config.description;
        this.parameters = config.parameters;
        this.#executor = config.execute;
    }

    public async run( rawArgs: unknown, context?: ExecutionContext ): Promise<TResult>
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

        return this.#executor( validArgs, context );
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
