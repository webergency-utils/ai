import { describe, it, expect } from 'vitest';
import { Tool, createTool, JITToolRetriever } from '../../src/agent/index.js';
import { schema } from '../../src/core/index.js';
import { MemoryVectorStore } from '../../src/storage/index.js';
import { InvalidInputError } from '../../src/core/error.js';

describe( 'Tool & JIT Tool Retriever', () => 
{
    it( 'should validate tool input schemas using schema builder and execute', async () => 
    {
        const multiplyTool = createTool( 
            {
                name        : 'multiply',
                description : 'Multiply two numbers',
                parameters  : schema.object( 
                    {
                        x : schema.number(),
                        y : schema.number()
                    } ),
                execute : async ( args: { x : number, y : number } ) => 
                {
                    return args.x * args.y;
                }
            } );

        const result = await multiplyTool.run( { x : 6, y : 7 } );
        expect( result ).toBe( 42 );

        // Should reject invalid schema
        await expect( multiplyTool.run( { x : 'not-a-number', y : 7 } ) )
            .rejects
            .toThrow( InvalidInputError );
    } );

    it( 'should index multiple tools and retrieve relevant subset for context limits', async () => 
    {
        const vectorStore = new MemoryVectorStore();
        const retriever = new JITToolRetriever( { vectorStore } );

        const weatherTool = new Tool( 
            {
                name        : 'get_weather',
                description : 'Retrieve current atmospheric temperature and rain forecast',
                parameters  : { type : 'object', properties : {} },
                execute     : async () => {return 'Sunny';}
            } );

        const databaseTool = new Tool( 
            {
                name        : 'query_database',
                description : 'Execute SQL queries against customer database',
                parameters  : { type : 'object', properties : {} },
                execute     : async () => {return [];}
            } );

        const calendarTool = new Tool( 
            {
                name        : 'schedule_meeting',
                description : 'Book meetings and check calendar availability',
                parameters  : { type : 'object', properties : {} },
                execute     : async () => {return true;}
            } );

        retriever.registerTools( [ weatherTool, databaseTool, calendarTool ] );
        await retriever.indexTools();

        expect( retriever.getTools() ).toHaveLength( 3 );

        // Querying for database/SQL
        const relevantForSQL = await retriever.retrieveTools( 'run SQL query on customer records', 1 );
        expect( relevantForSQL ).toHaveLength( 1 );
        expect( relevantForSQL[0].name ).toBe( 'query_database' );

        // Querying for weather/temperature
        const relevantForWeather = await retriever.retrieveTools( 'what is the weather temperature forecast', 1 );
        expect( relevantForWeather ).toHaveLength( 1 );
        expect( relevantForWeather[0].name ).toBe( 'get_weather' );
    } );
} );
