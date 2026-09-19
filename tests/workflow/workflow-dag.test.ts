import { describe, it, expect } from 'vitest';
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

        // 1. Initial execution suspends at WaitNode
        const initialResult = await runner.execute( {}, runId );

        expect( initialResult.status ).toBe( 'suspended' );
        expect( initialResult.suspendedAtStepId ).toBe( 'approval_wait' );
        expect( log ).toEqual( [ 'drafted' ] );

        // Verify checkpoint exists in document store
        const checkpoint = await checkpointStore.get( 'workflow_checkpoints', runId );
        expect( checkpoint ).toBeDefined();

        // 2. Resume execution with human approval signal
        const resumedResult = await runner.resume( runId, { approved : true, reviewer : 'editor1' } );

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
        const result = await runner.execute();

        expect( result.status ).toBe( 'completed' );
        expect( attempts ).toBe( 3 );
        expect( result.outputs.flaky_step ).toEqual( { success : true, attempts : 3 } );
    } );
} );
