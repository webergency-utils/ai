import { it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointManager, CheckpointConflictError } from '../../src/agent/index.js';
import { AIError } from '../../src/core/error.js';
import type { IDocumentStore } from '../../src/storage/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { documentBackends } from './backends.js';
import { contractSuite } from './contract/shared.js';
import type { ContractHandle } from './contract/shared.js';

function save( manager: CheckpointManager, runId: string, sequence: number, threadId: string = 't1' )
{
    return manager.saveCheckpoint( {
        threadId,
        runId,
        sequence,
        stepIndex    : sequence,
        runStepCount : sequence,
        messages     : [ { role : 'user', content : `m${sequence}` } ],
        status       : 'running'
    } );
}

for( const backend of documentBackends )
{
    contractSuite( `Checkpoint latest-pointer CAS: ${backend.name}`, backend.options, () =>
    {
        let handle: ContractHandle<IDocumentStore>;
        let store: IDocumentStore;

        beforeEach( async () =>
        {
            handle = await backend.factory();
            store = handle.store;
        } );

        afterEach( async () =>
        {
            await handle.dispose?.();
        } );

        it( 'never regresses latest when sequences 3 and 2 race (AE7)', async () =>
        {
            const a = new CheckpointManager( store );
            const b = new CheckpointManager( store );
            const settled = await Promise.allSettled( [ save( a, 'run', 3 ), save( b, 'run', 2 ) ] );

            expect( ( await a.getLatestCheckpoint( 't1' ) )!.sequence ).toBe( 3 );

            for( const r of settled.filter( ( s ) => {return s.status === 'rejected';} ) )
            {
                expect( ( r as PromiseRejectedResult ).reason ).toBeInstanceOf( CheckpointConflictError );
                expect( ( ( r as PromiseRejectedResult ).reason as AIError ).code ).toBe( 'CHECKPOINT_CONFLICT' );
            }
        } );

        it( 'rejects a stale writer that arrives after a newer checkpoint', async () =>
        {
            const a = new CheckpointManager( store );
            const b = new CheckpointManager( store );

            await save( a, 'run', 3 );

            const err = await save( b, 'run', 2 ).then( () => {return null;}, ( e: unknown ) => {return e;} );

            expect( err ).toBeInstanceOf( CheckpointConflictError );
            expect( ( err as AIError ).code ).toBe( 'CHECKPOINT_CONFLICT' );
            expect( ( await a.getLatestCheckpoint( 't1' ) )!.sequence ).toBe( 3 );
        } );

        it( 'rejects a repeat of the same sequence', async () =>
        {
            const a = new CheckpointManager( store );

            await save( a, 'run', 1 );
            await expect( save( a, 'run', 1 ) ).rejects.toBeInstanceOf( CheckpointConflictError );
        } );

        it( 'lets a newer run supersede regardless of sequence', async () =>
        {
            const a = new CheckpointManager( store );

            await save( a, 'run-old', 9 );
            await save( a, 'run-new', 1 );

            expect( ( await a.getLatestCheckpoint( 't1' ) )!.runId ).toBe( 'run-new' );
        } );

        it( 'converges on the highest sequence within the retry budget', async () =>
        {
            const managers = Array.from( { length : 5 }, () => {return new CheckpointManager( store );} );
            const settled = await Promise.allSettled( managers.map( ( m, i ) => {return save( m, 'run', i + 1 );} ) );

            expect( ( await managers[0].getLatestCheckpoint( 't1' ) )!.sequence ).toBe( 5 );
            expect( settled[4].status ).toBe( 'fulfilled' );
        } );

        it( 'never regresses under heavy contention, surfacing only CHECKPOINT_CONFLICT', async () =>
        {
            const managers = Array.from( { length : 20 }, () => {return new CheckpointManager( store );} );
            const settled = await Promise.allSettled( managers.map( ( m, i ) => {return save( m, 'run', i + 1 );} ) );
            const won = settled.flatMap( ( r, i ) => {return r.status === 'fulfilled' ? [ i + 1 ] : [];} );

            expect( ( await managers[0].getLatestCheckpoint( 't1' ) )!.sequence ).toBe( Math.max( ...won ) );

            for( const r of settled )
            {
                if( r.status === 'rejected' )
                {
                    expect( r.reason ).toBeInstanceOf( CheckpointConflictError );
                }
            }
        } );

        it( 'keeps the legacy positional overload last-write-wins', async () =>
        {
            const m = new CheckpointManager( store );

            await m.saveCheckpoint( 'legacy', 1, [], {}, 0 );
            await m.saveCheckpoint( 'legacy', 1, [], { again : true }, 0 );
            await m.saveCheckpoint( 'legacy', 0, [], { back : true }, 0 );

            expect( ( await m.getLatestCheckpoint( 'legacy' ) )!.state ).toEqual( { back : true } );
        } );
    } );
}

class ContendedStore extends MemoryDocStore
{
    public casCalls = 0;

    constructor( private readonly interfere: ( n: number, self: MemoryDocStore ) => Promise<void> )
    {
        super();
    }

    public override async conditionalWrite<T = Record<string, unknown>>(
        ...args: Parameters<MemoryDocStore['conditionalWrite']>
    ): Promise<{ written: boolean, version: number }>
    {
        if( String( args[0] ).endsWith( '_latest' ) )
        {
            this.casCalls++;
            await this.interfere( this.casCalls, this );
        }

        return super.conditionalWrite<T>( ...args as [ string, string, T, never ] );
    }
}

contractSuite( 'Checkpoint latest-pointer retry loop', undefined, () =>
{
    it( 'retries when another writer wins the CAS and then succeeds', async () =>
    {
        const store = new ContendedStore( async ( n, self ) =>
        {
            if( n === 1 )
            {
                await self.set( 'checkpoints_latest', 't1', { runId : 'other', sequence : 0 } );
            }
        } );
        const m = new CheckpointManager( store );

        await save( m, 'run', 1 );

        expect( store.casCalls ).toBe( 2 );
        expect( ( await m.getLatestCheckpoint( 't1' ) )!.runId ).toBe( 'run' );
    } );

    it( 'gives up with CHECKPOINT_CONFLICT after 5 contended attempts', async () =>
    {
        const store = new ContendedStore( async ( _n, self ) =>
        {
            await self.set( 'checkpoints_latest', 't1', { runId : 'other', sequence : 0 } );
        } );
        const m = new CheckpointManager( store );
        const err = await save( m, 'run', 1 ).then( () => {return null;}, ( e: unknown ) => {return e;} );

        expect( err ).toBeInstanceOf( CheckpointConflictError );
        expect( ( err as AIError ).code ).toBe( 'CHECKPOINT_CONFLICT' );
        expect( store.casCalls ).toBe( 5 );
    } );

    it( 'stops retrying immediately when the interfering writer is the same run and newer', async () =>
    {
        const store = new ContendedStore( async ( n, self ) =>
        {
            if( n === 1 )
            {
                await self.set( 'checkpoints_latest', 't1', { runId : 'run', sequence : 7 } );
            }
        } );
        const m = new CheckpointManager( store );

        await expect( save( m, 'run', 2 ) ).rejects.toBeInstanceOf( CheckpointConflictError );
        expect( store.casCalls ).toBe( 1 );
    } );
} );
