import type { LanguageModel } from './protocol.js';
import type { ModelRequest, ModelResponse, OutputMode } from './types.js';
import { InvalidInputError, ProviderError } from './error.js';
import { toJsonSchema, validateSchema } from './schema.js';

const RAW_FRAGMENT_LIMIT = 200;

export function resolveOutputMode( request: Pick<ModelRequest, 'outputSchema' | 'outputMode'> ): OutputMode | undefined
{
    if( !request.outputSchema )
    {
        return undefined;
    }

    return request.outputMode ?? 'json_schema';
}

/**
 * Parses model text as JSON and validates it against `outputSchema`.
 * Malformed JSON is a provider defect (`ProviderError`); a schema mismatch is `InvalidInputError`.
 */
export function parseStructuredOutput( 
    provider: string, 
    text: string, 
    outputSchema: ModelRequest['outputSchema'] 
): unknown
{
    if( text.trim() === '' )
    {
        throw new ProviderError( provider, 'Structured output requested but the model returned no content', 502 );
    }

    let value: unknown;

    try
    {
        value = JSON.parse( text );
    }
    catch( error )
    {
        throw new ProviderError( 
            provider, 
            `Structured output is not valid JSON: ${text.length > RAW_FRAGMENT_LIMIT ? `${text.slice( 0, RAW_FRAGMENT_LIMIT )}…` : text}`, 
            502, 
            { raw : text, cause : error instanceof Error ? error.message : String( error ) } 
        );
    }

    const result = validateSchema( toJsonSchema( outputSchema ), value, 'relaxed' );

    if( !result.success )
    {
        const detail = ( result.errors ?? [] )
            .map( ( err ) => {return `${err.path || '(root)'}: ${err.error}`;} )
            .join( '; ' );

        throw new InvalidInputError( 
            `Structured output failed schema validation: ${detail}`, 
            { errors : result.errors, value } 
        );
    }

    return value;
}

export function assertStructuredCompleted( provider: string, finishReason?: ModelResponse['finishReason'] ): void
{
    if( finishReason === 'content_filter' || finishReason === 'length' )
    {
        throw new ProviderError( 
            provider, 
            `Structured output was not completed (finishReason: ${finishReason})`, 
            502, 
            { finishReason } 
        );
    }
}

/**
 * Attaches `structured` to a response. Skipped when the model answered with tool calls
 * (the structured answer is expected on the final, tool-free turn).
 */
export function attachStructured( 
    provider: string, 
    request: ModelRequest, 
    response: ModelResponse 
): ModelResponse
{
    if( !request.outputSchema || ( response.toolCalls && response.toolCalls.length > 0 ) )
    {
        return response;
    }

    assertStructuredCompleted( provider, response.finishReason );

    return { ...response, structured : parseStructuredOutput( provider, response.content, request.outputSchema ) };
}

type SchemaNode = Record<string, unknown>;

/**
 * True when every object node is closed (`additionalProperties: false`) and lists all of its
 * properties as required — the subset OpenAI's `strict: true` accepts.
 */
export function isStrictCompatible( input: unknown ): boolean
{
    if( Array.isArray( input ) )
    {
        return input.every( isStrictCompatible );
    }

    if( input === null || typeof input !== 'object' )
    {
        return true;
    }

    const node = input as SchemaNode;
    const properties = node.properties as Record<string, unknown> | undefined;

    if( node.type === 'object' || properties )
    {
        const keys = Object.keys( properties ?? {} );
        const required = Array.isArray( node.required ) ? node.required as string[] : [];

        if( node.additionalProperties !== false || !keys.every( ( key ) => {return required.includes( key );} ) )
        {
            return false;
        }
    }

    return Object.values( node ).every( isStrictCompatible );
}

const GEMINI_KEYS = new Set( [
    'type', 'format', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 
    'properties', 'required', 'items', 'anyOf', 'minimum', 'maximum', 'propertyOrdering', 'title'
] );

/** Reduces JSON Schema to the OpenAPI subset Gemini's `responseSchema` accepts. */
export function toGeminiSchema( input: unknown ): unknown
{
    if( Array.isArray( input ) )
    {
        return input.map( toGeminiSchema );
    }

    if( input === null || typeof input !== 'object' )
    {
        return input;
    }

    const node = { ...( input as SchemaNode ) };
    const out: SchemaNode = {};

    if( Array.isArray( node.type ) )
    {
        const types = ( node.type as string[] ).filter( ( t ) => {return t !== 'null';} );

        if( types.length !== node.type.length )
        {
            out.nullable = true;
        }

        node.type = types[ 0 ];
    }

    if( 'const' in node && !( 'enum' in node ) )
    {
        node.enum = [ node.const ];
    }

    for( const [ key, value ] of Object.entries( node ) )
    {
        if( !GEMINI_KEYS.has( key ) )
        {
            continue;
        }

        if( key === 'properties' && value && typeof value === 'object' )
        {
            out.properties = Object.fromEntries( 
                Object.entries( value as SchemaNode ).map( ( [ name, child ] ) => {return [ name, toGeminiSchema( child ) ];} ) 
            );
        }
        else if( key === 'items' || key === 'anyOf' )
        {
            out[ key ] = toGeminiSchema( value );
        }
        else
        {
            out[ key ] = value;
        }
    }

    return out;
}

/** Instruction used when the wire format only offers plain JSON mode (no schema enforcement). */
export function schemaInstruction( outputSchema: ModelRequest['outputSchema'] ): string
{
    return `Respond only with a single JSON value that conforms to this JSON Schema, with no surrounding text:\n${JSON.stringify( toJsonSchema( outputSchema ) )}`;
}

/** Typed convenience: generate and return the validated structured value. */
export async function generateStructured<T = unknown>( 
    model: LanguageModel, 
    request: ModelRequest & { outputSchema: NonNullable<ModelRequest['outputSchema']> } 
): Promise<ModelResponse & { structured: T }>
{
    const response = await model.generate( request );

    if( response.structured === undefined )
    {
        throw new ProviderError( 
            model.provider, 
            'Model returned tool calls instead of a structured answer', 
            502, 
            { toolCalls : response.toolCalls } 
        );
    }

    return response as ModelResponse & { structured: T };
}
