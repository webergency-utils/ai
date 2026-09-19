import type { ModelProtocol } from '../core/protocol.js';
import type { ChatMessage, ToolDefinition } from '../core/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { Tool } from './tool.js';
import type { CheckpointManager } from './checkpoint.js';
import type { JITToolRetriever } from './jit-retriever.js';

export interface AgentConfig
{
    model              : ModelProtocol
    instructions?      : string
    tools?             : Tool[]
    maxIterations?     : number
    checkpointManager? : CheckpointManager
    spendTracker?      : SpendTracker
    jitRetriever?      : JITToolRetriever
}

export interface AgentRunOptions
{
    threadId? : string
    signal?   : AbortSignal
}

export interface AgentResult
{
    text      : string
    messages  : ChatMessage[]
    steps     : number
    spendUSD  : number
    threadId? : string
}

export class Agent
{
    readonly #model: ModelProtocol;
    readonly #instructions?: string;
    readonly #tools: Tool[];
    readonly #maxIterations: number;
    readonly #checkpointManager?: CheckpointManager;
    readonly #spendTracker?: SpendTracker;
    readonly #jitRetriever?: JITToolRetriever;

    constructor( config: AgentConfig )
    {
        this.#model = config.model;
        this.#instructions = config.instructions;
        this.#tools = config.tools ?? [];
        this.#maxIterations = config.maxIterations ?? 10;
        this.#checkpointManager = config.checkpointManager;
        this.#spendTracker = config.spendTracker;
        this.#jitRetriever = config.jitRetriever;
    }

    public async run( 
        input: string | ChatMessage[], 
        options: AgentRunOptions = {} 
    ): Promise<AgentResult>
    {
        const threadId = options.threadId ?? `thread_${Date.now()}`;
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

        while( stepIndex < this.#maxIterations )
        {
            if( options.signal?.aborted )
            {
                throw new Error( 'Agent execution aborted' );
            }

            const response = await this.#model.generate( 
                {
                    messages,
                    systemPrompt : this.#instructions,
                    tools        : toolDefs.length > 0 ? toolDefs : undefined
                } );

            if( this.#spendTracker && response.usage )
            {
                const spend = this.#spendTracker.record( this.#model.model, response.usage );
                totalSpendUSD += spend.totalCost;
            }

            if( response.toolCalls && response.toolCalls.length > 0 )
            {
                // Assistant issued tool calls
                messages.push( 
                    {
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
                            const res = await tool.run( tc.arguments );
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

                    messages.push( 
                        {
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
                        stepIndex, 
                        messages, 
                        {}, 
                        totalSpendUSD 
                    );
                }

                stepIndex++;
                continue;
            }

            // Model finished with regular answer
            finalText = response.content;
            messages.push( { role : 'assistant', content : finalText } );

            if( this.#checkpointManager )
            {
                await this.#checkpointManager.saveCheckpoint( 
                    threadId, 
                    stepIndex, 
                    messages, 
                    {}, 
                    totalSpendUSD 
                );
            }

            break;
        }

        return {
            text     : finalText,
            messages,
            steps    : stepIndex + 1,
            spendUSD : totalSpendUSD,
            threadId
        };
    }
}
