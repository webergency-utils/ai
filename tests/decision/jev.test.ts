import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    JevDecisionAdapter,
    toJevQuestion,
    createDecisionModel,
    DecisionRegistry
} from '../../src/providers/index.js';
import {
    question,
    CancelledError,
    InputLimitError,
    InvalidInputError,
    ProviderError,
    RateLimitError
} from '../../src/core/index.js';
import { jsonResponse } from '../helpers/http.js';

function lastCall(): { url: string, body: Record<string, any>, headers: Record<string, string> }
{
    const call = vi.mocked( fetch ).mock.calls.at( -1 )!;
    const init = call[ 1 ] as RequestInit;

    return { url : String( call[ 0 ] ), body : JSON.parse( init.body as string ), headers : init.headers as Record<string, string> };
}

const questions = {
    isBilling : question.yesNo( { instructions : 'Is this billing?', yes : 'about money' } ),
    team      : question.choice( { billing : 'Payments', technical : null, other : null }, { instructions : 'Which team?' } ),
    urgency   : question.score( [ 'can wait', 'today', 'now' ], { instructions : 'How urgent?' } )
};

const okBody = {
    model   : 'jev-1.13.0',
    answers : {
        isBilling : { type : 'noul', noul : 0.95 },
        team      : { type : 'choice', choice : 'billing', probabilities : { billing : 0.88, technical : 0.12, other : 0 }, confidence : 0.81 },
        urgency   : { type : 'score', score : 1.05, legend : { 0 : 'can wait', 1 : 'today', 2 : 'now' }, probabilities : { 0 : 0, 1 : 0.95, 2 : 0.05 }, confidence : 0.92 }
    },
    usage : { input_tokens : 296, output_tokens : 20 }
};

describe( 'Jev decision adapter', () =>
{
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.TYPESAFE_API_KEY;

    beforeEach( () =>
    {
        vi.stubGlobal( 'fetch', vi.fn() );
        delete process.env.TYPESAFE_API_KEY;
    } );

    afterEach( () =>
    {
        globalThis.fetch = originalFetch;

        if( originalKey === undefined )
        {
            delete process.env.TYPESAFE_API_KEY;
        }
        else
        {
            process.env.TYPESAFE_API_KEY = originalKey;
        }

        vi.restoreAllMocks();
    } );

    it( 'translates library question types to the wire format (R8)', () =>
    {
        expect( toJevQuestion( questions.isBilling ) ).toEqual( { type : 'noul', instructions : 'Is this billing?', criteria : { true : 'about money' } } );
        expect( toJevQuestion( question.yesNo() ) ).toEqual( { type : 'noul', instructions : null } );
        expect( toJevQuestion( question.yesNo( { yes : 'y', no : 'n' } ) ) ).toMatchObject( { criteria : { true : 'y', false : 'n' } } );
        expect( toJevQuestion( questions.team ) ).toEqual( {
            type         : 'choice',
            instructions : 'Which team?',
            criteria     : { billing : 'Payments', technical : null, other : null }
        } );
        expect( toJevQuestion( questions.urgency ) ).toEqual( {
            type : 'score', instructions : 'How urgent?', criteria : [ 'can wait', 'today', 'now' ]
        } );
    } );

    it( 'posts to /v1/systemone with a Bearer key and returns calibrated typed answers (R9, R7)', async () =>
    {
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( okBody ) );

        const jev = new JevDecisionAdapter( { apiKey : 'sk-test' } );
        const res = await jev.decide( { input : { subject : 'Charged twice' }, questions } );
        const call = lastCall();

        expect( call.url ).toBe( 'https://api.typesafe.ai/v1/systemone' );
        expect( call.headers.Authorization ).toBe( 'Bearer sk-test' );
        expect( call.body.model ).toBe( 'jev-latest' );
        expect( call.body.state ).toEqual( { subject : 'Charged twice' } );
        expect( Object.keys( call.body.questions ) ).toEqual( [ 'isBilling', 'team', 'urgency' ] );
        expect( call.body.questions.isBilling.type ).toBe( 'noul' );

        expect( res.calibrated ).toBe( true );
        expect( res.model ).toBe( 'jev-1.13.0' );
        expect( res.answers.isBilling ).toEqual( { type : 'yesNo', value : 0.95, probability : 0.95 } );
        expect( res.answers.team ).toEqual( {
            type : 'choice', value : 'billing', probabilities : { billing : 0.88, technical : 0.12, other : 0 }, confidence : 0.81
        } );
        expect( res.answers.urgency ).toEqual( { type : 'score', value : 1.05, probabilities : [ 0, 0.95, 0.05 ], confidence : 0.92 } );
        expect( res.usage ).toMatchObject( { promptTokens : 296, completionTokens : 20 } );
        expect( res.usageMissing ).toBeUndefined();
    } );

    it( 'sends text input and a pinned model; reads the key from TYPESAFE_API_KEY (R10)', async () =>
    {
        process.env.TYPESAFE_API_KEY = 'env-key';
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( {
            model : 'jev-1.13.0', answers : { ok : { type : 'noul', noul : 0.1 } }, usage : { input_tokens : 3, output_tokens : 1 }
        } ) );

        const jev = createDecisionModel( { provider : 'typesafe', model : 'jev-1.13.0' } );

        await jev.decide( { input : 'hello', questions : { ok : question.yesNo() } } );

        const call = lastCall();

        expect( jev ).toBeInstanceOf( JevDecisionAdapter );
        expect( jev.model ).toBe( 'jev-1.13.0' );
        expect( call.body.model ).toBe( 'jev-1.13.0' );
        expect( call.body.state ).toBe( 'hello' );
        expect( call.headers.Authorization ).toBe( 'Bearer env-key' );
    } );

    it( 'honors a custom base URL and fails without a key before HTTP', async () =>
    {
        await expect( new JevDecisionAdapter().decide( { input : 'x', questions : { ok : question.yesNo() } } ) )
            .rejects.toThrow( /TYPESAFE_API_KEY/ );
        expect( fetch ).not.toHaveBeenCalled();

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { answers : { ok : { type : 'noul', noul : 0.5 } } } ) );

        const res = await new JevDecisionAdapter( { apiKey : 'k', baseUrl : 'https://gw.example.com/' } )
            .decide( { input : 'x', questions : { ok : question.yesNo() } } );

        expect( lastCall().url ).toBe( 'https://gw.example.com/v1/systemone' );
        expect( res.usageMissing ).toBe( true );
        expect( res.usage ).toBeUndefined();
        expect( res.model ).toBe( 'jev-latest' );
    } );

    it( 'rejects invalid requests before HTTP', async () =>
    {
        const jev = new JevDecisionAdapter( { apiKey : 'k' } );

        await expect( jev.decide( { input : 'x', questions : {} } ) ).rejects.toBeInstanceOf( InvalidInputError );
        expect( fetch ).not.toHaveBeenCalled();
    } );

    it( 'fails with InputLimitError before HTTP when the request exceeds Jev limits and never truncates (R15)', async () =>
    {
        const jev = new JevDecisionAdapter( { apiKey : 'k' } );
        const huge = 'word '.repeat( 140_000 );

        await expect( jev.decide( { input : huge, questions : { ok : question.yesNo() } } ) ).rejects.toBeInstanceOf( InputLimitError );
        expect( fetch ).not.toHaveBeenCalled();

        const context = 'word '.repeat( 40_000 );

        await expect( jev.decide( { input : context, questions : { ok : question.yesNo() } } ) ).rejects.toThrow( /longest question/ );

        const relaxed = new JevDecisionAdapter( { apiKey : 'k', inputLimits : false } );
        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { answers : { ok : { type : 'noul', noul : 0.5 } } } ) );
        await relaxed.decide( { input : huge, questions : { ok : question.yesNo() } } );

        expect( lastCall().body.state ).toBe( huge );
    } );

    it( 'maps a server 413 to InputLimitError and does not retry it', async () =>
    {
        vi.mocked( fetch ).mockResolvedValue( jsonResponse( { error : { message : 'too large' } }, { status : 413 } ) );

        await expect( new JevDecisionAdapter( { apiKey : 'k' } ).decide( { input : 'x', questions : { ok : question.yesNo() } } ) )
            .rejects.toBeInstanceOf( InputLimitError );
        expect( fetch ).toHaveBeenCalledTimes( 1 );
    } );

    it( 'fails loudly on malformed or mismatched responses', async () =>
    {
        const jev = new JevDecisionAdapter( { apiKey : 'k' } );
        const run = ( answers: unknown ): Promise<unknown> =>
        {
            vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { answers } ) );

            return jev.decide( { input : 'x', questions : { team : questions.team } } );
        };

        await expect( run( undefined ) ).rejects.toThrow( /no answers/ );
        await expect( run( {} ) ).rejects.toThrow( /no answer for question 'team'/ );
        await expect( run( { team : { type : 'score', score : 1 } } ) ).rejects.toThrow( /expected 'choice'/ );
        await expect( run( { team : { type : 'choice', choice : 'refund', probabilities : { billing : 1, technical : 0, other : 0 }, confidence : 1 } } ) )
            .rejects.toThrow( /not a declared label/ );
        await expect( run( { team : { type : 'choice', choice : 'billing', probabilities : { billing : 1 }, confidence : 1 } } ) )
            .rejects.toBeInstanceOf( ProviderError );
        await expect( run( { team : { type : 'choice', choice : 'billing', probabilities : { billing : 1, technical : 0, other : 0 } } } ) )
            .rejects.toThrow( /confidence/ );
        await expect( run( { team : { type : 'choice', choice : 'billing', confidence : 1 } } ) ).rejects.toThrow( /no probabilities/ );

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { answers : { s : { type : 'score', probabilities : { 0 : 1, 1 : 0 }, confidence : 1 } } } ) );
        await expect( jev.decide( { input : 'x', questions : { s : question.score( [ 'a', 'b' ] ) } } ) ).rejects.toThrow( /numeric score/ );

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { answers : { q : { type : 'noul', noul : 7 } } } ) );
        await expect( jev.decide( { input : 'x', questions : { q : question.yesNo() } } ) ).rejects.toThrow( /probability/ );
    } );

    it( 'retries server errors through the shared transport and honors retry:false (R13)', async () =>
    {
        const jev = new JevDecisionAdapter( { apiKey : 'k' } );

        vi.mocked( fetch )
            .mockResolvedValueOnce( jsonResponse( { error : { message : 'slow down' } }, { status : 429, headers : { 'retry-after-ms' : '1' } } ) )
            .mockResolvedValueOnce( jsonResponse( { answers : { ok : { type : 'noul', noul : 0.5 } } } ) );

        const attempts: number[] = [];
        const res = await jev.decide( { input : 'x', questions : { ok : question.yesNo() }, onAttempt : ( info ) => {attempts.push( info.attempt );} } );

        expect( res.answers.ok.value ).toBe( 0.5 );
        expect( attempts ).toContain( 2 );

        vi.mocked( fetch ).mockResolvedValueOnce( jsonResponse( { error : { message : 'slow down' } }, { status : 429, headers : { 'retry-after-ms' : '1' } } ) );
        await expect( jev.decide( { input : 'x', questions : { ok : question.yesNo() }, retry : false } ) ).rejects.toBeInstanceOf( RateLimitError );
    } );

    it( 'supports cancellation (R13)', async () =>
    {
        const controller = new AbortController();

        controller.abort();

        await expect( new JevDecisionAdapter( { apiKey : 'k' } ).decide( { input : 'x', questions : { ok : question.yesNo() }, signal : controller.signal } ) )
            .rejects.toBeInstanceOf( CancelledError );
    } );

    it( 'registers the jev alias and rejects unknown providers', () =>
    {
        const registry = new DecisionRegistry();

        expect( registry.create( { provider : 'jev', model : 'jev-latest', apiKey : 'k' } ) ).toBeInstanceOf( JevDecisionAdapter );
        expect( registry.has( 'typesafe' ) ).toBe( true );
        expect( registry.has( 'openai' ) ).toBe( true );
        expect( registry.has( 'nope' ) ).toBe( false );
        expect( () => registry.create( { provider : 'nope', model : 'x' } ) ).toThrow( /not registered/ );
        expect( registry.create( { provider : 'jev', model : 'jev-latest', apiKey : 'k' } ) )
            .toBe( registry.create( { provider : 'jev', model : 'jev-latest', apiKey : 'k' } ) );

        registry.clearCache();
    } );
} );
