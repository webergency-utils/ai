import type { ModelProtocol } from '../core/protocol.js';
import type { ChatMessage, ToolDefinition } from '../core/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { CategorySpendBreakdown } from '../spend/types.js';
import type { Tool } from './tool.js';
import type { CheckpointManager } from './checkpoint.js';
import type { JITToolRetriever } from './jit-retriever.js';
import { SimpleExecutionContext, type ExecutionContext } from './context.js';
import type { Span } from '../trace/types.js';
import type { TraceCollector } from '../trace/collector.js';
import { createMeteredModel } from '../providers/metered.js';

export interface AgentConfig
{
    model              : ModelProtocol
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
    threadId?  : string
    agentId?   : string
    signal?    : AbortSignal
    context?   : ExecutionContext
    collector? : TraceCollector
}

export interface AgentResult
{
    text           : string
    messages       : ChatMessage[]
    steps          : number
    spendUSD       : number
    categorySpend? : CategorySpendBreakdown
    threadId?      : string
    traceId?       : string
    span?          : Span
}

export class Agent
{
    readonly #model             : ModelProtocol;
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
        const threadId = options.threadId ?? `thread_${Date.now()}`;
        const agentId = options.agentId ?? 'agent_default';
        const collector = options.collector ?? this.#collector;

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

        let messages: ChatMessage[] = [];
        let totalSpendUSD = 0;
        let stepIndex = 0;

        // Hydrate from checkpoint if available
        if( this.#checkpointManager && options.threadId )
        {
            const latest = await this.#checkpointManager.getLatestCheckpoint( options.threadId );

            if( latest )
            {
                messages = [ ...latest.messages ];
                totalSpendUSD = latest.spendUSD;
                stepIndex = latest.stepIndex + 1;
            }
        }

        // Add user prompt to messages
        if( typeof input === 'string' )
        {
            messages.push( { role : 'user', content : input } );
        }
        else
        {
            messages.push( ...input );
        }

        // Select tools (either all tools or JIT retrieved tools)
        let activeTools = this.#tools;

        if( this.#jitRetriever && typeof input === 'string' )
        {
            activeTools = await this.#jitRetriever.retrieveTools( input );
        }

        const toolDefs: ToolDefinition[] = activeTools.map( ( t ) => {return t.toDefinition();} );
        const toolMap = new Map<string, Tool>( activeTools.map( ( t ) => [ t.name, t ] ) );

        let finalText = '';

        return context.withSpan( 
            'agent:run', 
            async ( runSpan, runCtx ) => 
            {
                runSpan.setAttribute( 'agent.id', agentId );
                runSpan.setAttribute( 'agent.threadId', threadId );

                while( stepIndex < this.#maxIterations )
                {
                    if( options.signal?.aborted )
                    {
                        throw new Error( 'Agent execution aborted' );
                    }

                    const currentStep = stepIndex;

                    const hasMore = await runCtx.withSpan( 
                        `agent:step:${currentStep}`, 
                        async ( stepSpan, stepCtx ) => 
                        {
                            stepSpan.setAttribute( 'step.index', currentStep );

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

                            if( response.toolCalls && response.toolCalls.length > 0 )
                            {
                                messages.push( {
                                    role      : 'assistant',
                                    content   : response.content,
                                    toolCalls : response.toolCalls
                                } );

                                for( const tc of response.toolCalls )
                                {
                                    const tool = toolMap.get( tc.name );
                                    let toolResultStr: string;

                                    if( tool )
                                    {
                                        try
                                        {
                                            const res = await stepCtx.withSpan( 
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
                                            toolResultStr = `Error: ${err instanceof Error ? err.message : String( err )}`;
                                        }
                                    }
                                    else
                                    {
                                        toolResultStr = `Error: Tool '${tc.name}' not found`;
                                    }

                                    messages.push( {
                                        role       : 'tool',
                                        toolCallId : tc.id,
                                        name       : tc.name,
                                        content    : toolResultStr
                                    } );
                                }

                                if( this.#checkpointManager )
                                {
                                    await this.#checkpointManager.saveCheckpoint( 
                                        threadId, 
                                        currentStep, 
                                        messages, 
                                        {}, 
                                        this.#spendTracker ? this.#spendTracker.totalSpendUSD : totalSpendUSD 
                                    );
                                }

                                stepIndex++;
                                return true;
                            }

                            finalText = response.content;
                            messages.push( { role : 'assistant', content : finalText } );

                            if( this.#checkpointManager )
                            {
                                await this.#checkpointManager.saveCheckpoint( 
                                    threadId, 
                                    currentStep, 
                                    messages, 
                                    {}, 
                                    this.#spendTracker ? this.#spendTracker.totalSpendUSD : totalSpendUSD 
                                );
                            }

                            return false;
                        }, 
                        { kind : 'agent' } 
                    );

                    if( !hasMore )
                    {
                        break;
                    }
                }

                return {
                    text          : finalText,
                    messages,
                    steps         : stepIndex + 1,
                    spendUSD      : this.#spendTracker ? this.#spendTracker.totalSpendUSD : totalSpendUSD,
                    categorySpend : this.#spendTracker?.categorySpend,
                    threadId,
                    traceId       : runSpan.traceId,
                    span          : runSpan
                };
            }, 
            {
                kind       : 'agent',
                attributes : {
                    'agent.id'       : agentId,
                    'agent.threadId' : threadId
                }
            } 
        );
    }
}
