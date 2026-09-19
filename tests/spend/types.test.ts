import { describe, it, expect } from 'vitest';
import type { 
    SpendCategory, 
    CategorySpendInput, 
    CategorySpendRecord 
} from '../../src/spend/types.js';

describe( 'Telemetry Types & Data Contracts (U1)', () => 
{
    it( 'should support valid spend categories and category inputs', () => 
    {
        const validCategories: SpendCategory[] = [
            'model',
            'storage',
            'compute',
            'network',
            'mcp',
            'tools',
            'custom'
        ];

        expect( validCategories ).toHaveLength( 7 );

        const input: CategorySpendInput = {
            category    : 'storage',
            subcategory : 'vector_query',
            units       : 10,
            unitType    : 'query',
            metadata    : { index : 'chunk-embeddings' }
        };

        expect( input.category ).toBe( 'storage' );
        expect( input.units ).toBe( 10 );
    } );

    it( 'should structure full category spend records', () => 
    {
        const record: CategorySpendRecord = {
            id          : 'rec-123',
            timestamp   : 1700000000000,
            category    : 'tools',
            subcategory : 'web_search',
            costUSD     : 0.005,
            threadId    : 'thread-42',
            agentId     : 'agent-1',
            metadata    : { query : 'news' }
        };

        expect( record.id ).toBe( 'rec-123' );
        expect( record.costUSD ).toBe( 0.005 );
        expect( record.threadId ).toBe( 'thread-42' );
    } );
} );
