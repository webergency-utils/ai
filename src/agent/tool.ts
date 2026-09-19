import type { z } from 'zod';
import type { ToolDefinition } from '../core/types.js';
import { InvalidInputError } from '../core/error.js';
import type { ExecutionContext } from './context.js';

export type ToolExecutor<TArgs = Record<string, unknown>, TResult = unknown> = 
    ( args: TArgs, context?: ExecutionContext ) => Promise<TResult>;

export interface ToolConfig<TArgs = Record<string, unknown>, TResult = unknown>
{
    name        : string
    description : string
    parameters  : z.ZodType<TArgs> | Record<string, unknown>
    execute     : ToolExecutor<TArgs, TResult>
}

export class Tool<TArgs = Record<string, unknown>, TResult = unknown>
{
    public readonly name        : string;
    public readonly description : string;
    public readonly parameters  : z.ZodType<TArgs> | Record<string, unknown>;
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

        if( this.isZodSchema( this.parameters ) )
        {
            const parsed = this.parameters.safeParse( rawArgs );

            if( !parsed.success )
            {
                throw new InvalidInputError( 
                    `Invalid arguments for tool '${this.name}': ${parsed.error.message}`, 
                    parsed.error 
                );
            }

            validArgs = parsed.data;
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

    private isZodSchema( schema: unknown ): schema is z.ZodType<TArgs>
    {
        return typeof schema === 'object' && schema !== null && 'safeParse' in schema;
    }
}

export function createTool<TArgs = Record<string, unknown>, TResult = unknown>( 
    config: ToolConfig<TArgs, TResult> 
): Tool<TArgs, TResult>
{
    return new Tool<TArgs, TResult>( config );
}
