import type { z } from 'zod';

interface ZodDefLike
{
    typeName?: string
    description?: string
    values?: string[] | Record<string, string>
    value?: unknown
    type?: z.ZodTypeAny
    innerType?: z.ZodTypeAny
    valueType?: z.ZodTypeAny
    options?: z.ZodTypeAny[]
    shape?: () => Record<string, z.ZodTypeAny>
}

interface ZodLike
{
    _def?: ZodDefLike
}

export function zodToJsonSchema( schema?: z.ZodTypeAny | Record<string, unknown> ): Record<string, unknown>
{
    if( !schema )
    {
        return { type : 'object', properties : {} };
    }

    if( !( '_def' in schema ) )
    {
        return schema as Record<string, unknown>;
    }

    return parseZodType( schema as z.ZodTypeAny );
}

function parseZodType( schema: z.ZodTypeAny ): Record<string, unknown>
{
    const def = ( schema as unknown as ZodLike )._def;

    if( !def )
    {
        return {};
    }

    const typeName = def.typeName;
    const result: Record<string, unknown> = {};

    if( def.description )
    {
        result.description = def.description;
    }

    switch ( typeName )
    {
        case 'ZodString':
            result.type = 'string';
            break;

        case 'ZodNumber':
            result.type = 'number';
            break;

        case 'ZodBoolean':
            result.type = 'boolean';
            break;

        case 'ZodNull':
            result.type = 'null';
            break;

        case 'ZodArray':
            result.type = 'array';
            result.items = def.type ? parseZodType( def.type ) : {};
            break;

        case 'ZodObject':
        {
            result.type = 'object';
            const shape = def.shape ? def.shape() : {};
            const properties: Record<string, unknown> = {};
            const required: string[] = [];

            for( const [ key, childSchema ] of Object.entries( shape ) )
            {
                const childDef = ( childSchema as unknown as ZodLike )._def;
                properties[key] = parseZodType( childSchema );

                const isOptional = childDef?.typeName === 'ZodOptional' || childDef?.typeName === 'ZodDefault';

                if( !isOptional )
                {
                    required.push( key );
                }
            }

            result.properties = properties;

            if( required.length > 0 )
            {
                result.required = required;
            }
            break;
        }

        case 'ZodEnum':
            result.type = 'string';
            result.enum = Array.isArray( def.values ) ? def.values : [];
            break;

        case 'ZodNativeEnum':
            result.type = 'string';
            result.enum = def.values && typeof def.values === 'object' 
                ? Object.values( def.values ) 
                : [];
            break;

        case 'ZodLiteral':
            result.const = def.value;
            break;

        case 'ZodOptional':
        case 'ZodNullable':
        case 'ZodDefault':
            return def.innerType ? parseZodType( def.innerType ) : {};

        case 'ZodUnion':
        case 'ZodDiscriminatedUnion':
            result.anyOf = ( def.options ?? [] ).map( ( opt ) => 
            {
                return parseZodType( opt );
            } );
            break;

        case 'ZodRecord':
            result.type = 'object';
            result.additionalProperties = def.valueType ? parseZodType( def.valueType ) : {};
            break;

        default:
            result.type = 'object';
            break;
    }

    return result;
}
