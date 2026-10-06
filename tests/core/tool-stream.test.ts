import { describe, it, expect } from 'vitest';
import {
    ToolCallStreamAssembler,
    assembleStream,
    finalizeStream,
    parseToolArguments,
    InvalidInputError,
    ProviderError,
    type ModelStreamChunk,
    type ToolDefinition
} from '../../src/core/index.js';

const searchTool: ToolDefinition = {
    name        : 'search',
    description : 'search',
    parameters  : { type : 'object', properties : { q : { type : 'string' } }, required : [ 'q' ] }
};

function tc( index: number, extra: { id?: string, name?: string, arguments?: string } ): ModelStreamChunk
{
    return { deltaContent : '', deltaToolCall : { index, ...extra } };
}

async function* gen( chunks: ModelStreamChunk[] ): AsyncGenerator<ModelStreamChunk>
{
    for( const chunk of chunks )
    {
        yield chunk;
    }
}

describe( 'ToolCallStreamAssembler', () =>
{
    it( 'assembles two indices with fragmented arguments (AE3)', async () =>
    {
        const result = await assembleStream( [
            { deltaContent : 'Hi ' },
            tc( 0, { id : 'c1', name : 'search', arguments : '{"q"' } ),
            tc( 1, { id : 'c2', name : 'lookup', arguments : '{"id"' } ),
            tc( 0, { arguments : ':"cats"}' } ),
            { deltaContent : 'there', deltaReasoningContent : 'think' },
            tc( 1, { arguments : ':7}' } ),
            { deltaContent : '', deltaReasoningContent : ' more', finishReason : 'tool_calls' }
        ], { provider : 'openai' } );

        expect( result.text ).toBe( 'Hi there' );
        expect( result.reasoning ).toBe( 'think more' );
        expect( result.finishReason ).toBe( 'tool_calls' );
        expect( result.toolCalls ).toEqual( [
            { id : 'c1', name : 'search', arguments : { q : 'cats' } },
            { id : 'c2', name : 'lookup', arguments : { id : 7 } }
        ] );
    } );

    it( 'assembles Anthropic-style repeated id/name with input_json_delta fragments', async () =>
    {
        const result = await assembleStream( [
            tc( 1, { id : 'tu', name : 'search', arguments : '' } ),
            tc( 1, { id : 'tu', name : 'search', arguments : '{"q": "a' } ),
            tc( 1, { id : 'tu', name : 'search', arguments : 'b"}' } )
        ] );

        expect( result.toolCalls ).toEqual( [ { id : 'tu', name : 'search', arguments : { q : 'ab' } } ] );
    } );

    it( 'treats a never-fragmented argument string as no arguments', async () =>
    {
        const result = await assembleStream( [ tc( 0, { id : 'a', name : 'ping', arguments : '' } ) ] );

        expect( result.toolCalls[ 0 ].arguments ).toEqual( {} );
    } );

    it( 'throws ProviderError on truncated JSON instead of returning partial keys', async () =>
    {
        const promise = assembleStream( [ tc( 0, { id : 'a', name : 'search', arguments : '{"q"' } ) ], { provider : 'openai' } );

        await expect( promise ).rejects.toBeInstanceOf( ProviderError );
        await expect( promise ).rejects.toThrow( /search/ );
    } );

    it( 'throws when arguments are valid JSON but not an object', async () =>
    {
        await expect( assembleStream( [ tc( 0, { id : 'a', name : 'search', arguments : '[1]' } ) ] ) )
            .rejects.toBeInstanceOf( ProviderError );
    } );

    it( 'throws when a fragment never received a name', async () =>
    {
        await expect( assembleStream( [ tc( 0, { arguments : '{}' } ) ] ) ).rejects.toBeInstanceOf( ProviderError );
    } );

    it( 'validates assembled calls against request tools and names the tool', async () =>
    {
        const chunks = [ tc( 0, { id : 'a', name : 'search', arguments : '{"q":5}' } ) ];

        const promise = assembleStream( chunks, { tools : [ searchTool ] } );

        await expect( promise ).rejects.toBeInstanceOf( InvalidInputError );
        await expect( promise ).rejects.toThrow( /search/ );
    } );

    it( 'skips validation for tools that are not in the request', async () =>
    {
        const result = await assembleStream( 
            [ tc( 0, { id : 'a', name : 'other', arguments : '{"x":1}' } ) ], 
            { tools : [ searchTool ] } 
        );

        expect( result.toolCalls ).toHaveLength( 1 );
    } );

    it( 'accepts ready-made toolCalls chunks (Ollama style) and validates them', async () =>
    {
        const ok = await assembleStream( 
            [ { deltaContent : '', toolCalls : [ { id : 'o', name : 'search', arguments : { q : 'x' } } ] } ], 
            { tools : [ searchTool ] } 
        );

        expect( ok.toolCalls ).toHaveLength( 1 );

        await expect( assembleStream( 
            [ { deltaContent : '', toolCalls : [ { id : 'o', name : 'search', arguments : {} } ] } ], 
            { tools : [ searchTool ] } 
        ) ).rejects.toBeInstanceOf( InvalidInputError );
    } );

    it( 'rejects a terminal toolCalls chunk that disagrees with fragments', () =>
    {
        const assembler = new ToolCallStreamAssembler( { provider : 'x' } );

        assembler.push( tc( 0, { id : 'a', name : 'search', arguments : '{"q":"a"}' } ) );
        assembler.push( { deltaContent : '', toolCalls : [ { id : 'a', name : 'search', arguments : { q : 'b' } } ] } );

        expect( () => assembler.finish() ).toThrow( /disagrees/ );
    } );

    it( 'accepts a terminal toolCalls chunk equal to the fragments', () =>
    {
        const assembler = new ToolCallStreamAssembler();

        assembler.push( tc( 0, { id : 'a', name : 'search', arguments : '{"q":"a"}' } ) );
        assembler.push( { deltaContent : '', toolCalls : [ { id : 'a', name : 'search', arguments : { q : 'a' } } ] } );

        expect( assembler.finish().toolCalls ).toHaveLength( 1 );
    } );
} );

describe( 'finalizeStream', () =>
{
    it( 'passes chunks through and appends one terminal toolCalls chunk', async () =>
    {
        const out: ModelStreamChunk[] = [];

        for await ( const chunk of finalizeStream( gen( [
            { deltaContent : 'x' },
            tc( 0, { id : 'a', name : 'search', arguments : '{"q":"z"}' } ),
            { deltaContent : '', finishReason : 'tool_calls' }
        ] ) ) )
        {
            out.push( chunk );
        }

        expect( out ).toHaveLength( 4 );
        expect( out[ 3 ].toolCalls ).toEqual( [ { id : 'a', name : 'search', arguments : { q : 'z' } } ] );
    } );

    it( 'does not append a terminal chunk when there were no tool deltas', async () =>
    {
        const out: ModelStreamChunk[] = [];

        for await ( const chunk of finalizeStream( gen( [ { deltaContent : 'x' } ] ) ) )
        {
            out.push( chunk );
        }

        expect( out ).toHaveLength( 1 );
    } );

    it( 'propagates source errors without a terminal chunk', async () =>
    {
        async function* failing(): AsyncGenerator<ModelStreamChunk>
        {
            yield tc( 0, { id : 'a', name : 'search', arguments : '{"q"' } );

            throw new Error( 'boom' );
        }

        await expect( ( async () => {for await ( const _ of finalizeStream( failing() ) ) {void _;}} )() )
            .rejects.toThrow( 'boom' );
    } );
} );

describe( 'parseToolArguments', () =>
{
    it( 'returns objects as-is and maps absent args to {}', () =>
    {
        expect( parseToolArguments( 'p', 't', { a : 1 } ) ).toEqual( { a : 1 } );
        expect( parseToolArguments( 'p', 't', undefined ) ).toEqual( {} );
        expect( parseToolArguments( 'p', 't', '  ' ) ).toEqual( {} );
    } );

    it( 'throws with the tool name and raw fragment for malformed JSON (AE4)', () =>
    {
        expect( () => parseToolArguments( 'openai', 'search', '{not json' ) ).toThrow( /search.*\{not json/ );
    } );

    it( 'rejects non-object wire payloads', () =>
    {
        expect( () => parseToolArguments( 'p', 't', [ 1 ] ) ).toThrow( ProviderError );
        expect( () => parseToolArguments( 'p', 't', 5 ) ).toThrow( ProviderError );
    } );
} );
