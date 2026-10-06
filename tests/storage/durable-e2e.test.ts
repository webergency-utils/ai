import { describe, it, expect, afterAll } from 'vitest';
import { CheckpointManager } from '../../src/agent/checkpoint.js';
import { Workflow, WorkflowRunner } from '../../src/workflow/index.js';
import { documentBackends, closeBackends } from './backends.js';

/**
 * End-to-end: the real consumers of IDocumentStore (CheckpointManager, WorkflowRunner) running on every
 * document backend. Memory and SQLite always run; Redis/Postgres run when TEST_REDIS_URL / TEST_POSTGRES_URL are set.
 */
for( const backend of documentBackends )
{
    describe.skipIf( backend.options?.skip === true )( `durable consumers on ${backend.name}`, () =>
    {
        it( 'CheckpointManager persists, lists and resolves the latest checkpoint across manager instances', async () =>
        {
            const { store, dispose } = await backend.factory();

            try
            {
                const writer = new CheckpointManager( store );
                const common = { threadId : 'thread-1', runId : 'run-1', messages : [], status : 'running' as const, runStepCount : 0 };

                await writer.saveCheckpoint( { ...common, sequence : 1, stepIndex : 1, state : { n : 1 } } );
                await writer.saveCheckpoint( { ...common, sequence : 2, stepIndex : 2, state : { n : 2 } } );

                const reader = new CheckpointManager( store );
                const latest = await reader.getLatestCheckpoint( 'thread-1' );

                expect( latest?.sequence ).toBe( 2 );
                expect( latest?.state ).toEqual( { n : 2 } );
                expect( ( await reader.listCheckpoints( 'thread-1' ) ).map( ( c ) => {return c.sequence;} ).sort() ).toEqual( [ 1, 2 ] );

                await reader.deleteThreadCheckpoints( 'thread-1' );

                expect( await reader.getLatestCheckpoint( 'thread-1' ) ).toBeNull();
            }
            finally
            {
                await dispose?.();
            }
        } );

        it( 'CheckpointManager never regresses latest under concurrent writers (AE5)', async () =>
        {
            const { store, dispose } = await backend.factory();

            try
            {
                const manager = new CheckpointManager( store );
                const common = { threadId : 'thread-race', runId : 'run-race', messages : [], status : 'running' as const, runStepCount : 0 };

                const results = await Promise.allSettled( [ 1, 2, 3, 4, 5 ].map( ( n ) =>
                {
                    return manager.saveCheckpoint( { ...common, sequence : n, stepIndex : n } );
                } ) );

                expect( results.some( ( r ) => {return r.status === 'fulfilled';} ) ).toBe( true );

                const latest = await manager.getLatestCheckpoint( 'thread-race' );

                expect( latest?.sequence ).toBe( 5 );
            }
            finally
            {
                await dispose?.();
            }
        } );

        it( 'WorkflowRunner suspends in one runner and resumes in another that shares only the store', async () =>
        {
            const { store, dispose } = await backend.factory();

            try
            {
                const build = () =>
                {
                    return new Workflow( 'approval' )
                        .step( 'draft', async () => {return { text : 'hello' };} )
                        .wait( 'approve', { dependencies : [ 'draft' ] } )
                        .step( 'publish', async ( _input: unknown, ctx ) =>
                        {
                            const draft = ctx.stepOutputs.draft as { text: string };
                            const signal = ctx.stepOutputs.approve as { ok: boolean };

                            return { published : draft.text, ok : signal.ok };
                        }, { dependencies : [ 'approve' ] } );
                };

                const first = await new WorkflowRunner( build(), { checkpointStore : store } ).execute( {}, 'run-e2e' );

                expect( first.status ).toBe( 'suspended' );
                expect( first.suspendedAtStepId ).toBe( 'approve' );

                const second = new WorkflowRunner( build(), { checkpointStore : store } );
                const [ a, b ] = await Promise.allSettled( [
                    second.resume( 'run-e2e', { waitId : 'approve', data : { ok : true } } ),
                    second.resume( 'run-e2e', { waitId : 'approve', data : { ok : true } } )
                ] );

                // Exactly one resume claims the run (AE7); the other is rejected.
                expect( [ a.status, b.status ].sort() ).toEqual( [ 'fulfilled', 'rejected' ] );

                const winner = ( a.status === 'fulfilled' ? a : b ) as PromiseFulfilledResult<Awaited<ReturnType<WorkflowRunner['resume']>>>;

                expect( winner.value.status ).toBe( 'completed' );
                expect( winner.value.outputs.publish ).toEqual( { published : 'hello', ok : true } );
            }
            finally
            {
                await dispose?.();
            }
        } );
    } );
}

afterAll( async () =>
{
    await closeBackends();
} );
