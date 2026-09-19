import { describe, it, expect } from 'vitest';
import 
{
    UnitCostRegistry,
    DEFAULT_UNIT_PRICING,
    type UnitCostChangeEvent
} from '../../src/spend/index.js';

describe( 'UnitCostRegistry', () => 
{
    it( 'should initialize with default rates', () => 
    {
        const registry = new UnitCostRegistry();

        expect( registry.get( 'storage:vector_query' ) ).toBe( DEFAULT_UNIT_PRICING[ 'storage:vector_query' ] );
        expect( registry.get( 'compute:sandbox_sec' ) ).toBe( 0.00005 );
        expect( registry.get( 'network:bytes' ) ).toBe( 0.00000000009 );
    } );

    it( 'should resolve cost using default rates', () => 
    {
        const registry = new UnitCostRegistry();

        const cost = registry.resolveCost( {
            category    : 'storage',
            subcategory : 'vector_query',
            units       : 50,
            unitType    : 'queries'
        } );

        expect( cost ).toBe( 50 * 0.0001 );
    } );

    it( 'should prioritize explicit costUSD over unit rate', () => 
    {
        const registry = new UnitCostRegistry();

        const cost = registry.resolveCost( {
            category    : 'tools',
            subcategory : 'web_search',
            costUSD     : 0.0125,
            units       : 1,
            unitType    : 'operations'
        } );

        expect( cost ).toBe( 0.0125 );
    } );

    it( 'should return 0 when units are missing or non-positive', () => 
    {
        const registry = new UnitCostRegistry();

        expect( registry.resolveCost( { category : 'storage' } ) ).toBe( 0 );
        expect( registry.resolveCost( { category : 'storage', units : 0 } ) ).toBe( 0 );
        expect( registry.resolveCost( { category : 'storage', units : -5 } ) ).toBe( 0 );
    } );

    it( 'should emit change events when rates are added or updated', () => 
    {
        const registry = new UnitCostRegistry();
        const events: UnitCostChangeEvent[] = [];

        const unsubscribe = registry.on( 'change', ( event ) => 
        {
            events.push( event );
        } );

        registry.register( 'storage:custom_op', 0.005 );

        expect( events ).toHaveLength( 1 );
        expect( events[ 0 ].key ).toBe( 'storage:custom_op' );
        expect( events[ 0 ].previous ).toBeUndefined();
        expect( events[ 0 ].current ).toBe( 0.005 );

        // Update existing rate
        registry.register( 'storage:custom_op', 0.008 );

        expect( events ).toHaveLength( 2 );
        expect( events[ 1 ].previous ).toBe( 0.005 );
        expect( events[ 1 ].current ).toBe( 0.008 );

        unsubscribe();
        registry.register( 'storage:custom_op', 0.01 );
        expect( events ).toHaveLength( 2 );
    } );

    it( 'should support registerRule and complex key matching', () => 
    {
        const registry = new UnitCostRegistry();

        registry.registerRule( {
            category    : 'compute',
            subcategory : 'wasm_sandbox',
            unitType    : 'durationMs',
            ratePerUnit : 0.000001
        } );

        const cost = registry.resolveCost( {
            category    : 'compute',
            subcategory : 'wasm_sandbox',
            unitType    : 'durationMs',
            units       : 1000
        } );

        expect( cost ).toBe( 0.001 );
    } );

    it( 'should support updateMany and getAll', () => 
    {
        const registry = new UnitCostRegistry();

        registry.updateMany( {
            'custom:api_call'   : 0.02,
            'custom:batch_job'  : 0.50
        } );

        expect( registry.get( 'custom:api_call' ) ).toBe( 0.02 );
        expect( registry.get( 'custom:batch_job' ) ).toBe( 0.50 );

        const all = registry.getAll();

        expect( all[ 'custom:api_call' ] ).toBe( 0.02 );
        expect( all[ 'storage:vector_query' ] ).toBe( 0.0001 );
    } );

    it( 'should fallback to category-level rate when subcategory is unlisted', () => 
    {
        const registry = new UnitCostRegistry();

        registry.register( 'compute', 0.0002 );

        const cost = registry.resolveCost( {
            category    : 'compute',
            subcategory : 'unknown_task',
            units       : 10
        } );

        expect( cost ).toBe( 0.002 );
    } );
} );
