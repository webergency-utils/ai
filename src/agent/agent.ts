import { getCapabilities, type LanguageModel } from '../core/protocol.js';
import { toJsonSchema, validateSchema } from '../core/schema.js';
import type { ChatMessage, ModelRequest, ModelResponse, ToolCall, ToolDefinition } from '../core/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { CategorySpendBreakdown } from '../spend/types.js';
import { AIError, BudgetRefusedError, CancelledError, CapabilityError, GuardrailTripwireError, InvalidInputError, type GuardrailStage } from '../core/error.js';
import { finalizeStream } from '../core/tool-stream.js';
import { applyAgentAttributes, applyModelCallAttributes, applyToolAttributes, captureContent, GENAI_ATTR } from '../trace/genai.js';
import type { Tool } from './tool.js';
import type { CheckpointManager, AgentRunStatus, PendingToolCall } from './checkpoint.js';
import type { JITToolRetriever } from './jit-retriever.js';
import { SimpleExecutionContext, type ExecutionContext } from './context.js';
import type { Span } from '../trace/types.js';
import type { TraceCollector } from '../trace/collector.js';
import { createMeteredModel } from '../providers/metered.js';
import { runOrdered } from './concurrency.js';
import { assertGuardrailConfig, runGuardrails, type AgentGuardrails, type GuardrailVerdict } from './guardrails.js';
import { EventChannel, type AgentEmit, type AgentEvent } from './events.js';

export interface AgentConfig
{
    model              : LanguageModel
    instructions?      : string
    tools?             : Tool[]
    maxIterations?     : number
    /** Tool calls of one model turn that may run at once (default 1 = sequential). */
    toolConcurrency?   : number
    /** Input / tool / output checks; a trip throws `GuardrailTripwireError` and saves status `blocked`. */
    guardrails?        : AgentGuardrails
    /** JSON Schema the final answer must satisfy; requires a model with `capabilities.structuredOutput`. */
    outputSchema?      : ModelRequest['outputSchema']
    /**
     * `finalize` (default) runs the tool loop without a schema, then one extra tool-less call
     * with the schema. `inline` sends the schema on every step (needs provider support for schema + tools).
     */
    outputStrategy?    : 'inline' | 'finalize'
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
    /** Schema-validated final value when `outputSchema` is set; never fabricated on `step_limit`. */
    output?        : unknown
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

interface RunScope
{
    threadId : string
    runId    : string
    agentId  : string
}

interface ToolOutcome
{
    content : string
    isError : boolean
}

interface StepResponse
{
    content           : string
    toolCalls?        : ToolCall[]
    reasoningContent? : string
    usage?            : ModelResponse['usage']
    finishReason?     : ModelResponse['finishReason']
    structured?       : unknown
    /** Model-category spend recorded by the metered model during this call. */
    spendDeltaUSD     : number
}

/** Index of the last assistant message that issued tool calls, or -1. */
function lastToolTurn( messages: ChatMessage[] ): number
{
    for( let i = messages.length - 1; i >= 0; i-- )
    {
        if( messages[ i ]!.role === 'assistant' && ( messages[ i ]!.toolCalls?.length ?? 0 ) > 0 )
        {
            return i;
        }
    }

    return -1;
}

const FINALIZE_PROMPT = 'Provide your final answer now as JSON that satisfies the required output schema. Respond with the JSON only.';

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
    readonly #toolConcurrency   : number;
    readonly #guardrails        : AgentGuardrails;
    readonly #outputSchema?     : ModelRequest['outputSchema'];
    readonly #outputStrategy    : 'inline' | 'finalize';
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
        this.#toolConcurrency = config.toolConcurrency ?? 1;
        this.#guardrails = config.guardrails ?? {};

        assertGuardrailConfig( this.#guardrails );

        this.#outputSchema = config.outputSchema;
        this.#outputStrategy = config.outputStrategy ?? 'finalize';

        if( this.#outputStrategy !== 'inline' && this.#outputStrategy !== 'finalize' )
        {
            throw new AIError( `outputStrategy must be 'inline' or 'finalize', got '${String( config.outputStrategy )}'`, 'AGENT_CONFIG', { outputStrategy : config.outputStrategy } );
        }

        if( config.outputStrategy !== undefined && !this.#outputSchema )
        {
            throw new AIError( 'outputStrategy requires an outputSchema', 'AGENT_CONFIG', { outputStrategy : config.outputStrategy } );
        }

        if( this.#outputSchema )
        {
            if( !getCapabilities( this.#model ).structuredOutput )
            {
                throw new CapabilityError( this.#model.provider, 'structuredOutput', `Agent outputSchema needs a model with structured output support (model '${this.#model.model}')` );
            }

            // Compiling is eager: unsupported schema constructs throw here instead of on the first run.
            validateSchema( toJsonSchema( this.#outputSchema ), {}, 'relaxed' );
        }

        if( !Number.isInteger( this.#toolConcurrency ) || this.#toolConcurrency < 1 )
        {
            throw new AIError( `toolConcurrency must be an integer >= 1, got ${String( config.toolConcurrency )}`, 'AGENT_CONFIG', { toolConcurrency : config.toolConcurrency } );
        }

        this.#checkpointManager = config.checkpointManager;
        this.#spendTracker = config.spendTracker;
        this.#jitRetriever = config.jitRetriever;
        this.#collector = config.collector;
    }

    /**
     * Runs the agent to completion. Drains the same step engine as {@link Agent.runStream}
     * (checkpoints, spans and spend exist once); model calls use `generate`.
     */
    public async run( 
        input: string | ChatMessage[], 
        options: AgentRunOptions = {} 
    ): Promise<AgentResult>
    {
        return this.#drain( this.#drive( ( signal, emit ) => {return this.#startRun( input, options, signal, emit, false );}, options.signal ) );
    }

    /**
     * Runs the agent and yields {@link AgentEvent}s as they happen; model calls use `stream`.
     * The final `finish` event carries the {@link AgentResult}. Leaving the loop early
     * (or aborting `options.signal`) cancels the in-flight request and saves an `interrupted` checkpoint.
     */
    public runStream( 
        input: string | ChatMessage[], 
        options: AgentRunOptions = {} 
    ): AsyncGenerator<AgentEvent, void>
    {
        return this.#drive( ( signal, emit ) => {return this.#startRun( input, options, signal, emit, true );}, options.signal );
    }

    public async resume( threadId: string, options: Omit<AgentRunOptions, 'threadId' | 'interrupted'> = {} ): Promise<AgentResult>
    {
        return this.#drain( this.#drive( ( signal, emit ) => {return this.#startResume( threadId, options, signal, emit, false );}, options.signal ) );
    }

    public resumeStream( threadId: string, options: Omit<AgentRunOptions, 'threadId' | 'interrupted'> = {} ): AsyncGenerator<AgentEvent, void>
    {
        return this.#drive( ( signal, emit ) => {return this.#startResume( threadId, options, signal, emit, true );}, options.signal );
    }

    #assertExpectedFailure( error: unknown ): void
    {
        if( error !== undefined && !( error instanceof CancelledError ) )
        {
            throw error;
        }
    }

    async #drain( events: AsyncGenerator<AgentEvent, void> ): Promise<AgentResult>
    {
        for await ( const event of events )
        {
            if( event.type === 'finish' ){return event.result;}
        }

        throw new AIError( 'Agent run ended without a finish event', 'AGENT_NO_RESULT' );
    }

    /**
     * Runs `start` as the producer of an event channel and yields its events. The producer owns
     * a controller derived from `signal`, so abandoning the iterator cancels the run.
     */
    async* #drive( 
        start: ( signal: AbortSignal, emit: AgentEmit ) => Promise<AgentResult>, 
        signal?: AbortSignal 
    ): AsyncGenerator<AgentEvent, void>
    {
        const controller = new AbortController();
        const channel = new EventChannel<AgentEvent>();
        const link = () => {controller.abort( signal?.reason );};
        let failure: { error: unknown } | undefined;
        let early = true;

        if( signal?.aborted )
        {
            link();
        }
        else
        {
            signal?.addEventListener( 'abort', link, { once : true } );
        }

        const producer = start( controller.signal, ( event ) => {channel.push( event );} ).then( 
            ( result ) => 
            {
                channel.push( { type : 'finish', result } );
                channel.close();
            }, 
            ( error: unknown ) => 
            {
                failure = { error };
                channel.fail( error );
            } 
        );

        try
        {
            for( ;; )
            {
                let step: IteratorResult<AgentEvent, undefined>;

                try
                {
                    step = await channel.next();
                }
                catch( error )
                {
                    early = false;
                    throw error;
                }

                if( step.done )
                {
                    early = false;
                    break;
                }

                if( step.value.type === 'finish' )
                {
                    early = false;
                }

                yield step.value;
            }
        }
        finally
        {
            signal?.removeEventListener( 'abort', link );

            if( early )
            {
                controller.abort( new CancelledError( 'Agent event stream was closed by the consumer' ) );
                await producer;

                // A cancellation is the expected outcome of leaving early; anything else is a real failure.
                this.#assertExpectedFailure( failure?.error );
            }
        }
    }

    async #startRun( 
        input: string | ChatMessage[], 
        options: AgentRunOptions, 
        signal: AbortSignal, 
        emit: AgentEmit, 
        streaming: boolean 
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
            signal,
            emit,
            streaming,
            hydrate : false
        } );
    }

    async #startResume( 
        threadId: string, 
        options: Omit<AgentRunOptions, 'threadId' | 'interrupted'>, 
        signal: AbortSignal, 
        emit: AgentEmit, 
        streaming: boolean 
    ): Promise<AgentResult>
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
            signal,
            emit,
            streaming,
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
        signal: AbortSignal
        emit: AgentEmit
        streaming: boolean
        hydrate: boolean
        checkpoint?: NonNullable<Awaited<ReturnType<CheckpointManager['getLatestCheckpoint']>>>
    } ): Promise<AgentResult>
    {
        const { input, threadId, agentId, collector, options, signal, emit, streaming, hydrate, checkpoint } = args;

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
        let output: unknown;
        /** Length of `messages` a `blocked` checkpoint rolls back to (never leaves dangling tool calls). */
        let safeLength = 0;

        if( hydrate && checkpoint )
        {
            messages = [ ...checkpoint.messages ];
            totalSpendUSD = checkpoint.spendUSD;
            runStepCount = checkpoint.runStepCount;
            sequence = checkpoint.sequence;
            pendingToolCalls = checkpoint.pendingToolCalls ? [ ...checkpoint.pendingToolCalls ] : [];
            completedToolIds = checkpoint.completedToolIds ? [ ...checkpoint.completedToolIds ] : [];

            const openTurn = pendingToolCalls.length > 0 ? lastToolTurn( messages ) : -1;

            safeLength = openTurn >= 0 ? openTurn : messages.length;
        }
        else
        {
            if( this.#checkpointManager && options.threadId )
            {
                const latest = await this.#checkpointManager.getLatestCheckpoint( options.threadId );

                if( latest && ( latest.status === 'completed' || latest.status === 'abandoned' || latest.status === 'step_limit' || latest.status === 'blocked' ) )
                {
                    messages = [ ...latest.messages ];
                    totalSpendUSD = latest.spendUSD;
                }
            }

            safeLength = messages.length;

            if( typeof input === 'string' )
            {
                messages.push( { role : 'user', content : input } );
            }
            else if( Array.isArray( input ) && input.length > 0 )
            {
                messages.push( ...input );
            }
        }

        const inputMessages = messages.slice( safeLength );
        const scope: RunScope = { threadId, runId, agentId };

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

        /** Appends a tool result message and checkpoints it; called once per call, in model-call order. */
        const commitTool = async ( tc: PendingToolCall, outcome: ToolOutcome ): Promise<void> => 
        {
            messages.push( {
                role       : 'tool',
                toolCallId : tc.id,
                name       : tc.name,
                content    : outcome.content
            } );
            completedToolIds.push( tc.id );
            emit( {
                type       : 'tool:result',
                step       : Math.max( 0, runStepCount - 1 ),
                toolCallId : tc.id,
                name       : tc.name,
                content    : outcome.content,
                isError    : outcome.isError
            } );

            await save( 'interrupted' );
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
                applyAgentAttributes( runSpan, { id : agentId, threadId } );

                try
                {
                    if( !hydrate )
                    {
                        this.#enforce( 
                            'input', 
                            await runGuardrails( 'input', this.#guardrails.input, { messages : inputMessages }, { ...scope, context : runCtx, signal } ) 
                        );

                        safeLength = messages.length;
                    }

                    // Resume mid-batch: finish pending tools that are not yet completed.
                    if( hydrate && pendingToolCalls.length > 0 )
                    {
                        const remaining = pendingToolCalls.filter( 
                            ( tc ) => {return !completedToolIds.includes( tc.id );} 
                        );

                        await this.#executeTools( remaining, toolMap, runCtx, signal, scope, commitTool );

                        pendingToolCalls = [];
                        safeLength = messages.length;
                        await save( 'running' );
                    }

                    while( runStepCount < this.#maxIterations )
                    {
                        this.#assertNotAborted( signal );

                        const stepIndex = runStepCount;
                        const stepContinue = await runCtx.withSpan( 
                            `agent:step:${stepIndex}`, 
                            async ( stepSpan, stepCtx ) => 
                            {
                                stepSpan.setAttribute( 'step.index', stepIndex );
                                emit( { type : 'step:start', step : stepIndex } );

                                const response = await this.#callModel( {
                                    stepCtx,
                                    stepIndex,
                                    streaming,
                                    signal,
                                    emit,
                                    messages,
                                    toolDefs,
                                    threadId,
                                    agentId,
                                    outputSchema : this.#outputStrategy === 'inline' ? this.#outputSchema : undefined
                                } );

                                totalSpendUSD += response.spendDeltaUSD;
                                runStepCount++;

                                const toolCalls = response.toolCalls ?? [];

                                if( toolCalls.length > 0 )
                                {
                                    messages.push( {
                                        role    : 'assistant',
                                        content : response.content,
                                        toolCalls,
                                        ...( response.reasoningContent !== undefined ? { reasoningContent : response.reasoningContent } : {} )
                                    } );

                                    pendingToolCalls = toolCalls.map( ( tc ) => 
                                    {
                                        return {
                                            id        : tc.id,
                                            name      : tc.name,
                                            arguments : tc.arguments
                                        };
                                    } );

                                    await save( 'interrupted' );

                                    for( const tc of toolCalls )
                                    {
                                        emit( { type : 'tool:call', step : stepIndex, toolCall : tc } );
                                    }

                                    // Calls already committed (by id) are skipped, matching the checkpoint resume contract.
                                    await this.#executeTools( 
                                        pendingToolCalls.filter( ( tc ) => {return !completedToolIds.includes( tc.id );} ), 
                                        toolMap, stepCtx, signal, scope, commitTool 
                                    );

                                    pendingToolCalls = [];
                                    safeLength = messages.length;
                                    await save( 'running' );

                                    emit( { type : 'step:finish', step : stepIndex, usage : response.usage, finishReason : response.finishReason, toolCalls : toolCalls.length } );

                                    return true;
                                }

                                let structured: unknown;

                                if( this.#outputSchema )
                                {
                                    if( this.#outputStrategy === 'inline' )
                                    {
                                        structured = response.structured;
                                    }
                                    else
                                    {
                                        // `finalize`: one extra tool-less call over the history; it is a step of its own and cannot be starved by maxIterations.
                                        const finalizeIndex = runStepCount;

                                        emit( { type : 'step:start', step : finalizeIndex } );

                                        const finalized = await stepCtx.withSpan( 
                                            'agent:finalize', 
                                            ( finalizeSpan, finalizeCtx ) => 
                                            {
                                                finalizeSpan.setAttribute( 'step.index', finalizeIndex );

                                                return this.#callModel( {
                                                    stepCtx      : finalizeCtx,
                                                    stepIndex    : finalizeIndex,
                                                    streaming,
                                                    signal,
                                                    emit,
                                                    messages     : [ ...messages, { role : 'assistant', content : response.content }, { role : 'user', content : FINALIZE_PROMPT } ],
                                                    toolDefs     : [],
                                                    threadId,
                                                    agentId,
                                                    outputSchema : this.#outputSchema
                                                } );
                                            }, 
                                            { kind : 'agent' } 
                                        );

                                        totalSpendUSD += finalized.spendDeltaUSD;
                                        runStepCount++;

                                        if( finalized.toolCalls && finalized.toolCalls.length > 0 )
                                        {
                                            throw new InvalidInputError( 'The model issued tool calls on the tool-free structured output turn', { toolCalls : finalized.toolCalls } );
                                        }

                                        structured = finalized.structured;
                                        emit( { type : 'step:finish', step : finalizeIndex, usage : finalized.usage, finishReason : finalized.finishReason, toolCalls : 0 } );
                                    }

                                    if( structured === undefined )
                                    {
                                        throw new InvalidInputError( 'outputSchema was set but the model returned no structured output', { text : response.content } );
                                    }

                                    this.#assertValidOutput( structured );
                                }

                                this.#enforce( 
                                    'output', 
                                    await runGuardrails( 'output', this.#guardrails.output, { text : response.content, ...( this.#outputSchema ? { output : structured } : {} ) }, { ...scope, context : stepCtx, signal } ) 
                                );

                                output = structured;
                                finalText = response.content;
                                messages.push( { role : 'assistant', content : finalText } );
                                status = 'completed';
                                await save( 'completed' );

                                emit( { type : 'step:finish', step : stepIndex, usage : response.usage, finishReason : response.finishReason, toolCalls : 0 } );

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
                        ...( output !== undefined ? { output } : {} ),
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
                    if( err instanceof GuardrailTripwireError )
                    {
                        messages = messages.slice( 0, safeLength );
                        pendingToolCalls = [];
                        await save( 'blocked' );
                        throw err;
                    }

                    if( err instanceof CancelledError || signal.aborted )
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

    /**
     * One model call inside its own span (`model:generate`, or `model:stream` when streaming).
     * Streamed chunks go through `finalizeStream`, so tool-call JSON and structured output are
     * validated before any `tool:call` event is emitted.
     */
    async #callModel( args: {
        stepCtx: ExecutionContext
        stepIndex: number
        streaming: boolean
        signal: AbortSignal
        emit: AgentEmit
        messages: ChatMessage[]
        toolDefs: ToolDefinition[]
        threadId: string
        agentId: string
        outputSchema?: ModelRequest['outputSchema']
    } ): Promise<StepResponse>
    {
        const { stepCtx, stepIndex, streaming, signal, emit, messages, toolDefs, threadId, agentId, outputSchema } = args;

        return stepCtx.withSpan( 
            streaming ? 'model:stream' : 'model:generate', 
            async ( modelSpan ) => 
            {
                const model = this.#spendTracker 
                    ? createMeteredModel( this.#model, {
                        tracker : this.#spendTracker,
                        getSpan : () => {return modelSpan;},
                        threadId,
                        agentId
                    } )
                    : this.#model;

                const prevModelSpend = this.#spendTracker?.getCategorySpend( 'model' ) ?? 0;
                const request: ModelRequest = {
                    messages,
                    systemPrompt : this.#instructions,
                    tools        : toolDefs.length > 0 ? toolDefs : undefined,
                    signal,
                    ...( outputSchema ? { outputSchema } : {} )
                };

                applyModelCallAttributes( modelSpan, 
                    {
                        provider : this.#model.provider,
                        model    : this.#model.model,
                        request  : { temperature : request.temperature, maxTokens : request.maxTokens }
                    } );

                captureContent( modelSpan, stepCtx.capture, GENAI_ATTR.INPUT_MESSAGES, 
                    request.systemPrompt ? [ { role : 'system', content : request.systemPrompt }, ...messages ] : messages );

                let response: StepResponse;

                if( streaming )
                {
                    let content = '';
                    let reasoning = '';
                    let toolCalls: ToolCall[] | undefined;
                    let usage: ModelResponse['usage'] | undefined;
                    let finishReason: ModelResponse['finishReason'] | undefined;
                    let structured: unknown;

                    const chunks = finalizeStream( model.stream( request ), { provider : model.provider, tools : request.tools, outputSchema } );

                    for await ( const chunk of chunks )
                    {
                        this.#assertNotAborted( signal );

                        if( chunk.deltaContent )
                        {
                            content += chunk.deltaContent;
                            emit( { type : 'text:delta', step : stepIndex, delta : chunk.deltaContent } );
                        }

                        if( chunk.deltaReasoningContent )
                        {
                            reasoning += chunk.deltaReasoningContent;
                            emit( { type : 'reasoning:delta', step : stepIndex, delta : chunk.deltaReasoningContent } );
                        }

                        toolCalls = chunk.toolCalls && chunk.toolCalls.length > 0 ? chunk.toolCalls : toolCalls;
                        usage = chunk.usage ?? usage;
                        finishReason = chunk.finishReason ?? finishReason;
                        structured = chunk.structured ?? structured;
                    }

                    response = {
                        content,
                        toolCalls,
                        usage,
                        finishReason,
                        structured,
                        spendDeltaUSD : 0,
                        ...( reasoning ? { reasoningContent : reasoning } : {} )
                    };
                }
                else
                {
                    const resp = await model.generate( request );

                    response = {
                        content       : resp.content,
                        toolCalls     : resp.toolCalls,
                        usage         : resp.usage,
                        finishReason  : resp.finishReason,
                        structured    : resp.structured,
                        spendDeltaUSD : 0,
                        ...( resp.reasoningContent !== undefined ? { reasoningContent : resp.reasoningContent } : {} )
                    };
                }

                applyModelCallAttributes( modelSpan, 
                    {
                        provider : this.#model.provider,
                        model    : this.#model.model,
                        request  : { temperature : request.temperature, maxTokens : request.maxTokens },
                        response : { finishReason : response.finishReason, usage : response.usage }
                    } );

                captureContent( modelSpan, stepCtx.capture, GENAI_ATTR.OUTPUT_MESSAGES, 
                    [ { role : 'assistant', content : response.content, toolCalls : response.toolCalls } ], response.finishReason );

                if( response.usage )
                {
                    modelSpan.addMetrics( {
                        promptTokens     : response.usage.promptTokens,
                        completionTokens : response.usage.completionTokens,
                        totalTokens      : response.usage.totalTokens
                    } );
                }

                if( this.#spendTracker )
                {
                    response.spendDeltaUSD = Math.max( 0, this.#spendTracker.getCategorySpend( 'model' ) - prevModelSpend );
                }

                return response;
            }, 
            { kind : 'model' } 
        );
    }

    /** Re-validates the model's `structured` value so a custom model cannot bypass the schema. */
    #assertValidOutput( value: unknown ): void
    {
        const result = validateSchema( toJsonSchema( this.#outputSchema ), value, 'relaxed' );

        if( !result.success )
        {
            const detail = ( result.errors ?? [] ).map( ( err ) => {return `${err.path || '(root)'}: ${err.error}`;} ).join( '; ' );

            throw new InvalidInputError( `Agent output failed schema validation: ${detail}`, { errors : result.errors, value } );
        }
    }

    #assertNotAborted( signal?: AbortSignal ): void
    {
        if( signal?.aborted )
        {
            throw new CancelledError( 'Agent execution cancelled', signal.reason );
        }
    }

    /**
     * Runs tool calls with at most `toolConcurrency` in flight. Results are committed in
     * model-call order; the first `CancelledError` / `BudgetRefusedError` aborts siblings and is rethrown.
     */
    async #executeTools( 
        calls: PendingToolCall[], 
        toolMap: Map<string, Tool>, 
        runCtx: ExecutionContext,
        signal: AbortSignal,
        scope: RunScope,
        commit: ( tc: PendingToolCall, outcome: ToolOutcome ) => Promise<void>
    ): Promise<void>
    {
        await runOrdered( calls, {
            limit   : this.#toolConcurrency,
            signal,
            barrier : ( tc ) => {return toolMap.get( tc.name )?.parallelSafe === false;},
            run     : ( tc, _index, batchSignal ) => {return this.#runOneTool( tc, toolMap, runCtx, batchSignal, scope );},
            commit  : ( tc, outcome ) => {return commit( tc, outcome );}
        } );
    }

    /** Turns a guardrail verdict into a thrown tripwire; input / output denies and `tripwire` denies always trip. */
    #enforce( stage: GuardrailStage, verdict: GuardrailVerdict ): void
    {
        if( !verdict.allow )
        {
            throw new GuardrailTripwireError( stage, verdict.reason );
        }
    }

    async #runOneTool( 
        tc: PendingToolCall, 
        toolMap: Map<string, Tool>, 
        runCtx: ExecutionContext,
        signal: AbortSignal,
        scope: RunScope
    ): Promise<ToolOutcome>
    {
        const tool = toolMap.get( tc.name );

        if( !tool )
        {
            return { content : `Error: Tool '${tc.name}' not found`, isError : true };
        }

        const guardCtx = { ...scope, context : runCtx, signal };
        const pre = await runGuardrails( 'toolCall', this.#guardrails.toolCall, { id : tc.id, name : tc.name, arguments : tc.arguments }, guardCtx );

        if( !pre.allow )
        {
            return this.#blockedTool( 'toolCall', pre );
        }

        let outcome: ToolOutcome;

        try
        {
            this.#assertNotAborted( signal );

            const res = await runCtx.withSpan( 
                `tool:run:${tc.name}`, 
                async ( toolSpan, toolCtx ) => 
                {
                    toolSpan.setAttribute( 'tool.name', tc.name );
                    applyToolAttributes( toolSpan, { name : tc.name, callId : tc.id } );

                    return await tool.run( tc.arguments, toolCtx, { signal } );
                }, 
                {
                    kind       : 'tool',
                    attributes : { 'tool.name' : tc.name }
                } 
            );

            outcome = { content : typeof res === 'string' ? res : JSON.stringify( res ), isError : false };
        }
        catch( err: unknown )
        {
            outcome = { content : classifyToolError( err ), isError : true };
        }

        const post = await runGuardrails( 'toolResult', this.#guardrails.toolResult, { id : tc.id, name : tc.name, arguments : tc.arguments, result : outcome.content }, guardCtx );

        return post.allow ? outcome : this.#blockedTool( 'toolResult', post );
    }

    /** A non-tripwire deny is model-visible; a tripwire deny ends the run. */
    #blockedTool( stage: GuardrailStage, verdict: Extract<GuardrailVerdict, { allow: false }> ): ToolOutcome
    {
        if( verdict.tripwire )
        {
            throw new GuardrailTripwireError( stage, verdict.reason );
        }

        return { content : `Error: blocked by guardrail: ${verdict.reason}`, isError : true };
    }
}
