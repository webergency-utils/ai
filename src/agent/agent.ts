import type { LanguageModel } from '../core/protocol.js';
import type { ChatMessage, ToolDefinition } from '../core/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { CategorySpendBreakdown } from '../spend/types.js';
import { BudgetRefusedError, CancelledError } from '../core/error.js';
import type { Tool } from './tool.js';
import type { CheckpointManager, AgentRunStatus, PendingToolCall } from './checkpoint.js';
import type { JITToolRetriever } from './jit-retriever.js';
import { SimpleExecutionContext, type ExecutionContext } from './context.js';
import type { Span } from '../trace/types.js';
import type { TraceCollector } from '../trace/collector.js';
import { createMeteredModel } from '../providers/metered.js';

export interface AgentConfig
{
    model              : LanguageModel
    instructions?      : string
    tools?             : Tool[]
    maxIterations?     : number
    checkpointManager? : CheckpointManager
    spendTracker?      : SpendTracker
    jitRetriever?      : JITToolRetriever
    collector?         : TraceCollector
}

export interface AgentRunOptions
{
    threadId?    : string
    agentId?     : string
    signal?      : AbortSignal
    context?     : ExecutionContext
    collector?   : TraceCollector
    /** Close an interrupted run by marking pending tools as not-executed. */
    interrupted? : 'abandon'
}

export interface AgentResult
{
    text           : string
    messages       : ChatMessage[]
    steps          : number
    spendUSD       : number
    categorySpend? : CategorySpendBreakdown
    threadId?      : string
    runId?         : string
    status?        : AgentRunStatus
    traceId?       : string
    span?          : Span
}

function newId( prefix: string ): string
{
    if( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' )
    {
        return `${prefix}_${crypto.randomUUID()}`;
    }

    return `${prefix}_${Date.now()}_${Math.random().toString( 36 ).slice( 2, 10 )}`;
}

function classifyToolError( err: unknown ): string
{
    if( err instanceof CancelledError )
    {
        throw err;
    }

    if( err instanceof BudgetRefusedError )
    {
        throw err;
    }

    if( err instanceof Error )
    {
        return `Error: ${err.name}: ${err.message}`;
    }

    return `Error: ${String( err )}`;
}

export class Agent
{
    readonly #model             : LanguageModel;
    readonly #instructions?     : string;
    readonly #tools             : Tool[];
    readonly #maxIterations     : number;
    readonly #checkpointManager?: CheckpointManager;
    readonly #spendTracker?     : SpendTracker;
    readonly #jitRetriever?     : JITToolRetriever;
    readonly #collector?        : TraceCollector;

    constructor( config: AgentConfig )
    {
        this.#model = config.model;
        this.#instructions = config.instructions;
        this.#tools = config.tools ?? [];
        this.#maxIterations = config.maxIterations ?? 10;
        this.#checkpointManager = config.checkpointManager;
        this.#spendTracker = config.spendTracker;
        this.#jitRetriever = config.jitRetriever;
        this.#collector = config.collector;
    }

    public async run( 
        input: string | ChatMessage[], 
        options: AgentRunOptions = {} 
    ): Promise<AgentResult>
    {
        const threadId = options.threadId ?? newId( 'thread' );
        const agentId = options.agentId ?? 'agent_default';
        const collector = options.collector ?? this.#collector;

        if( this.#checkpointManager && options.threadId )
        {
            const latest = await this.#checkpointManager.getLatestCheckpoint( options.threadId );

            if( latest?.status === 'interrupted' )
            {
                if( options.interrupted === 'abandon' )
                {
                    return this.#abandon( latest );
                }

                throw new Error( 
                    `Thread '${options.threadId}' has an interrupted run; call resume(threadId) or run(..., { interrupted: 'abandon' })` 
                );
            }
        }

        return this.#executeRun( {
            input,
            threadId,
            agentId,
            collector,
            options,
            hydrate : false
        } );
    }

    public async resume( threadId: string, options: Omit<AgentRunOptions, 'threadId' | 'interrupted'> = {} ): Promise<AgentResult>
    {
        if( !this.#checkpointManager )
        {
            throw new Error( 'Cannot resume without a checkpointManager' );
        }

        const latest = await this.#checkpointManager.getLatestCheckpoint( threadId );

        if( !latest || latest.status !== 'interrupted' )
        {
            throw new Error( `No interrupted run found for thread '${threadId}'` );
        }

        return this.#executeRun( {
            input      : latest.originalInput ?? [],
            threadId,
            agentId    : options.agentId ?? 'agent_default',
            collector  : options.collector ?? this.#collector,
            options    : { ...options, threadId },
            hydrate    : true,
            checkpoint : latest
        } );
    }

    async #abandon( 
        latest: NonNullable<Awaited<ReturnType<CheckpointManager['getLatestCheckpoint']>>>
    ): Promise<AgentResult>
    {
        const messages = [ ...latest.messages ];
        const pending = latest.pendingToolCalls ?? [];

        for( const tc of pending )
        {
            if( latest.completedToolIds?.includes( tc.id ) )
            {
                continue;
            }

            messages.push( {
                role       : 'tool',
                toolCallId : tc.id,
                name       : tc.name,
                content    : 'Error: tool call not executed (run abandoned)'
            } );
        }

        if( this.#checkpointManager )
        {
            await this.#checkpointManager.saveCheckpoint( {
                threadId         : latest.threadId,
                runId            : latest.runId,
                sequence         : latest.sequence + 1,
                stepIndex        : latest.stepIndex,
                runStepCount     : latest.runStepCount,
                messages,
                spendUSD         : latest.spendUSD,
                status           : 'abandoned',
                originalInput    : latest.originalInput,
                pendingToolCalls : [],
                completedToolIds : [
                    ...( latest.completedToolIds ?? [] ),
                    ...pending.map( ( p ) => {return p.id;} )
                ]
            } );
        }

        return {
            text     : '',
            messages,
            steps    : latest.runStepCount,
            spendUSD : latest.spendUSD,
            threadId : latest.threadId,
            runId    : latest.runId,
            status   : 'abandoned'
        };
    }

    async #executeRun( args: {
        input: string | ChatMessage[]
        threadId: string
        agentId: string
        collector?: TraceCollector
        options: AgentRunOptions
        hydrate: boolean
        checkpoint?: NonNullable<Awaited<ReturnType<CheckpointManager['getLatestCheckpoint']>>>
    } ): Promise<AgentResult>
    {
        const { input, threadId, agentId, collector, options, hydrate, checkpoint } = args;

        const context = options.context ?? ( 
            collector ? 
                collector.createExecutionContext( {
                    threadId,
                    agentId,
                    tracker : this.#spendTracker
                } ) : 
                new SimpleExecutionContext( {
                    threadId,
                    agentId,
                    tracker : this.#spendTracker
                } )
        );

        const runId = hydrate && checkpoint ? checkpoint.runId : newId( 'run' );
        let messages: ChatMessage[] = [];
        let totalSpendUSD = 0;
        let runStepCount = 0;
        let sequence = 0;
        let pendingToolCalls: PendingToolCall[] = [];
        let completedToolIds: string[] = [];
        let status: AgentRunStatus = 'running';
        let finalText = '';

        if( hydrate && checkpoint )
        {
            messages = [ ...checkpoint.messages ];
            totalSpendUSD = checkpoint.spendUSD;
            runStepCount = checkpoint.runStepCount;
            sequence = checkpoint.sequence;
            pendingToolCalls = checkpoint.pendingToolCalls ? [ ...checkpoint.pendingToolCalls ] : [];
            completedToolIds = checkpoint.completedToolIds ? [ ...checkpoint.completedToolIds ] : [];
        }
        else
        {
            if( this.#checkpointManager && options.threadId )
            {
                const latest = await this.#checkpointManager.getLatestCheckpoint( options.threadId );

                if( latest && ( latest.status === 'completed' || latest.status === 'abandoned' || latest.status === 'step_limit' ) )
                {
                    messages = [ ...latest.messages ];
                    totalSpendUSD = latest.spendUSD;
                }
            }

            if( typeof input === 'string' )
            {
                messages.push( { role : 'user', content : input } );
            }
            else if( Array.isArray( input ) && input.length > 0 )
            {
                messages.push( ...input );
            }
        }

        let activeTools = this.#tools;

        if( this.#jitRetriever && typeof input === 'string' )
        {
            activeTools = await this.#jitRetriever.retrieveTools( input );
        }

        const toolDefs: ToolDefinition[] = activeTools.map( ( t ) => {return t.toDefinition();} );
        const toolMap = new Map<string, Tool>( activeTools.map( ( t ) => [ t.name, t ] ) );

        const save = async ( nextStatus: AgentRunStatus ): Promise<void> => 
        {
            if( !this.#checkpointManager )
            {
                return;
            }

            sequence += 1;
            await this.#checkpointManager.saveCheckpoint( {
                threadId,
                runId,
                sequence,
                stepIndex        : runStepCount,
                runStepCount,
                messages,
                spendUSD         : this.#spendTracker ? this.#spendTracker.totalSpendUSD : totalSpendUSD,
                status           : nextStatus,
                originalInput    : input,
                pendingToolCalls : pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
                completedToolIds : completedToolIds.length > 0 ? completedToolIds : undefined
            } );
        };

        // Run marker before the first model call (KTD5).
        if( !hydrate )
        {
            await save( 'running' );
        }

        return context.withSpan( 
            'agent:run', 
            async ( runSpan, runCtx ) => 
            {
                runSpan.setAttribute( 'agent.id', agentId );
                runSpan.setAttribute( 'agent.threadId', threadId );
                runSpan.setAttribute( 'agent.runId', runId );

                try
                {
                    // Resume mid-batch: finish pending tools that are not yet completed.
                    if( hydrate && pendingToolCalls.length > 0 )
                    {
                        const remaining = pendingToolCalls.filter( 
                            ( tc ) => {return !completedToolIds.includes( tc.id );} 
                        );

                        for( const tc of remaining )
                        {
                            this.#assertNotAborted( options.signal );
                            await this.#runOneTool( tc, toolMap, messages, completedToolIds, runCtx, options.signal );
                            await save( 'interrupted' );
                        }

                        pendingToolCalls = [];
                        await save( 'running' );
                    }

                    while( runStepCount < this.#maxIterations )
                    {
                        this.#assertNotAborted( options.signal );

                        const stepIndex = runStepCount;
                        const stepContinue = await runCtx.withSpan( 
                            `agent:step:${stepIndex}`, 
                            async ( stepSpan, stepCtx ) => 
                            {
                                stepSpan.setAttribute( 'step.index', stepIndex );

                                const response = await stepCtx.withSpan( 
                                    'model:generate', 
                                    async ( modelSpan ) => 
                                    {
                                        modelSpan.setAttribute( 'model.provider', this.#model.provider );
                                        modelSpan.setAttribute( 'model.name', this.#model.model );

                                        const model = this.#spendTracker 
                                            ? createMeteredModel( this.#model, {
                                                tracker : this.#spendTracker,
                                                getSpan : () => {return modelSpan;},
                                                threadId,
                                                agentId
                                            } )
                                            : this.#model;

                                        const prevModelSpend = this.#spendTracker?.getCategorySpend( 'model' ) ?? 0;

                                        const resp = await model.generate( {
                                            messages,
                                            systemPrompt : this.#instructions,
                                            tools        : toolDefs.length > 0 ? toolDefs : undefined,
                                            signal       : options.signal
                                        } );

                                        if( resp.usage )
                                        {
                                            modelSpan.addMetrics( {
                                                promptTokens     : resp.usage.promptTokens,
                                                completionTokens : resp.usage.completionTokens,
                                                totalTokens      : resp.usage.totalTokens
                                            } );
                                        }

                                        if( this.#spendTracker )
                                        {
                                            const nextModelSpend = this.#spendTracker.getCategorySpend( 'model' );
                                            totalSpendUSD += Math.max( 0, nextModelSpend - prevModelSpend );
                                        }

                                        return resp;
                                    }, 
                                    { kind : 'model' } 
                                );

                                runStepCount++;

                                if( response.toolCalls && response.toolCalls.length > 0 )
                                {
                                    messages.push( {
                                        role      : 'assistant',
                                        content   : response.content,
                                        toolCalls : response.toolCalls,
                                        ...( response.reasoningContent !== undefined ? { reasoningContent : response.reasoningContent } : {} )
                                    } );

                                    pendingToolCalls = response.toolCalls.map( ( tc ) => 
                                    {
                                        return {
                                            id        : tc.id,
                                            name      : tc.name,
                                            arguments : tc.arguments
                                        };
                                    } );

                                    await save( 'interrupted' );

                                    for( const tc of pendingToolCalls )
                                    {
                                        this.#assertNotAborted( options.signal );

                                        try
                                        {
                                            await this.#runOneTool( 
                                                tc, 
                                                toolMap, 
                                                messages, 
                                                completedToolIds, 
                                                stepCtx, 
                                                options.signal 
                                            );
                                        }
                                        catch( err )
                                        {
                                            if( err instanceof CancelledError || err instanceof BudgetRefusedError )
                                            {
                                                await save( 'interrupted' );
                                                throw err;
                                            }

                                            throw err;
                                        }

                                        await save( 'interrupted' );
                                    }

                                    pendingToolCalls = [];
                                    await save( 'running' );

                                    return true;
                                }

                                finalText = response.content;
                                messages.push( { role : 'assistant', content : finalText } );
                                status = 'completed';
                                await save( 'completed' );

                                return false;
                            }, 
                            { kind : 'agent' } 
                        );

                        if( !stepContinue )
                        {
                            break;
                        }
                    }

                    if( status === 'running' && runStepCount >= this.#maxIterations && !finalText )
                    {
                        status = 'step_limit';
                        finalText = '';
                        await save( 'step_limit' );
                    }

                    return {
                        text          : finalText,
                        messages,
                        steps         : runStepCount,
                        spendUSD      : this.#spendTracker ? this.#spendTracker.totalSpendUSD : totalSpendUSD,
                        categorySpend : this.#spendTracker?.categorySpend,
                        threadId,
                        runId,
                        status,
                        traceId       : runSpan.traceId,
                        span          : runSpan
                    };
                }
                catch( err )
                {
                    if( err instanceof CancelledError || options.signal?.aborted )
                    {
                        await save( 'interrupted' );
                        throw err instanceof CancelledError 
                            ? err 
                            : new CancelledError( 'Agent execution cancelled', err );
                    }

                    await save( 'interrupted' );
                    throw err;
                }
            }, 
            {
                kind       : 'agent',
                attributes : {
                    'agent.id'       : agentId,
                    'agent.threadId' : threadId,
                    'agent.runId'    : runId
                }
            } 
        );
    }

    #assertNotAborted( signal?: AbortSignal ): void
    {
        if( signal?.aborted )
        {
            throw new CancelledError( 'Agent execution cancelled', signal.reason );
        }
    }

    async #runOneTool( 
        tc: PendingToolCall, 
        toolMap: Map<string, Tool>, 
        messages: ChatMessage[], 
        completedToolIds: string[], 
        runCtx: ExecutionContext,
        signal?: AbortSignal
    ): Promise<void>
    {
        if( completedToolIds.includes( tc.id ) )
        {
            return;
        }

        const tool = toolMap.get( tc.name );
        let toolResultStr: string;

        if( !tool )
        {
            toolResultStr = `Error: Tool '${tc.name}' not found`;
        }
        else
        {
            try
            {
                this.#assertNotAborted( signal );
                const res = await runCtx.withSpan( 
                    `tool:run:${tc.name}`, 
                    async ( toolSpan, toolCtx ) => 
                    {
                        toolSpan.setAttribute( 'tool.name', tc.name );
                        return await tool.run( tc.arguments, toolCtx );
                    }, 
                    {
                        kind       : 'tool',
                        attributes : { 'tool.name' : tc.name }
                    } 
                );
                toolResultStr = typeof res === 'string' ? res : JSON.stringify( res );
            }
            catch( err: unknown )
            {
                toolResultStr = classifyToolError( err );
            }
        }

        messages.push( {
            role       : 'tool',
            toolCallId : tc.id,
            name       : tc.name,
            content    : toolResultStr
        } );
        completedToolIds.push( tc.id );
    }
}
