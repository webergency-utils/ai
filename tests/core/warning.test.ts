import { describe, it, expect } from 'vitest';
import { WarningEmitter } from '../../src/core/warning.js';
import { CancelledError, TimeoutError, BudgetRefusedError } from '../../src/core/error.js';

describe( 'WarningEmitter', () => 
{
    it( 'delivers events to subscribers', () => 
    {
        const emitter = new WarningEmitter();
        const seen: string[] = [];

        emitter.on( ( event ) => 
        {
            seen.push( event.code );
        } );

        emitter.emit( { code : 'unpriced_usage', message : 'no price' } );

        expect( seen ).toEqual( [ 'unpriced_usage' ] );
    } );

    it( 'unsubscribe stops delivery', () => 
    {
        const emitter = new WarningEmitter();
        const seen: string[] = [];
        const off = emitter.on( ( event ) => 
        {
            seen.push( event.code );
        } );

        off();
        emitter.emit( { code : 'budget_threshold', message : 'warn' } );

        expect( seen ).toEqual( [] );
    } );

    it( 'listener throw does not break other listeners', () => 
    {
        const emitter = new WarningEmitter();
        const seen: string[] = [];

        emitter.on( () => 
        {
            throw new Error( 'boom' );
        } );
        emitter.on( ( event ) => 
        {
            seen.push( event.code );
        } );

        emitter.emit( { code : 'trace_dropped', message : 'dropped' } );

        expect( seen ).toEqual( [ 'trace_dropped' ] );
    } );
} );

describe( 'New AIError subclasses', () => 
{
    it( 'CancelledError carries cause from signal.reason', () => 
    {
        const reason = new Error( 'user aborted' );
        const err = new CancelledError( 'Operation cancelled', reason );

        expect( err.name ).toBe( 'CancelledError' );
        expect( err.code ).toBe( 'CANCELLED' );
        expect( err.cause ).toBe( reason );
    } );

    it( 'TimeoutError records phase and timeoutMs', () => 
    {
        const err = new TimeoutError( 'idle timeout', 'idle', 60_000, 2 );

        expect( err.code ).toBe( 'TIMEOUT' );
        expect( err.phase ).toBe( 'idle' );
        expect( err.timeoutMs ).toBe( 60_000 );
        expect( err.attempt ).toBe( 2 );
    } );

    it( 'BudgetRefusedError distinguishes unpriced from exhausted', () => 
    {
        const unpriced = new BudgetRefusedError( 
            'unpriced', 
            'Cannot enforce budget for model x', 
            { provider : 'openai', model : 'x' } 
        );
        const exhausted = new BudgetRefusedError( 'exhausted', 'Budget used up' );

        expect( unpriced.code ).toBe( 'UNPRICED_MODEL' );
        expect( unpriced.reason ).toBe( 'unpriced' );
        expect( exhausted.code ).toBe( 'BUDGET_REFUSED' );
        expect( exhausted.reason ).toBe( 'exhausted' );
    } );
} );

describe( 'HTTP helpers', () => 
{
    it( 'jsonResponse builds a real Response with headers', async () => 
    {
        const { jsonResponse } = await import( '../helpers/http.js' );
        const response = jsonResponse( { ok : true }, {
            status  : 429,
            headers : { 'retry-after' : 'Fri, 31 Dec 1999 23:59:59 GMT' }
        } );

        expect( response ).toBeInstanceOf( Response );
        expect( response.status ).toBe( 429 );
        expect( response.headers.get( 'retry-after' ) ).toBe( 'Fri, 31 Dec 1999 23:59:59 GMT' );

        const body = await response.json();

        expect( body ).toEqual( { ok : true } );
    } );
} );
