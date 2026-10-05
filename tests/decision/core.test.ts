import { describe, it, expect } from 'vitest';
import {
    question,
    assertDecisionRequest,
    assertDecisionInputLimit,
    estimateDecisionTokens,
    buildChoiceAnswer,
    buildScoreAnswer,
    buildYesNoAnswer,
    normalizeProbabilities,
    toProbability,
    argmax,
    weightedLevel,
    InputLimitError,
    InvalidInputError,
    ProviderError
} from '../../src/core/index.js';

describe( 'decision question builders', () =>
{
    it( 'builds a choice question from a label list or a record of descriptions', () =>
    {
        const fromList = question.choice( [ 'billing', 'technical' ], { instructions : 'Which team?' } );
        const fromRecord = question.choice( { billing : 'Payments', technical : null, other : undefined } );

        expect( fromList ).toEqual( {
            type         : 'choice',
            options      : [ { label : 'billing' }, { label : 'technical' } ],
            instructions : 'Which team?'
        } );
        expect( fromRecord.options ).toEqual( [
            { label : 'billing', description : 'Payments' },
            { label : 'technical' },
            { label : 'other' }
        ] );
    } );

    it( 'rejects empty, duplicate, blank, and oversized label sets', () =>
    {
        expect( () => question.choice( [] ) ).toThrow( InvalidInputError );
        expect( () => question.choice( [ 'a', 'a' ] ) ).toThrow( /duplicate/ );
        expect( () => question.choice( [ '' ] ) ).toThrow( /non-empty/ );
        expect( () => question.choice( Array.from( { length : 256 }, ( _, i ) => {return `l${i}`;} ) ) ).toThrow( /1 to 255/ );
        expect( () => question.choice( Array.from( { length : 255 }, ( _, i ) => {return `l${i}`;} ) ) ).not.toThrow();
    } );

    it( 'builds score questions with 2 to 10 levels', () =>
    {
        expect( question.score( [ 'low', 'high' ] ).levels ).toEqual( [ 'low', 'high' ] );
        expect( question.score( [ null, 'mid', 'top' ], { instructions : 'urgency' } ).instructions ).toBe( 'urgency' );
        expect( () => question.score( [ 'only' ] ) ).toThrow( /2 to 10/ );
        expect( () => question.score( Array.from( { length : 11 }, () => {return 'x';} ) ) ).toThrow( /2 to 10/ );
        expect( () => question.score( Array.from( { length : 10 }, () => {return 'x';} ) ) ).not.toThrow();
    } );

    it( 'builds yes/no questions with optional yes and no descriptions', () =>
    {
        expect( question.yesNo() ).toEqual( { type : 'yesNo' } );
        expect( question.yesNo( { instructions : 'Billing?', yes : 'about money', no : 'anything else' } ) ).toEqual( {
            type         : 'yesNo',
            instructions : 'Billing?',
            yes          : 'about money',
            no           : 'anything else'
        } );
    } );

    it( 'accepts structured instructions', () =>
    {
        const q = question.yesNo( { instructions : { question : 'Same as `other`?', other : { name : 'x' } } } );

        expect( ( q.instructions as Record<string, unknown> ).question ).toContain( 'other' );
    } );

    it( 'rejects non-description values', () =>
    {
        expect( () => question.yesNo( { yes : 5 as unknown as string } ) ).toThrow( InvalidInputError );
    } );
} );

describe( 'assertDecisionRequest', () =>
{
    const good = { input : 'text', questions : { a : question.yesNo() } };

    it( 'accepts text, object, and list input', () =>
    {
        expect( () => assertDecisionRequest( good ) ).not.toThrow();
        expect( () => assertDecisionRequest( { ...good, input : { a : 1 } } ) ).not.toThrow();
        expect( () => assertDecisionRequest( { ...good, input : [ 1, 2 ] } ) ).not.toThrow();
    } );

    it( 'rejects missing input, no questions, and hand-written bad questions', () =>
    {
        expect( () => assertDecisionRequest( { ...good, input : undefined as unknown as string } ) ).toThrow( InvalidInputError );
        expect( () => assertDecisionRequest( { ...good, input : 5 as unknown as string } ) ).toThrow( InvalidInputError );
        expect( () => assertDecisionRequest( { ...good, questions : {} } ) ).toThrow( /at least one question/ );
        expect( () => assertDecisionRequest( { ...good, questions : [] as never } ) ).toThrow( InvalidInputError );
        expect( () => assertDecisionRequest( { ...good, questions : { a : { type : 'rank' } as never } } ) ).toThrow( /unknown type/ );
        expect( () => assertDecisionRequest( { ...good, questions : { a : null as never } } ) ).toThrow( InvalidInputError );
    } );
} );

describe( 'decision input limits (R15)', () =>
{
    const questions = { a : question.choice( [ 'x', 'y' ], { instructions : 'q'.repeat( 400 ) } ), b : question.yesNo() };

    it( 'estimates total and longest-question context', () =>
    {
        const estimate = estimateDecisionTokens( { input : 'a'.repeat( 400 ), questions }, ( text ) => {return text.length;} );

        expect( estimate.total ).toBeGreaterThan( estimate.withLongestQuestion );
        expect( estimate.withLongestQuestion ).toBeGreaterThan( 400 );
    } );

    it( 'fails explicitly with InputLimitError instead of truncating', () =>
    {
        const request = { input : 'a'.repeat( 4000 ), questions };

        expect( () => assertDecisionInputLimit( 'p', request, { maxTokens : 100 } ) ).toThrow( InputLimitError );
        expect( () => assertDecisionInputLimit( 'p', request, { maxContextTokens : 100 } ) ).toThrow( /longest question/ );
        expect( () => assertDecisionInputLimit( 'p', request, { maxTokens : 100_000, maxContextTokens : 100_000 } ) ).not.toThrow();
        expect( () => assertDecisionInputLimit( 'p', request, {} ) ).not.toThrow();
        expect( request.input ).toHaveLength( 4000 );
    } );

    it( 'handles structured input', () =>
    {
        expect( () => assertDecisionInputLimit( 'p', { input : { big : 'z'.repeat( 4000 ) }, questions }, { maxTokens : 100 } ) )
            .toThrow( InputLimitError );
    } );
} );

describe( 'answer helpers', () =>
{
    it( 'builds a choice answer with argmax value and a per-label record', () =>
    {
        const q = question.choice( [ 'a', 'b', 'c' ] );
        const answer = buildChoiceAnswer( q, [ 0.1, 0.7, 0.2 ], 0.6 );

        expect( answer ).toEqual( { type : 'choice', value : 'b', probabilities : { a : 0.1, b : 0.7, c : 0.2 }, confidence : 0.6 } );
        expect( buildChoiceAnswer( q, [ 0.5, 0.5, 0 ], 0.1 ).value ).toBe( 'a' );
        expect( buildChoiceAnswer( q, [ 0.1, 0.7, 0.2 ], 0.6, 'c' ).value ).toBe( 'c' );
    } );

    it( 'builds score and yes/no answers', () =>
    {
        expect( buildScoreAnswer( [ 0, 0.95, 0.05 ], 0.9 ) ).toMatchObject( { type : 'score', value : 1.05, confidence : 0.9 } );
        expect( buildScoreAnswer( [ 1, 0 ], 0.5, 0.3 ).value ).toBe( 0.3 );
        expect( buildYesNoAnswer( 0.95 ) ).toEqual( { type : 'yesNo', value : 0.95, probability : 0.95 } );
        expect( weightedLevel( [ 0.5, 0.5 ] ) ).toBe( 0.5 );
        expect( argmax( [ 1, 3, 2 ] ) ).toBe( 1 );
    } );

    it( 'normalizes probabilities and rejects bad ones', () =>
    {
        expect( normalizeProbabilities( 'p', 'x', [ 1, 1 ] ) ).toEqual( [ 0.5, 0.5 ] );
        expect( () => normalizeProbabilities( 'p', 'x', [ 0, 0 ] ) ).toThrow( ProviderError );
        expect( toProbability( 'p', 'x', 1 + 1e-9 ) ).toBe( 1 );
        expect( toProbability( 'p', 'x', -1e-9 ) ).toBe( 0 );
        expect( () => toProbability( 'p', 'x', 1.2 ) ).toThrow( ProviderError );
        expect( () => toProbability( 'p', 'x', Number.NaN ) ).toThrow( ProviderError );
        expect( () => toProbability( 'p', 'x', '0.5' ) ).toThrow( ProviderError );
    } );
} );
