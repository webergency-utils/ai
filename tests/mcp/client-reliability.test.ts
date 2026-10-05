import { describe, it, expect, vi, afterEach } from 'vitest';
import 
{
    MCPClient,
    MCPServer,
    InMemoryTransport
} from '../../src/mcp/index.js';
import { AIError } from '../../src/core/error.js';
import { SpendTracker } from '../../src/spend/index.js';
import { schema } from '../../src/core/index.js';
import type { JSONRPCMessage, JSONRPCRequest } from '../../src/mcp/types.js';

afterEach( () => 
{
    vi.useRealTimers();
} );

async function connectWithHangingServer( 
    clientTransport: InMemoryTransport, 
    serverTransport: InMemoryTransport,
    options: { answerInitialize?: boolean } = {}
): Promise<MCPClient>
{
    await clientTransport.connect();
    await serverTransport.connect();

    const answerInitialize = options.answerInitialize !== false;

    serverTransport.onMessage( async ( message ) => 
    {
        if( 
            answerInitialize && 
            'method' in message && 
            message.method === 'initialize' && 
            'id' in message 
        )
        {
            await serverTransport.send( {
                jsonrpc : '2.0',
                id      : message.id,
                result  : {
                    protocolVersion : '2024-11-05',
                    capabilities    : { tools : {} },
                    serverInfo      : { name : 't', version : '0' }
                }
            } );
        }
    } );

    const client = new MCPClient( clientTransport, { timeoutMs : 60_000 } );
    await client.connect();

    return client;
}

describe( 'MCP client reliability (U8)', () => 
{
    it( 'times out pending requests and sends notifications/cancelled except initialize (R40)', async () => 
    {
        vi.useFakeTimers();

        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        await clientTransport.connect();
        await serverTransport.connect();

        const sent: JSONRPCMessage[] = [];
        const realSend = clientTransport.send.bind( clientTransport );
        clientTransport.send = async ( message ) => 
        {
            sent.push( message );
            await realSend( message );
        };

        // Never answer — hang through initialize timeout
        serverTransport.onMessage( () => 
        {
            /* no reply */
        } );

        const client = new MCPClient( clientTransport, { timeoutMs : 1_000 } );
        const connectPromise = client.connect();
        const connectAssert = expect( connectPromise ).rejects.toMatchObject( {
            code : 'MCP_REQUEST_TIMEOUT'
        } );

        await vi.advanceTimersByTimeAsync( 1_000 );
        await connectAssert;

        expect( sent.some( ( m ) => 
        {
            return 'method' in m && m.method === 'notifications/cancelled';
        } ) ).toBe( false );

        // Now exercise cancel on a non-initialize method
        const [ t1, t2 ] = InMemoryTransport.createPair();
        await t1.connect();
        await t2.connect();

        const hangSent: JSONRPCMessage[] = [];
        const hangSend = t1.send.bind( t1 );
        t1.send = async ( message ) => 
        {
            hangSent.push( message );
            await hangSend( message );
        };

        t2.onMessage( async ( message ) => 
        {
            if( 'method' in message && message.method === 'initialize' && 'id' in message )
            {
                await t2.send( {
                    jsonrpc : '2.0',
                    id      : ( message as JSONRPCRequest ).id,
                    result  : {
                        protocolVersion : '2024-11-05',
                        capabilities    : { tools : {} },
                        serverInfo      : { name : 'hang', version : '0' }
                    }
                } );
            }
            // tools/list intentionally unanswered
        } );

        const hangingClient = new MCPClient( t1, { timeoutMs : 500 } );
        await hangingClient.connect();

        const listPromise = hangingClient.listTools();
        const listAssert = expect( listPromise ).rejects.toMatchObject( {
            code : 'MCP_REQUEST_TIMEOUT'
        } );

        await vi.advanceTimersByTimeAsync( 500 );
        await listAssert;

        expect( hangSent.some( ( m ) => 
        {
            return 'method' in m && m.method === 'notifications/cancelled';
        } ) ).toBe( true );
    } );

    it( 'rejects pending requests when close() is called (R41)', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const client = await connectWithHangingServer( clientTransport, serverTransport );

        const pending = client.listTools();
        await client.close();

        await expect( pending ).rejects.toBeInstanceOf( AIError );
        await expect( pending ).rejects.toMatchObject( { code : 'MCP_CLIENT_CLOSED' } );
    } );

    it( 'rejects pending requests when the transport dies (R58)', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const client = await connectWithHangingServer( clientTransport, serverTransport );

        const pending = client.listTools();
        clientTransport.simulateDeath();

        await expect( pending ).rejects.toMatchObject( { code : 'MCP_TRANSPORT_CLOSED' } );
    } );

    it( 'routes server tool spend to the server tracker (R30)', async () => 
    {
        const [ clientTransport, serverTransport ] = InMemoryTransport.createPair();
        const tracker = new SpendTracker();
        const server = new MCPServer( { tracker } );

        server.registerTool( {
            name        : 'billable',
            description : 'Reports spend',
            parameters  : schema.object( {} )
        }, async ( _args, ctx ) => 
        {
            ctx?.reportSpend( {
                category    : 'tools',
                subcategory : 'billable',
                units       : 1,
                unitType    : 'call',
                costUSD     : 0.42
            } );

            return 'ok';
        } );

        const client = new MCPClient( clientTransport );
        await server.connect( serverTransport );
        await client.connect();

        await client.callTool( 'billable', {} );

        expect( tracker.getCategorySpend( 'tools' ) ).toBeCloseTo( 0.42, 4 );

        await client.close();
        await serverTransport.close();
    } );
} );
