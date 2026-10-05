import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
    OpenRouterPricingSource, 
    LiteLLMPricingSource, 
    CustomHttpPricingSource, 
    PricingSyncService, 
    PricingRegistry 
} from '../../src/spend/index.js';

describe( 'Pricing Sync & Scraping Sources', () => 
{
    const originalFetch = globalThis.fetch;

    beforeEach( () => 
    {
        vi.useFakeTimers();
    } );

    afterEach( () => 
    {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    } );

    it( 'should parse OpenRouter models catalog and normalize to per-million pricing', async() => 
    {
        const mockResponse = {
            data : [
                {
                    id      : 'openai/gpt-4o',
                    pricing : {
                        prompt     : '0.0000025',
                        completion : '0.00001'
                    }
                },
                {
                    id      : 'anthropic/claude-3-5-sonnet',
                    pricing : {
                        prompt     : '0.000003',
                        completion : '0.000015'
                    }
                }
            ]
        };

        globalThis.fetch = vi.fn().mockResolvedValue( {
            ok   : true,
            json : async() => mockResponse
        } as unknown as Response );

        const source = new OpenRouterPricingSource( { apiKey : 'test-key' } );
        const pricing = await source.fetchPricing();

        expect( source.name ).toBe( 'openrouter' );
        expect( globalThis.fetch ).toHaveBeenCalledWith(
            'https://openrouter.ai/api/v1/models',
            expect.objectContaining( {
                method  : 'GET',
                headers : expect.objectContaining( {
                    'Authorization' : 'Bearer test-key'
                } )
            } )
        );

        // Canonical ID
        expect( pricing[ 'openai/gpt-4o' ] ).toEqual( {
            inputPerMillion  : 2.5,
            outputPerMillion : 10
        } );

        // Short ID alias
        expect( pricing[ 'gpt-4o' ] ).toEqual( {
            inputPerMillion  : 2.5,
            outputPerMillion : 10
        } );

        expect( pricing[ 'claude-3-5-sonnet' ] ).toEqual( {
            inputPerMillion  : 3,
            outputPerMillion : 15
        } );
    } );

    it( 'should throw on non-200 OpenRouter response', async() => 
    {
        globalThis.fetch = vi.fn().mockResolvedValue( {
            ok         : false,
            status     : 401,
            statusText : 'Unauthorized'
        } as unknown as Response );

        const source = new OpenRouterPricingSource();

        await expect( source.fetchPricing() ).rejects.toThrow( 'Failed to fetch OpenRouter models: 401 Unauthorized' );
    } );

    it( 'should parse LiteLLM community JSON price catalog', async() => 
    {
        const mockCatalog = {
            'gpt-4o' : {
                input_cost_per_token            : 0.0000025,
                output_cost_per_token           : 0.00001,
                cache_read_input_token_cost     : 0.00000125,
                output_cost_per_reasoning_token : 0.00002
            }
        };

        globalThis.fetch = vi.fn().mockResolvedValue( {
            ok   : true,
            json : async() => mockCatalog
        } as unknown as Response );

        const source = new LiteLLMPricingSource();
        const pricing = await source.fetchPricing();

        expect( source.name ).toBe( 'litellm' );
        expect( pricing[ 'gpt-4o' ] ).toEqual( {
            inputPerMillion     : 2.5,
            outputPerMillion    : 10,
            cacheReadPerMillion : 1.25,
            reasoningPerMillion : 20
        } );
    } );

    it( 'should support CustomHttpPricingSource with transform function', async() => 
    {
        const mockCustom = {
            items : [
                { name : 'my-llm', inCost : 1.2, outCost : 3.4 }
            ]
        };

        globalThis.fetch = vi.fn().mockResolvedValue( {
            ok   : true,
            json : async() => mockCustom
        } as unknown as Response );

        const source = new CustomHttpPricingSource( {
            url       : 'https://internal-billing.corp/pricing',
            transform : ( raw: unknown ) => 
            {
                const data = raw as { items: Array<{ name: string, inCost: number, outCost: number }> };
                const map: Record<string, { inputPerMillion: number, outputPerMillion: number }> = {};

                for( const item of data.items )
                {
                    map[ item.name ] = {
                        inputPerMillion  : item.inCost,
                        outputPerMillion : item.outCost
                    };
                }

                return map;
            }
        } );

        const pricing = await source.fetchPricing();

        expect( pricing[ 'my-llm' ] ).toEqual( {
            inputPerMillion  : 1.2,
            outputPerMillion : 3.4
        } );
    } );

    it( 'should synchronize pricing into registry and trigger change events', async() => 
    {
        const registry = new PricingRegistry();
        const events: string[] = [];

        registry.on( 'change', ( e ) => 
        {
            events.push( e.model );
        } );

        const mockSource = {
            name         : 'mock',
            fetchPricing : vi.fn().mockResolvedValue( {
                'new-model' : { inputPerMillion : 5, outputPerMillion : 10 }
            } )
        };

        const syncService = new PricingSyncService( {
            registry,
            source : mockSource
        } );

        await syncService.sync();

        expect( registry.get( 'new-model' ) ).toEqual( { inputPerMillion : 5, outputPerMillion : 10 } );
        expect( events ).toContain( 'new-model' );
    } );

    it( 'should run periodic auto-sync and cleanly stop', async() => 
    {
        let syncCount = 0;
        const registry = new PricingRegistry();

        const mockSource = {
            name         : 'mock',
            fetchPricing : vi.fn().mockImplementation( async() => 
            {
                syncCount++;

                return {
                    'synced-model' : { inputPerMillion : syncCount, outputPerMillion : syncCount * 2 }
                };
            } )
        };

        const syncService = new PricingSyncService( {
            registry,
            source     : mockSource,
            intervalMs : 10_000
        } );

        syncService.startAutoSync();

        expect( syncCount ).toBe( 0 );

        // Advance 10s
        await vi.advanceTimersByTimeAsync( 10_000 );
        expect( syncCount ).toBe( 1 );

        // Advance 20s
        await vi.advanceTimersByTimeAsync( 20_000 );
        expect( syncCount ).toBe( 3 );

        syncService.stopAutoSync();

        // Advance further
        await vi.advanceTimersByTimeAsync( 20_000 );
        expect( syncCount ).toBe( 3 );
    } );

    it( 'should catch sync errors and report to onError without throwing', async() => 
    {
        let errorReported: unknown;
        const registry = new PricingRegistry();

        const mockSource = {
            name         : 'mock-fail',
            fetchPricing : vi.fn().mockRejectedValue( new Error( 'Network outage' ) )
        };

        const syncService = new PricingSyncService( {
            registry,
            source  : mockSource,
            onError : ( err ) => 
            {
                errorReported = err;
            }
        } );

        await syncService.sync();

        expect( errorReported ).toBeDefined();
        expect( ( errorReported as Error ).message ).toBe( 'Network outage' );
    } );
} );
