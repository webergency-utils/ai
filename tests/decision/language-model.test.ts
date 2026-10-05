import { describe, it, expect, vi } from 'vitest';
import {
    LanguageModelDecisionAdapter,
    createLanguageModelDecisionModel,
    createDecisionModel,
    toDecisionSchema,
    JevDecisionAdapter
} from '../../src/providers/index.js';
import type { LanguageModel, ModelRequest, ModelResponse } from '../../src/core/index.js';
import { CapabilityError, NO_CAPABILITIES, ProviderError, InputLimitError, question } from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

function fakeModel( structured: unknown, overrides: Partial<LanguageModel> = {}, response: Partial<ModelResponse> = {} ): { model : LanguageModel, calls : ModelRequest[] }
{
    const calls: ModelRequest[] = [];
    const model: LanguageModel = 
        {
            provider     : 'fake',
            model        : 'fake-1',
            capabilities : { ...NO_CAPABILITIES, structuredOutput : true },
            async generate( request )
            {
                calls.push( request );

                return {
                    content      : JSON.stringify( structured ),
                    role         : 'assistant',
                    structured,
                    usage        : { promptTokens : 100, completionTokens : 30, totalTokens : 130 },
                    finishReason : 'stop',
                    raw          : {},
                    ...response
                };
            },
            // eslint-disable-next-line require-yield
            async* stream()
            {
                throw new Error( 'not used' );
            },
            ...overrides
        };

    return { model, calls };
}

const questions = {
    isBilling : question.yesNo( { instructions : 'Is this billing?' } ),
    team      : question.choice( { billing : 'Payments', technical : null, other : null } ),
    urgency   : question.score( [ 'can wait', 'today', 'now' ], { instructions : 'How urgent?' } )
};

const structured = {
    isBilling : { probability : 0.9 },
    team      : { probabilities : { billing : 0.6, technical : 0.3, other : 0.3 }, confidence : 0.7 },
    urgency   : { probabilities : { 0 : 0, 1 : 0.5, 2 : 0.5 }, confidence : 0.4 }
};

describe( 'language-model decision adapter', () =>
{
    it( 'builds a closed per-question JSON schema (R11)', () =>
    {
        const schema = toDecisionSchema( questions ) as any;

        expect( schema.required ).toEqual( [ 'isBilling', 'team', 'urgency' ] );
        expect( schema.additionalProperties ).toBe( false );
        expect( schema.properties.isBilling.required ).toEqual( [ 'probability' ] );
        expect( schema.properties.team.properties.probabilities.required ).toEqual( [ 'billing', 'technical', 'other' ] );
        expect( schema.properties.urgency.properties.probabilities.required ).toEqual( [ '0', '1', '2' ] );
        expect( schema.properties.team.properties.confidence ).toEqual( { type : 'number', minimum : 0, maximum : 1 } );
    } );

    it( 'returns the shared answer shape, marked uncalibrated, with normalized probabilities (AE2)', async () =>
    {
        const { model, calls } = fakeModel( structured );
        const adapter = new LanguageModelDecisionAdapter( model );
        const res = await adapter.decide( { input : { subject : 'Charged twice' }, questions } );

        expect( res.calibrated ).toBe( false );
        expect( res.model ).toBe( 'fake-1' );
        expect( res.answers.isBilling ).toEqual( { type : 'yesNo', value : 0.9, probability : 0.9 } );
        expect( res.answers.team.value ).toBe( 'billing' );
        expect( res.answers.team.probabilities.billing ).toBeCloseTo( 0.5 );
        expect( res.answers.team.probabilities.technical + res.answers.team.probabilities.other + res.answers.team.probabilities.billing ).toBeCloseTo( 1 );
        expect( res.answers.team.confidence ).toBe( 0.7 );
        expect( res.answers.urgency.value ).toBeCloseTo( 1.5 );
        expect( res.answers.urgency.probabilities ).toEqual( [ 0, 0.5, 0.5 ] );
        expect( res.usage ).toMatchObject( { promptTokens : 100 } );

        const request = calls[ 0 ];
        const prompt = JSON.parse( request.messages[ 0 ].content );

        expect( request.outputSchema ).toEqual( toDecisionSchema( questions ) );
        expect( request.temperature ).toBe( 0 );
        expect( request.systemPrompt ).toMatch( /per-label|probability for every label/ );
        expect( prompt.input ).toEqual( { subject : 'Charged twice' } );
        expect( prompt.questions.team.labels ).toEqual( [
            { label : 'billing', description : 'Payments' },
            { label : 'technical', description : null },
            { label : 'other', description : null }
        ] );
        expect( prompt.questions.urgency.levels[ 2 ] ).toEqual( { level : 2, description : 'now' } );
        expect( prompt.questions.isBilling.type ).toBe( 'yes_no' );
    } );

    it( 'has the same answer shape as Jev for the same questions (AE2)', async () =>
    {
        const originalFetch = globalThis.fetch;

        vi.stubGlobal( 'fetch', vi.fn().mockResolvedValueOnce( jsonResponse( {
            model   : 'jev-1.13.0',
            answers : {
                isBilling : { type : 'noul', noul : 0.9 },
                team      : { type : 'choice', choice : 'billing', probabilities : { billing : 0.5, technical : 0.25, other : 0.25 }, confidence : 0.7 },
                urgency   : { type : 'score', score : 1.5, probabilities : { 0 : 0, 1 : 0.5, 2 : 0.5 }, confidence : 0.4 }
            },
            usage : { input_tokens : 1, output_tokens : 1 }
        } ) ) );

        try
        {
            const jev = await new JevDecisionAdapter( { apiKey : 'k' } ).decide( { input : 'x', questions } );
            const lm = await new LanguageModelDecisionAdapter( fakeModel( structured ).model ).decide( { input : 'x', questions } );

            expect( jev.calibrated ).toBe( true );
            expect( lm.calibrated ).toBe( false );
            expect( Object.keys( lm.answers ) ).toEqual( Object.keys( jev.answers ) );

            for( const name of Object.keys( questions ) as Array<keyof typeof questions> )
            {
                expect( Object.keys( lm.answers[ name ] ).sort() ).toEqual( Object.keys( jev.answers[ name ] ).sort() );
                expect( lm.answers[ name ].type ).toBe( jev.answers[ name ].type );
            }
        }
        finally
        {
            globalThis.fetch = originalFetch;
        }
    } );

    it( 'fails naming the missing capability when structured output is unsupported (AE3, R12)', async () =>
    {
        const { model, calls } = fakeModel( structured, { capabilities : { ...NO_CAPABILITIES } } );
        const bare = fakeModel( structured, { capabilities : undefined } ).model;

        await expect( new LanguageModelDecisionAdapter( model ).decide( { input : 'x', questions } ) ).rejects.toBeInstanceOf( CapabilityError );
        await expect( new LanguageModelDecisionAdapter( model ).decide( { input : 'x', questions } ) ).rejects.toThrow( /structuredOutput/ );
        await expect( new LanguageModelDecisionAdapter( bare ).decide( { input : 'x', questions } ) ).rejects.toThrow( /structuredOutput/ );
        expect( calls ).toHaveLength( 0 );
    } );

    it( 'passes cancellation, timeout, and retry options through to the language model (R13)', async () =>
    {
        const { model, calls } = fakeModel( structured );
        const controller = new AbortController();
        const onAttempt = vi.fn();

        await createLanguageModelDecisionModel( model, { temperature : 0.2, maxTokens : 500, systemPrompt : 'custom' } )
            .decide( { input : 'x', questions, signal : controller.signal, timeoutMs : 1234, retry : { maxRetries : 1 }, onAttempt } );

        expect( calls[ 0 ] ).toMatchObject( { signal : controller.signal, timeoutMs : 1234, retry : { maxRetries : 1 }, onAttempt, temperature : 0.2, maxTokens : 500, systemPrompt : 'custom' } );
    } );

    it( 'enforces opt-in input limits without truncating (R15)', async () =>
    {
        const { model, calls } = fakeModel( structured );
        const adapter = new LanguageModelDecisionAdapter( model, { inputLimits : { maxTokens : 50 } } );

        await expect( adapter.decide( { input : 'word '.repeat( 500 ), questions } ) ).rejects.toBeInstanceOf( InputLimitError );
        expect( calls ).toHaveLength( 0 );
    } );

    it( 'flags missing usage', async () =>
    {
        const { model } = fakeModel( structured, {}, { usage : undefined } );
        const res = await new LanguageModelDecisionAdapter( model ).decide( { input : 'x', questions } );

        expect( res.usageMissing ).toBe( true );
    } );

    it( 'fails loudly on defective model output', async () =>
    {
        const run = ( value: unknown, response: Partial<ModelResponse> = {} ): Promise<unknown> =>
        {
            return new LanguageModelDecisionAdapter( fakeModel( value, {}, response ).model ).decide( { input : 'x', questions } );
        };

        await expect( run( undefined, { structured : undefined } ) ).rejects.toThrow( /no structured/ );
        await expect( run( { ...structured, team : undefined } ) ).rejects.toThrow( /no answer for question 'team'/ );
        await expect( run( { ...structured, team : { confidence : 1 } } ) ).rejects.toThrow( /no probabilities/ );
        await expect( run( { ...structured, team : { probabilities : { billing : 0, technical : 0, other : 0 }, confidence : 1 } } ) ).rejects.toThrow( /sum to zero/ );
        await expect( run( { ...structured, isBilling : { probability : 3 } } ) ).rejects.toBeInstanceOf( ProviderError );
        await expect( run( { ...structured, team : { probabilities : { billing : 1, technical : 0 }, confidence : 1 } } ) ).rejects.toThrow( /probability for 'other'/ );
    } );

    it( 'wraps any registered language-model provider via the decision registry (F2)', async () =>
    {
        const originalFetch = globalThis.fetch;
        const body = { isBilling : { probability : 0.2 } };

        vi.stubGlobal( 'fetch', vi.fn().mockResolvedValueOnce( jsonResponse( {
            id      : 'x',
            choices : [ { message : { role : 'assistant', content : JSON.stringify( body ) }, finish_reason : 'stop' } ],
            usage   : { prompt_tokens : 5, completion_tokens : 2, total_tokens : 7 }
        } ) ) );

        try
        {
            const model = createDecisionModel( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );
            const res = await model.decide( { input : 'hi', questions : { isBilling : questions.isBilling } } );

            expect( model ).toBeInstanceOf( LanguageModelDecisionAdapter );
            expect( res.calibrated ).toBe( false );
            expect( res.answers.isBilling.value ).toBe( 0.2 );
        }
        finally
        {
            globalThis.fetch = originalFetch;
        }
    } );
} );
