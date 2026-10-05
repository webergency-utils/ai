import { describe, it, expect } from 'vitest';
import 
{
    SpendTracker,
    UnitCostRegistry,
    type SpendWarningEvent
} from '../../src/spend/index.js';

describe( 'SpendTracker Multi-Category & Budget Enforcement', () => 
{
    it( 'should aggregate both model and non-model category spend', () => 
    {
        const tracker = new SpendTracker();

        // Model spend
        tracker.record( 'gpt-4o-mini', {
            promptTokens     : 10_000,
            completionTokens : 5_000,
            totalTokens      : 15_000
        } );

        // Direct USD storage spend
        tracker.recordCategorySpend( {
            category    : 'storage',
            subcategory : 'document_write',
            costUSD     : 0.002
        } );

        // Raw unit compute spend (resolved via default registry: compute:seconds = $0.00005)
        tracker.recordCategorySpend( {
            category    : 'compute',
            subcategory : 'seconds',
            units       : 100,
            unitType    : 'seconds'
        } );

        expect( tracker.totalSpendUSD ).toBeGreaterThan( 0.007 );
        expect( tracker.getCategorySpend( 'model' ) ).toBeGreaterThan( 0 );
        expect( tracker.getCategorySpend( 'storage' ) ).toBe( 0.002 );
        expect( tracker.getCategorySpend( 'compute' ) ).toBe( 0.005 );
        expect( tracker.getCategorySpend( 'network' ) ).toBe( 0 );

        const breakdown = tracker.categorySpend;

        expect( breakdown.model ).toBeGreaterThan( 0 );
        expect( breakdown.storage ).toBe( 0.002 );
        expect( breakdown.compute ).toBe( 0.005 );
    } );

    it( 'should warn when category-specific budget ceilings are crossed (R48/R49)', () => 
    {
        const tracker = new SpendTracker( {
            maxBudgetUSD    : 10.00,
            categoryBudgets : {
                compute : 1.00
            }
        } );
        const warnings: Array<{ code: string, category: string }> = [];

        tracker.on( 'warning', ( e ) => 
        {
            warnings.push( e );
        } );

        // Storage spend under total limit
        tracker.recordCategorySpend( {
            category : 'storage',
            costUSD  : 2.00
        } );

        expect( tracker.totalSpendUSD ).toBe( 2.00 );

        // Compute spend nearing limit
        tracker.recordCategorySpend( {
            category : 'compute',
            costUSD  : 0.80
        } );

        expect( tracker.totalSpendUSD ).toBe( 2.80 );

        // Crossing compute category ceiling — warn, do not throw
        tracker.recordCategorySpend( {
            category : 'compute',
            costUSD  : 0.25
        } );

        expect( tracker.getCategorySpend( 'compute' ) ).toBe( 1.05 );
        expect( warnings.some( ( w ) => 
        {
            return w.code === 'budget_exceeded' && w.category === 'compute';
        } ) ).toBe( true );
    } );


    it( 'should emit warning events when reaching 80% threshold without halting', () => 
    {
        const tracker = new SpendTracker( {
            maxBudgetUSD     : 1.00,
            warningThreshold : 0.8
        } );

        const warnings: SpendWarningEvent[] = [];

        tracker.on( 'warning', ( event ) => 
        {
            warnings.push( event );
        } );

        // Record 50% - should not trigger warning
        tracker.recordCategorySpend( {
            category : 'tools',
            costUSD  : 0.50
        } );

        expect( warnings ).toHaveLength( 0 );

        // Record another 35% (total 85%) - should trigger warning
        tracker.recordCategorySpend( {
            category : 'tools',
            costUSD  : 0.35
        } );

        expect( warnings ).toHaveLength( 1 );
        expect( warnings[ 0 ].category ).toBe( 'total' );
        expect( warnings[ 0 ].threshold ).toBe( 0.8 );
        expect( warnings[ 0 ].currentSpend ).toBeCloseTo( 0.85, 4 );
        expect( warnings[ 0 ].budgetLimit ).toBe( 1.00 );
    } );

    it( 'should emit category-specific warning events', () => 
    {
        const tracker = new SpendTracker( {
            categoryBudgets : {
                mcp : 0.50
            },
            warningThreshold : 0.8
        } );

        const warnings: SpendWarningEvent[] = [];

        tracker.on( 'warning', ( event ) => 
        {
            warnings.push( event );
        } );

        tracker.recordCategorySpend( {
            category : 'mcp',
            costUSD  : 0.42
        } );

        expect( warnings ).toHaveLength( 1 );
        expect( warnings[ 0 ].category ).toBe( 'mcp' );
        expect( warnings[ 0 ].currentSpend ).toBe( 0.42 );
        expect( warnings[ 0 ].budgetLimit ).toBe( 0.50 );
    } );

    it( 'should support custom UnitCostRegistry injection', () => 
    {
        const registry = new UnitCostRegistry();

        registry.register( 'custom:worker_job', 0.05 );

        const tracker = new SpendTracker( {
            unitPricingRegistry : registry
        } );

        tracker.recordCategorySpend( {
            category    : 'custom',
            subcategory : 'worker_job',
            units       : 4
        } );

        expect( tracker.getCategorySpend( 'custom' ) ).toBe( 0.20 );
        expect( tracker.categoryRecords ).toHaveLength( 1 );
        expect( tracker.categoryRecords[ 0 ].costUSD ).toBe( 0.20 );
    } );

    it( 'should manage isolated thread trackers with category budgets', () => 
    {
        const tracker = new SpendTracker( {
            categoryBudgets : {
                storage : 1.00
            }
        } );

        const thread1 = tracker.getThreadTracker( 't-1' );
        const thread2 = tracker.getThreadTracker( 't-2' );

        thread1.recordCategorySpend( {
            category : 'storage',
            costUSD  : 0.50
        } );

        expect( thread1.getCategorySpend( 'storage' ) ).toBe( 0.50 );
        expect( thread2.getCategorySpend( 'storage' ) ).toBe( 0 );
        expect( tracker.getCategorySpend( 'storage' ) ).toBe( 0 );
    } );

    it( 'should clear category spends on reset', () => 
    {
        const tracker = new SpendTracker();

        tracker.recordCategorySpend( { category : 'tools', costUSD : 0.50 } );
        expect( tracker.getCategorySpend( 'tools' ) ).toBe( 0.50 );

        tracker.reset();

        expect( tracker.totalSpendUSD ).toBe( 0 );
        expect( tracker.getCategorySpend( 'tools' ) ).toBe( 0 );
        expect( tracker.categoryRecords ).toHaveLength( 0 );
    } );
} );
