import type { ModelRequest, ModelStreamChunk, ToolCall, ToolDefinition, UsageMetrics, ModelResponse } from './types.js';
import { InvalidInputError, ProviderError } from './error.js';
import { toJsonSchema, validateSchema } from './schema.js';
import { assertStructuredCompleted, parseStructuredOutput } from './structured-output.js';

const RAW_FRAGMENT_LIMIT = 200;

export interface AssembledStream
{
    text         : string
    reasoning    : string
    toolCalls    : ToolCall[]
    finishReason?: ModelResponse['finishReason']
    usage?       : UsageMetrics
}

export interface ToolCallAssemblerOptions
{
    /** Provider id used in `ProviderError` messages. */
    provider? : string
    /** When set, assembled arguments are validated against the matching tool schema. */
    tools?    : ToolDefinition[]
    /** When set, `finalizeStream` parses and validates the assembled text once the stream ends. */
    outputSchema? : ModelRequest['outputSchema']
}

interface PartialToolCall
{
    id        : string
    name      : string
    arguments : string
}

function truncate( raw: string ): string
{
    return raw.length > RAW_FRAGMENT_LIMIT ? `${raw.slice( 0, RAW_FRAGMENT_LIMIT )}…` : raw;
}

function isPlainObject( value: unknown ): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray( value );
}

/**
 * Normalizes wire tool arguments (JSON text or an already-decoded value) to an object.
 * Never substitutes `{}` for malformed input: an empty fragment means "no arguments were
 * sent" and is the only value mapped to `{}`.
 */
export function parseToolArguments( 
    provider: string, 
    toolName: string, 
    raw: unknown 
): Record<string, unknown>
{
    if( raw === undefined || raw === null )
    {
        return {};
    }

    let value: unknown = raw;

    if( typeof raw === 'string' )
    {
        if( raw.trim() === '' )
        {
            return {};
        }

        try
        {
            value = JSON.parse( raw );
        }
        catch( error )
        {
            throw new ProviderError( 
                provider, 
                `Invalid JSON in arguments for tool '${toolName}': ${truncate( raw )}`, 
                502, 
                { toolName, raw, cause : error instanceof Error ? error.message : String( error ) } 
            );
        }
    }

    if( !isPlainObject( value ) )
    {
        throw new ProviderError( 
            provider, 
            `Arguments for tool '${toolName}' must be a JSON object, got ${Array.isArray( value ) ? 'array' : typeof value}`, 
            502, 
            { toolName, raw } 
        );
    }

    return value;
}

/** Validates tool-call arguments against the request's tool definitions (unknown tools are skipped). */
export function validateToolCalls( toolCalls: ToolCall[], tools?: ToolDefinition[] ): void
{
    if( !tools || tools.length === 0 )
    {
        return;
    }

    for( const call of toolCalls )
    {
        const definition = tools.find( ( tool ) => {return tool.name === call.name;} );

        if( !definition )
        {
            continue;
        }

        const result = validateSchema( toJsonSchema( definition.parameters ), call.arguments, 'relaxed' );

        if( !result.success )
        {
            const detail = ( result.errors ?? [] )
                .map( ( err ) => {return `${err.path || '(root)'}: ${err.error}`;} )
                .join( '; ' );

            throw new InvalidInputError( 
                `Arguments for tool '${call.name}' failed schema validation: ${detail}`, 
                { toolName : call.name, errors : result.errors } 
            );
        }
    }
}

/**
 * Folds `ModelStreamChunk`s into text, reasoning, and complete tool calls.
 * Tool fragments are concatenated per index and parsed exactly once in `finish()`.
 */
export class ToolCallStreamAssembler
{
    readonly #provider : string;
    readonly #tools?   : ToolDefinition[];
    readonly #partials = new Map<number, PartialToolCall>();
    readonly #complete : ToolCall[] = [];
    #text              = '';
    #reasoning         = '';
    #finishReason?     : ModelResponse['finishReason'];
    #usage?            : UsageMetrics;

    constructor( options: ToolCallAssemblerOptions = {} )
    {
        this.#provider = options.provider ?? 'unknown';
        this.#tools = options.tools;
    }

    public get text(): string
    {
        return this.#text;
    }

    /** True when tool calls arrived as index-keyed fragments (not as ready-made `toolCalls`). */
    public get sawToolDeltas(): boolean
    {
        return this.#partials.size > 0;
    }

    public push( chunk: ModelStreamChunk ): void
    {
        this.#text += chunk.deltaContent ?? '';
        this.#reasoning += chunk.deltaReasoningContent ?? '';

        if( chunk.finishReason )
        {
            this.#finishReason = chunk.finishReason;
        }

        if( chunk.usage )
        {
            this.#usage = chunk.usage;
        }

        const delta = chunk.deltaToolCall;

        if( delta )
        {
            const partial = this.#partials.get( delta.index ) ?? { id : '', name : '', arguments : '' };

            if( delta.id )
            {
                partial.id = delta.id;
            }

            if( delta.name )
            {
                partial.name = delta.name;
            }

            if( delta.arguments )
            {
                partial.arguments += delta.arguments;
            }

            this.#partials.set( delta.index, partial );
        }

        if( chunk.toolCalls && chunk.toolCalls.length > 0 )
        {
            this.#complete.push( ...chunk.toolCalls );
        }
    }

    /**
     * Parses and validates all tool calls. Fragment-assembled calls and ready-made
     * `toolCalls` chunks must agree when both are present (R15).
     */
    public finish(): AssembledStream
    {
        const assembled: ToolCall[] = [];

        for( const [ index, partial ] of [ ...this.#partials.entries() ].sort( ( a, b ) => {return a[ 0 ] - b[ 0 ];} ) )
        {
            if( !partial.name )
            {
                throw new ProviderError( 
                    this.#provider, 
                    `Streamed tool call at index ${index} has no name`, 
                    502, 
                    { index, raw : partial.arguments } 
                );
            }

            assembled.push( {
                id        : partial.id,
                name      : partial.name,
                arguments : parseToolArguments( this.#provider, partial.name, partial.arguments )
            } );
        }

        let toolCalls = assembled;

        if( assembled.length === 0 )
        {
            toolCalls = this.#complete;
        }
        else if( this.#complete.length > 0 && JSON.stringify( assembled ) !== JSON.stringify( this.#complete ) )
        {
            throw new ProviderError( 
                this.#provider, 
                'Terminal toolCalls chunk disagrees with assembled stream fragments', 
                502, 
                { assembled, terminal : this.#complete } 
            );
        }

        validateToolCalls( toolCalls, this.#tools );

        return {
            text         : this.#text,
            reasoning    : this.#reasoning,
            toolCalls,
            finishReason : this.#finishReason,
            usage        : this.#usage
        };
    }
}

/** Assembles a whole (sync or async) chunk sequence. */
export async function assembleStream( 
    chunks: AsyncIterable<ModelStreamChunk> | Iterable<ModelStreamChunk>, 
    options: ToolCallAssemblerOptions = {} 
): Promise<AssembledStream>
{
    const assembler = new ToolCallStreamAssembler( options );

    for await ( const chunk of chunks )
    {
        assembler.push( chunk );
    }

    return assembler.finish();
}

/**
 * Passes chunks through unchanged, then (after the source ends cleanly) parses and
 * validates tool calls once. When tool calls arrived as fragments, a final chunk
 * carrying the complete `toolCalls` is appended (R15); with `outputSchema` the same
 * chunk carries the validated `structured` value (R12). Source errors propagate.
 */
export async function* finalizeStream( 
    source: AsyncIterable<ModelStreamChunk>, 
    options: ToolCallAssemblerOptions = {} 
): AsyncGenerator<ModelStreamChunk, void, unknown>
{
    const assembler = new ToolCallStreamAssembler( options );

    for await ( const chunk of source )
    {
        assembler.push( chunk );

        yield chunk;
    }

    const result = assembler.finish();
    const terminal: ModelStreamChunk = { deltaContent : '' };

    if( assembler.sawToolDeltas && result.toolCalls.length > 0 )
    {
        terminal.toolCalls = result.toolCalls;
    }

    // Structured answers are expected on the final, tool-free turn (R12).
    if( options.outputSchema && result.toolCalls.length === 0 )
    {
        const provider = options.provider ?? 'unknown';

        assertStructuredCompleted( provider, result.finishReason );
        terminal.structured = parseStructuredOutput( provider, result.text, options.outputSchema );
    }

    if( terminal.toolCalls || 'structured' in terminal )
    {
        yield terminal;
    }
}
