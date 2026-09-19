import { describe, it, expect } from 'vitest';
import { CheckpointManager } from '../../src/agent/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import type { ChatMessage } from '../../src/core/types.js';

describe( 'Durable Checkpoint Manager', () => 
{
    it( 'should persist step transitions and retrieve the latest checkpoint', async () => 
    {
        const store = new MemoryDocStore();
        const manager = new CheckpointManager( store );

        const msg1: ChatMessage = { role : 'user', content : 'Deploy project' };
        const cp0 = await manager.saveCheckpoint( 'thread-1', 0, [ msg1 ], { status : 'started' }, 0.001 );

        expect( cp0.stepIndex ).toBe( 0 );
        expect( cp0.spendUSD ).toBe( 0.001 );

        const msg2: ChatMessage = { 
            role      : 'assistant', 
            content   : 'Calling deployment tool',
            toolCalls : [ { id : 'c1', name : 'deploy', arguments : { env : 'prod' } } ]
        };

        const cp1 = await manager.saveCheckpoint( 
            'thread-1', 
            1, 
            [ msg1, msg2 ], 
            { status : 'tool_invoked', tool : 'deploy' }, 
            0.0025 
        );

        const latest = await manager.getLatestCheckpoint( 'thread-1' );
        expect( latest ).toBeDefined();
        expect( latest?.stepIndex ).toBe( 1 );
        expect( latest?.id ).toBe( cp1.id );
        expect( latest?.messages ).toHaveLength( 2 );
        expect( latest?.state ).toEqual( { status : 'tool_invoked', tool : 'deploy' } );

        const history = await manager.listCheckpoints( 'thread-1' );
        expect( history ).toHaveLength( 2 );
        expect( history[0].stepIndex ).toBe( 0 );
        expect( history[1].stepIndex ).toBe( 1 );
    } );

    it( 'should recover previous state after a tool crash', async () => 
    {
        const store = new MemoryDocStore();
        const manager = new CheckpointManager( store );
        const threadId = 'crash-thread';

        // Step 1: Tool 1 completes successfully and is checkpointed
        const history: ChatMessage[] = 
            [
                { role : 'user', content : 'Process 2 items' },
                { 
                    role      : 'assistant', 
                    content   : 'Processing item 1',
                    toolCalls : [ { id : 'call_1', name : 'process_item', arguments : { item : 1 } } ]
                },
                { role : 'tool', toolCallId : 'call_1', content : 'Item 1 processed' }
            ];

        await manager.saveCheckpoint( threadId, 1, history, { processed : [ 1 ] }, 0.005 );

        // Step 2: Tool 2 throws an error/crash during execution before checkpoint
        try
        {
            throw new Error( 'Fatal crash while running Item 2' );
        }
        catch
        {
            // Execution terminates unexpectedly
        }

        // On restart, recover latest checkpoint
        const recovered = await manager.getLatestCheckpoint( threadId );
        expect( recovered ).toBeDefined();
        expect( recovered?.stepIndex ).toBe( 1 );
        expect( recovered?.state ).toEqual( { processed : [ 1 ] } );
        expect( recovered?.messages ).toHaveLength( 3 );
        expect( recovered?.messages[2].content ).toBe( 'Item 1 processed' );
    } );
} );
