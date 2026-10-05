import { describe, it, expect, vi } from 'vitest';
import { Workflow, WorkflowRunner } from '../../src/workflow/index.js';
import { MemoryDocStore } from '../../src/storage/index.js';
import { AIError } from '../../src/core/error.js';

describe( 'Typed Step Workflow Engine & DAG Runner', () => 
{
    it( 'should execute multi-step DAG in correct topological dependency order', async () => 
    {
        const workflow = new Workflow( 'test-dag' );
        const executionLog: string[] = [];

        workflow
            .step( 'stepA', async () => 
            {
                executionLog.push( 'A' );

                return { value : 10 };
            } )
            .step( 'stepB', async ( input: { value: number } ) => 
            {
                executionLog.push( 'B' );

                return { value : input.value * 2 };
            }, { dependencies : [ 'stepA' ] } )
            .step( 'stepC', async ( input: { value: number } ) => 
            {
                executionLog.push( 'C' );

                return { final : input.value + 5 };
            }, { dependencies : [ 'stepB' ] } );

        const runner = new WorkflowRunner( workflow );
        const result = await runner.execute();

        expect( result.status ).toBe( 'completed' );
        expect( executionLog ).toEqual( [ 'A', 'B', 'C' ] );
        expect( result.outputs.stepC ).toEqual( { final : 25 } );
    } );

    it( 'should detect cycles and throw WORKFLOW_CYCLE_ERROR', () => 
    {
        const workflow = new Workflow( 'cyclic-dag' );

        workflow
            .step( 'node1', async () => {return 1;}, { dependencies : [ 'node2' ] } )
            .step( 'node2', async () => {return 2;}, { dependencies : [ 'node1' ] } );

        expect( () => 
        {
            workflow.topologicalSort();
        } ).toThrow( AIError );
    } );

    it( 'should suspend at WaitNode, serialize checkpoint, and resume with signal data', async () => 
    {
        const checkpointStore = new MemoryDocStore();
        const workflow = new Workflow( 'approval-workflow' );
        const log: string[] = [];

        workflow
            .step( 'generate_draft', async () => 
            {
                log.push( 'drafted' );

                return { title : 'Post draft', content : 'Hello world' };
            } )
            .wait( 'approval_wait', 
                {
                    prompt       : 'Awaiting editorial review',
                    dependencies : [ 'generate_draft' ]
                } )
            .step( 'publish', async ( input: unknown, ctx ) => 
            {
                log.push( 'published' );
                const approvalSignal = ctx.stepOutputs.approval_wait as { approved: boolean };
                const draft = ctx.stepOutputs.generate_draft as { title: string, content: string };

                return { 
                    status       : 'published',
                    wasApproved  : approvalSignal.approved,
                    draftContent : draft.content
                };
            }, { dependencies : [ 'approval_wait' ] } );

        const runner = new WorkflowRunner( workflow, { checkpointStore } );
        const runId = 'approval-run-123';

        const initialResult = await runner.execute( {}, runId );

        expect( initialResult.status ).toBe( 'suspended' );
        expect( initialResult.suspendedAtStepId ).toBe( 'approval_wait' );
        expect( log ).toEqual( [ 'drafted' ] );

        const checkpoint = await checkpointStore.get( 'workflow_checkpoints', runId );
        expect( checkpoint ).toBeDefined();

        const resumedResult = await runner.resume( runId, {
            waitId : 'approval_wait',
            data   : { approved : true, reviewer : 'editor1' }
        } );

        expect( resumedResult.status ).toBe( 'completed' );
        expect( log ).toEqual( [ 'drafted', 'published' ] );
        expect( resumedResult.outputs.publish ).toEqual( {
            status       : 'published',
            wasApproved  : true,
            draftContent : 'Hello world'
        } );
    } );

    it( 'should retry failing steps according to retries option', async () => 
    {
        vi.useFakeTimers();
        const workflow = new Workflow( 'retry-test' );
        let attempts = 0;

        workflow.step( 'flaky_step', async () => 
        {
            attempts++;

            if( attempts < 3 )
            {
                throw new Error( `Flaky error attempt ${attempts}` );
            }

            return { success : true, attempts };
        }, { retries : 2 } );

        const runner = new WorkflowRunner( workflow );
        const pending = runner.execute();
        await vi.runAllTimersAsync();
        const result = await pending;

        expect( result.status ).toBe( 'completed' );
        expect( attempts ).toBe( 3 );
        expect( result.outputs.flaky_step ).toEqual( { success : true, attempts : 3 } );
        vi.useRealTimers();
    } );

    it( 'rejects wait workflows without a checkpoint store (R24)', async () => 
    {
        const workflow = new Workflow( 'needs-store' );
        workflow.wait( 'w1' );

        const runner = new WorkflowRunner( workflow );

        await expect( runner.execute() ).rejects.toThrow( /checkpointStore/ );
    } );
} );

describe( 'Workflow branching and joins (AE6)', () => 
{
    it( 'runs only the chosen branch and joins with a completed-deps map', async () => 
    {
        const workflow = new Workflow( 'branch-join' );
        const log: string[] = [];

        workflow
            .step( 'start', async () => 
            {
                log.push( 'start' );

                return { n : 1 };
            } )
            .condition( 'cond', async () => {return true;}, {
                ifTrue       : 'A',
                ifFalse      : 'B',
                dependencies : [ 'start' ]
            } )
            .step( 'A', async () => 
            {
                log.push( 'A' );

                return { from : 'A' };
            }, { dependencies : [ 'cond' ] } )
            .step( 'B', async () => 
            {
                log.push( 'B' );

                return { from : 'B' };
            }, { dependencies : [ 'cond' ] } )
            .step( 'D', async ( input ) => 
            {
                log.push( 'D' );

                return input;
            }, { dependencies : [ 'A', 'B' ] } );

        const runner = new WorkflowRunner( workflow );
        const result = await runner.execute();

        expect( result.status ).toBe( 'completed' );
        expect( log ).toEqual( [ 'start', 'A', 'D' ] );
        expect( result.skippedSteps ).toContain( 'B' );
        expect( result.outputs.D ).toEqual( { A : { from : 'A' } } );
    } );
} );

describe( 'Workflow parallelism and failure (AE13)', () => 
{
    it( 'runs independent ready steps concurrently', async () => 
    {
        const workflow = new Workflow( 'parallel' );
        let concurrent = 0;
        let maxConcurrent = 0;

        const bump = async ( id: string ): Promise<string> => 
        {
            concurrent++;
            maxConcurrent = Math.max( maxConcurrent, concurrent );
            await new Promise( ( r ) => {setTimeout( r, 20 );} );
            concurrent--;

            return id;
        };

        workflow
            .step( 'A', async () => {return bump( 'A' );} )
            .step( 'B', async () => {return bump( 'B' );} )
            .step( 'C', async ( input ) => {return input;}, { dependencies : [ 'A', 'B' ] } );

        const runner = new WorkflowRunner( workflow );
        const result = await runner.execute();

        expect( result.status ).toBe( 'completed' );
        expect( maxConcurrent ).toBeGreaterThan( 1 );
        expect( result.outputs.C ).toEqual( { A : 'A', B : 'B' } );
    } );

    it( 'signals siblings to stop when a parallel step fails (AE13)', async () => 
    {
        const workflow = new Workflow( 'fail-sibling' );
        let bStarted = false;
        let bSawAbort = false;

        workflow
            .step( 'A', async () => 
            {
                await new Promise( ( r ) => {setTimeout( r, 5 );} );
                throw new Error( 'A failed' );
            } )
            .step( 'B', async ( _input, ctx ) => 
            {
                bStarted = true;

                await new Promise<void>( ( resolve, reject ) => 
                {
                    const timer = setTimeout( () => {resolve();}, 100 );
                    ctx.signal?.addEventListener( 'abort', () => 
                    {
                        bSawAbort = true;
                        clearTimeout( timer );
                        reject( ctx.signal?.reason ?? new Error( 'aborted' ) );
                    }, { once : true } );
                } );

                return 'B done';
            } );

        const store = new MemoryDocStore();
        const runner = new WorkflowRunner( workflow, { checkpointStore : store } );
        const result = await runner.execute( {}, 'fail-run' );

        expect( result.status ).toBe( 'failed' );
        expect( bStarted ).toBe( true );
        expect( bSawAbort ).toBe( true );

        const saved = await store.get<{ status: string, error?: { message: string } }>( 
            'workflow_checkpoints', 
            'fail-run' 
        );
        expect( saved?.status ).toBe( 'failed' );
        expect( saved?.error?.message ).toContain( 'A failed' );
    } );
} );

describe( 'Workflow resume claims (AE7 / R54)', () => 
{
    it( 'rejects a concurrent resume claim (AE7)', async () => 
    {
        const store = new MemoryDocStore();
        const workflow = new Workflow( 'claim' );

        workflow
            .step( 'prep', async () => {return 1;} )
            .wait( 'w', { dependencies : [ 'prep' ] } )
            .step( 'done', async () => {return 'ok';}, { dependencies : [ 'w' ] } );

        const runner = new WorkflowRunner( workflow, { checkpointStore : store } );
        await runner.execute( {}, 'claim-run' );

        // Manually set claiming to simulate another process holding the claim.
        const meta = await store.getWithMeta( 'workflow_checkpoints', 'claim-run' );
        await store.conditionalWrite( 
            'workflow_checkpoints', 
            'claim-run', 
            {
                ...( meta!.doc as object ),
                status : 'claiming',
                claim  : { owner : 'other', claimedAt : Date.now() }
            }, 
            { expectedVersion : meta!.version } 
        );

        await expect( runner.resume( 'claim-run', { waitId : 'w', data : {} } ) )
            .rejects
            .toThrow( /takeover|claimed/i );

        const takeover = await runner.resume( 'claim-run', {
            waitId   : 'w',
            data     : { ok : true },
            takeover : true
        } );

        expect( takeover.status ).toBe( 'completed' );
    } );
} );
