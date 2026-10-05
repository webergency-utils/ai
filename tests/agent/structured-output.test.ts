import { describe, it, expect } from 'vitest';
import { Agent, createTool, type AgentEvent } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { CapabilityError, InvalidInputError, AIError, GuardrailTripwireError } from '../../src/core/error.js';
import { NO_CAPABILITIES, type LanguageModel } from '../../src/core/protocol.js';
import type { ModelRequest, ModelResponse, ModelStreamChunk } from '../../src/core/types.js';

const CAPABLE = { ...NO_CAPABILITIES, structuredOutput : true };

const OUTPUT_SCHEMA = schema.object( { city : schema.string(), temp : schema.number() } );

interface Script
{
    responses : ModelResponse[]
    /** Optional stream chunks per call; defaults to deriving them from `responses`. */
    streams?  : ModelStreamChunk[][]
}

function scripted( script: Script, capabilities = CAPABLE ): { model: LanguageModel, requests: ModelRequest[] }
{
    const requests: ModelRequest[] = [];
    let generateTurn = 0;
    let streamTurn = 0;
    const model: LanguageModel = {
        provider     : 'openai',
        model        : 'gpt-4o',
        capabilities,
        async generate( request: ModelRequest ): Promise<ModelResponse>
        {
            requests.push( { ...request, messages : [ ...request.messages ] } );

            return script.responses[ generateTurn++ ]!;
        },
        async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
        {
            requests.push( { ...request, messages : [ ...request.messages ] } );

            yield* script.streams![ streamTurn++ ]!;
        }
    };

    return { model, requests };
}

const toolTurn: ModelResponse = {
    role         : 'assistant',
    content      : '',
    finishReason : 'tool_calls',
    toolCalls    : [ { id : 'c1', name : 'lookup', arguments : {} } ],
    raw          : {}
};
const textTurn = ( content: string ): ModelResponse => {return { role : 'assistant', content, finishReason : 'stop', raw : {} };};
const structuredTurn = ( structured: unknown ): ModelResponse => {return { role : 'assistant', content : JSON.stringify( structured ), structured, finishReason : 'stop', raw : {} };};

const lookup = createTool( {
    name        : 'lookup',
    description : 'lookup',
    parameters  : schema.object( {} ),
    execute     : async () => {return 'Prague, 21C';}
} );

describe( 'agent structured output (U4)', () => 
{
    it( 'refuses an outputSchema when the model lacks structuredOutput, naming provider and capability (AE7, R15)', () => 
    {
        const { model } = scripted( { responses : [] }, NO_CAPABILITIES );
        const error = ( () => {try { new Agent( { model, outputSchema : OUTPUT_SCHEMA } ); } catch( err ){ return err; }} )();

        expect( error ).toBeInstanceOf( CapabilityError );
        expect( ( error as CapabilityError ).message ).toContain( 'structuredOutput' );
        expect( ( error as CapabilityError ).message ).toContain( 'openai' );
    } );

    it( 'treats a model without a capabilities field as unsupported (R15)', () => 
    {
        const bare: LanguageModel = { provider : 'custom', model : 'm', async generate(){ throw new Error( 'unused' ); }, async* stream(){ yield* []; } };

        expect( () => {return new Agent( { model : bare, outputSchema : OUTPUT_SCHEMA } );} ).toThrow( /structuredOutput/ );
    } );

    it( 'returns the validated object via an extra tool-less finalize call (R16, R17)', async () => 
    {
        const { model, requests } = scripted( { responses : [ toolTurn, textTurn( 'It is 21C in Prague.' ), structuredTurn( { city : 'Prague', temp : 21 } ) ] } );
        const result = await new Agent( { model, tools : [ lookup ], outputSchema : OUTPUT_SCHEMA } ).run( 'weather?' );

        expect( result.output ).toEqual( { city : 'Prague', temp : 21 } );
        expect( result.text ).toBe( 'It is 21C in Prague.' );
        expect( result.steps ).toBe( 3 );
        expect( result.status ).toBe( 'completed' );

        expect( requests[ 0 ]!.outputSchema ).toBeUndefined();
        expect( requests[ 1 ]!.outputSchema ).toBeUndefined();
        expect( requests[ 2 ]!.outputSchema ).toBe( OUTPUT_SCHEMA );
        expect( requests[ 2 ]!.tools ).toBeUndefined();

        // The finalize instruction is ephemeral; history ends with the loop's answer.
        expect( requests[ 2 ]!.messages.at( -1 ) ).toMatchObject( { role : 'user' } );
        expect( result.messages.at( -1 ) ).toEqual( { role : 'assistant', content : 'It is 21C in Prague.' } );
        expect( JSON.stringify( result.messages ) ).not.toContain( 'final answer now as JSON' );
    } );

    it( 'does not add an output key without an outputSchema', async () => 
    {
        const { model } = scripted( { responses : [ textTurn( 'hi' ) ] } );
        const result = await new Agent( { model } ).run( 'x' );

        expect( 'output' in result ).toBe( false );
    } );

    it( 'throws InvalidInputError when the finalize turn has no structured value (R16)', async () => 
    {
        const { model } = scripted( { responses : [ textTurn( 'prose' ), textTurn( 'still prose' ) ] } );

        await expect( new Agent( { model, outputSchema : OUTPUT_SCHEMA } ).run( 'x' ) ).rejects.toBeInstanceOf( InvalidInputError );
    } );

    it( 'throws InvalidInputError when the structured value violates the schema (R16)', async () => 
    {
        const { model } = scripted( { responses : [ textTurn( 'prose' ), structuredTurn( { city : 'Prague', temp : 'warm' } ) ] } );

        await expect( new Agent( { model, outputSchema : OUTPUT_SCHEMA } ).run( 'x' ) ).rejects.toThrow( /failed schema validation/ );
    } );

    it( 'never fabricates output on step_limit (R18)', async () => 
    {
        const { model } = scripted( { responses : [ toolTurn, toolTurn ] } );
        const result = await new Agent( { model, tools : [ lookup ], maxIterations : 2, outputSchema : OUTPUT_SCHEMA } ).run( 'x' );

        expect( result.status ).toBe( 'step_limit' );
        expect( result.output ).toBeUndefined();
        expect( 'output' in result ).toBe( false );
    } );

    it( 'finalizes even when the loop used every iteration (finalize is not starved)', async () => 
    {
        const { model } = scripted( { responses : [ toolTurn, textTurn( 'answer' ), structuredTurn( { city : 'Prague', temp : 1 } ) ] } );
        const result = await new Agent( { model, tools : [ lookup ], maxIterations : 2, outputSchema : OUTPUT_SCHEMA } ).run( 'x' );

        expect( result.status ).toBe( 'completed' );
        expect( result.steps ).toBe( 3 );
        expect( result.output ).toEqual( { city : 'Prague', temp : 1 } );
    } );

    it( 'inline strategy sends the schema on every step and uses the final turn (R17)', async () => 
    {
        const { model, requests } = scripted( { responses : [ toolTurn, structuredTurn( { city : 'Prague', temp : 21 } ) ] } );
        const result = await new Agent( { model, tools : [ lookup ], outputSchema : OUTPUT_SCHEMA, outputStrategy : 'inline' } ).run( 'x' );

        expect( requests.map( ( r ) => {return r.outputSchema;} ) ).toEqual( [ OUTPUT_SCHEMA, OUTPUT_SCHEMA ] );
        expect( result.steps ).toBe( 2 );
        expect( result.output ).toEqual( { city : 'Prague', temp : 21 } );
    } );

    it( 'inline strategy fails loudly when the final turn carries no structured value (R16)', async () => 
    {
        const { model } = scripted( { responses : [ textTurn( 'prose' ) ] } );

        await expect( new Agent( { model, outputSchema : OUTPUT_SCHEMA, outputStrategy : 'inline' } ).run( 'x' ) ).rejects.toBeInstanceOf( InvalidInputError );
    } );

    it( 'streams a finalize step and validates the JSON text (R16, R17)', async () => 
    {
        const json = JSON.stringify( { city : 'Prague', temp : 21 } );
        const { model } = scripted( { 
            responses : [], 
            streams   : [
                [ { deltaContent : 'Prague is nice', finishReason : 'stop' } ],
                [ { deltaContent : json.slice( 0, 10 ) }, { deltaContent : json.slice( 10 ), finishReason : 'stop' } ]
            ]
        } );
        const events: AgentEvent[] = [];

        for await ( const event of new Agent( { model, outputSchema : OUTPUT_SCHEMA } ).runStream( 'x' ) )
        {
            events.push( event );
        }

        const finish = events.at( -1 )!;

        expect( events.filter( ( e ) => {return e.type === 'step:start';} ).map( ( e ) => {return e.type === 'step:start' && e.step;} ) ).toEqual( [ 0, 1 ] );
        expect( finish.type === 'finish' && finish.result.output ).toEqual( { city : 'Prague', temp : 21 } );
        expect( finish.type === 'finish' && finish.result.text ).toBe( 'Prague is nice' );
    } );

    it( 'streaming rejects structured JSON that violates the schema (R16)', async () => 
    {
        const { model } = scripted( { 
            responses : [], 
            streams   : [
                [ { deltaContent : 'ok', finishReason : 'stop' } ],
                [ { deltaContent : '{"city":1,"temp":2}', finishReason : 'stop' } ]
            ]
        } );
        const consume = async () => 
        {
            for await ( const _event of new Agent( { model, outputSchema : OUTPUT_SCHEMA } ).runStream( 'x' ) ){ void _event; }
        };

        await expect( consume() ).rejects.toBeInstanceOf( InvalidInputError );
    } );

    it( 'passes the structured value to output guardrails (R11)', async () => 
    {
        const seen: unknown[] = [];
        const { model } = scripted( { responses : [ textTurn( 'prose' ), structuredTurn( { city : 'Prague', temp : 99 } ) ] } );
        const agent = new Agent( { 
            model, 
            outputSchema : OUTPUT_SCHEMA, 
            guardrails   : { output : [ ( payload ) => 
            {
                seen.push( payload.output );

                return { allow : false, reason : 'too hot' };
            } ] } 
        } );

        await expect( agent.run( 'x' ) ).rejects.toBeInstanceOf( GuardrailTripwireError );

        expect( seen ).toEqual( [ { city : 'Prague', temp : 99 } ] );
    } );

    it( 'validates configuration at construction', () => 
    {
        const { model } = scripted( { responses : [] } );

        expect( () => {return new Agent( { model, outputStrategy : 'inline' } );} ).toThrow( AIError );
        expect( () => {return new Agent( { model, outputSchema : OUTPUT_SCHEMA, outputStrategy : 'later' as never } );} ).toThrow( /outputStrategy/ );
        expect( () => {return new Agent( { model, outputSchema : { type : 'weird' } } );} ).toThrow();
    } );
} );
