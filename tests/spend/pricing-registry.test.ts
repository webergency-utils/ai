import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
    PricingRegistry, 
    LocalPricingRegistry, 
    type PricingChangeEvent 
} from '../../src/spend/index.js';

describe( 'PricingRegistry Events & Local Registry', () => 
{
    beforeEach( () => 
    {
        vi.useFakeTimers();
    } );

    afterEach( () => 
    {
        vi.restoreAllMocks();
    } );

    it( 'should emit change event when a new model is registered', () => 
    {
        const registry = new PricingRegistry();
        const events: PricingChangeEvent[] = [];

        const unsubscribe = registry.on( 'change', ( e ) => 
        {
            events.push( e );
        } );

        registry.register( 'custom-vision-v1', {
            inputPerMillion  : 1.0,
            outputPerMillion : 2.0
        } );

        expect( events ).toHaveLength( 1 );
        expect( events[ 0 ].model ).toBe( 'custom-vision-v1' );
        expect( events[ 0 ].previous ).toBeUndefined();
        expect( events[ 0 ].current.inputPerMillion ).toBe( 1.0 );
        expect( events[ 0 ].current.outputPerMillion ).toBe( 2.0 );

        unsubscribe();
    } );

    it( 'should emit change event when an existing model price is updated', () => 
    {
        const registry = new PricingRegistry();
        const events: PricingChangeEvent[] = [];

        registry.on( 'change', ( e ) => 
        {
            events.push( e );
        } );

        const oldGpt4o = registry.get( 'gpt-4o' );

        expect( oldGpt4o ).toBeDefined();

        registry.register( 'gpt-4o', {
            inputPerMillion  : 2.0,
            outputPerMillion : 8.0
        } );

        expect( events ).toHaveLength( 1 );
        expect( events[ 0 ].model ).toBe( 'gpt-4o' );
        expect( events[ 0 ].previous?.inputPerMillion ).toBe( 2.50 );
        expect( events[ 0 ].current.inputPerMillion ).toBe( 2.0 );
        expect( events[ 0 ].current.outputPerMillion ).toBe( 8.0 );
    } );

    it( 'should not emit change event if pricing values are identical', () => 
    {
        const registry = new PricingRegistry();
        let callCount = 0;

        registry.on( 'change', () => 
        {
            callCount++;
        } );

        const currentGpt4o = registry.get( 'gpt-4o' )!;

        registry.register( 'gpt-4o', { ...currentGpt4o } );

        expect( callCount ).toBe( 0 );
    } );

    it( 'should stop receiving events after off() or returned unsubscribe', () => 
    {
        const registry = new PricingRegistry();
        let callCount = 0;

        const listener = (): void => 
        {
            callCount++;
        };

        const unsubscribe = registry.on( 'change', listener );

        registry.register( 'model-a', { inputPerMillion : 1, outputPerMillion : 2 } );
        expect( callCount ).toBe( 1 );

        unsubscribe();

        registry.register( 'model-b', { inputPerMillion : 1, outputPerMillion : 2 } );
        expect( callCount ).toBe( 1 );

        registry.on( 'change', listener );
        registry.register( 'model-c', { inputPerMillion : 1, outputPerMillion : 2 } );
        expect( callCount ).toBe( 2 );

        registry.off( 'change', listener );
        registry.register( 'model-d', { inputPerMillion : 1, outputPerMillion : 2 } );
        expect( callCount ).toBe( 2 );
    } );

    it( 'should support updateMany and return getAll map', () => 
    {
        const registry = new PricingRegistry();
        const changedModels: string[] = [];

        registry.on( 'change', ( e ) => 
        {
            changedModels.push( e.model );
        } );

        registry.updateMany( {
            'custom-a' : { inputPerMillion : 0.5, outputPerMillion : 1.5 },
            'custom-b' : { inputPerMillion : 0.8, outputPerMillion : 2.4 }
        } );

        expect( changedModels ).toEqual( [ 'custom-a', 'custom-b' ] );

        const all = registry.getAll();

        expect( all[ 'custom-a' ] ).toBeDefined();
        expect( all[ 'custom-b' ] ).toBeDefined();
        expect( all[ 'gpt-4o' ] ).toBeDefined();
    } );

    it( 'should allow LocalPricingRegistry to update and refresh via user updater', async() => 
    {
        let mockCounter = 1;
        const events: PricingChangeEvent[] = [];

        const localRegistry = new LocalPricingRegistry( {
            updater : async() => 
            {
                mockCounter++;

                return {
                    'local-llm' : {
                        inputPerMillion  : mockCounter * 1.0,
                        outputPerMillion : mockCounter * 2.0
                    }
                };
            }
        } );

        localRegistry.on( 'change', ( e ) => 
        {
            events.push( e );
        } );

        // Initial manual update
        localRegistry.update( 'local-llm', { inputPerMillion : 1.0, outputPerMillion : 2.0 } );
        expect( events ).toHaveLength( 1 );
        expect( events[ 0 ].current.inputPerMillion ).toBe( 1.0 );

        // Refresh via user updater
        await localRegistry.refresh();
        expect( events ).toHaveLength( 2 );
        expect( events[ 1 ].current.inputPerMillion ).toBe( 2.0 );
        expect( localRegistry.get( 'local-llm' )?.inputPerMillion ).toBe( 2.0 );
    } );

    it( 'should handle periodic auto-refresh in LocalPricingRegistry', async() => 
    {
        let refreshCount = 0;

        const localRegistry = new LocalPricingRegistry( {
            refreshIntervalMs : 5_000,
            updater           : () => 
            {
                refreshCount++;

                return {
                    'periodic-model' : {
                        inputPerMillion  : refreshCount,
                        outputPerMillion : refreshCount * 2
                    }
                };
            }
        } );

        localRegistry.startAutoRefresh();

        expect( refreshCount ).toBe( 0 );

        // Advance 5 seconds
        await vi.advanceTimersByTimeAsync( 5_000 );
        expect( refreshCount ).toBe( 1 );

        // Advance another 10 seconds
        await vi.advanceTimersByTimeAsync( 10_000 );
        expect( refreshCount ).toBe( 3 );

        localRegistry.stopAutoRefresh();

        // Advance time after stop
        await vi.advanceTimersByTimeAsync( 10_000 );
        expect( refreshCount ).toBe( 3 );
    } );

    it( 'should invoke onError callback in LocalPricingRegistry on refresh failure', async() => 
    {
        let capturedError: unknown;

        const localRegistry = new LocalPricingRegistry( {
            updater : () => 
            {
                throw new Error( 'Simulated updater network timeout' );
            },
            onError : ( err ) => 
            {
                capturedError = err;
            }
        } );

        await localRegistry.refresh();

        expect( capturedError ).toBeDefined();
        expect( ( capturedError as Error ).message ).toBe( 'Simulated updater network timeout' );
    } );
} );
