import type { JsonSchema } from '@webergency-utils/typechecker';
export type { JsonSchema } from '@webergency-utils/typechecker';
export { validateSchema, assertSchema } from '@webergency-utils/typechecker';

export interface StringSchemaOptions
{
    description? : string
    minLength?   : number
    maxLength?   : number
    pattern?     : string
    enum?        : string[]
    default?     : string
}

export interface NumberSchemaOptions
{
    description? : string
    minimum?     : number
    maximum?     : number
    multipleOf?  : number
    default?     : number
}

export interface BooleanSchemaOptions
{
    description? : string
    default?     : boolean
}

export interface ArraySchemaOptions
{
    description? : string
    minItems?    : number
    maxItems?    : number
    uniqueItems? : boolean
}

export interface ObjectSchemaOptions
{
    description?          : string
    required?             : string[]
    additionalProperties? : boolean | JsonSchema
}

export interface EnumSchemaOptions
{
    description? : string
}

export const schema = 
    {
        string( options: StringSchemaOptions = {} ): JsonSchema
        {
            return {
                type : 'string',
                ...options
            };
        },

        number( options: NumberSchemaOptions = {} ): JsonSchema
        {
            return {
                type : 'number',
                ...options
            };
        },

        integer( options: NumberSchemaOptions = {} ): JsonSchema
        {
            return {
                type : 'integer',
                ...options
            };
        },

        boolean( options: BooleanSchemaOptions = {} ): JsonSchema
        {
            return {
                type : 'boolean',
                ...options
            };
        },

        array( items: JsonSchema, options: ArraySchemaOptions = {} ): JsonSchema
        {
            return {
                type : 'array',
                items,
                ...options
            };
        },

        enum( values: ( string | number )[], options: EnumSchemaOptions = {} ): JsonSchema
        {
            return {
                type : typeof values[ 0 ] === 'number' ? 'number' : 'string',
                enum : values,
                ...options
            };
        },

        object( 
            properties: Record<string, JsonSchema> = {}, 
            options: ObjectSchemaOptions = {} 
        ): JsonSchema
        {
            return {
                type     : 'object',
                properties,
                required : options.required ?? Object.keys( properties ),
                ...( options.description ? { description : options.description } : {} ),
                ...( options.additionalProperties !== undefined ? { additionalProperties : options.additionalProperties } : {} )
            };
        }
    };

export function toJsonSchema( schemaInput?: JsonSchema | Record<string, unknown> ): Record<string, unknown>
{
    if( !schemaInput || typeof schemaInput !== 'object' )
    {
        return { type : 'object', properties : {} };
    }

    const result = { ...( schemaInput as Record<string, unknown> ) };

    if( !result.type && !result.anyOf && !result.oneOf && !result.allOf )
    {
        result.type = 'object';
    }

    return result;
}

export const zodToJsonSchema = toJsonSchema;
