import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { 
    createTool, 
    SimpleExecutionContext, 
    type CategorySpendInput 
} from '../../src/index.js';

describe( 'Ambient ExecutionContext & Tool Reporter Hooks (U2)', () => 
{
    it( 'should allow tools to report spend ambiently without modifying return value', async() => 
    {
        const reported: CategorySpendInput[] = [];

        const context = new SimpleExecutionContext( {
            threadId : 'thread-123',
            agentId  : 'agent-abc',
            onSpend  : ( entry ) => 
            {
                reported.push( entry );
            }
        } );

        const searchTool = createTool( {
            name        : 'web_search',
            description : 'Performs web search and incurs third-party API spend',
            parameters  : z.object( {
                query : z.string()
            } ),
            execute : async( args, ctx ) => 
            {
                ctx?.reportSpend( {
                    category    : 'tools',
                    subcategory : 'serp_api',
                    costUSD     : 0.005,
                    metadata    : { query : args.query }
                } );

                return {
                    results : [ `Top result for ${ args.query }` ]
                };
            }
        } );

        // Execute tool with ambient context
        const result = await searchTool.run( { query : 'typescript 5.8' }, context );

        // Business return value is completely preserved
        expect( result ).toEqual( {
            results : [ 'Top result for typescript 5.8' ]
        } );

        // Spend was reported ambiently
        expect( reported ).toHaveLength( 1 );
        expect( reported[ 0 ].category ).toBe( 'tools' );
        expect( reported[ 0 ].subcategory ).toBe( 'serp_api' );
        expect( reported[ 0 ].costUSD ).toBe( 0.005 );
    } );

    it( 'should remain fully backwards compatible when executed without context', async() => 
    {
        const addTool = createTool( {
            name        : 'add',
            description : 'Add two numbers',
            parameters  : z.object( {
                a : z.number(),
                b : z.number()
            } ),
            execute : async( { a, b }, ctx ) => 
            {
                // ctx may be undefined
                ctx?.reportSpend( { category : 'compute', costUSD : 0.0001 } );

                return a + b;
            }
        } );

        const sum = await addTool.run( { a : 10, b : 20 } );

        expect( sum ).toBe( 30 );
    } );
} );
