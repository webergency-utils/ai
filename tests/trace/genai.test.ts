import { describe, it, expect, vi } from 'vitest';
import { Agent, createTool } from '../../src/agent/index.js';
import { decideWithContext } from '../../src/agent/decision.js';
import { schema } from '../../src/core/index.js';
import { SpendTracker } from '../../src/spend/index.js';
import { TraceCollector } from '../../src/trace/collector.js';
import { SpanImpl } from '../../src/trace/span.js';
import { computeTraceRollup } from '../../src/trace/rollup.js';
import { exportTraceToOTLP, exportTracesToOTLP, type OTLPSpan } from '../../src/trace/exporter.js';
import 
{
    GENAI_ATTR, GENAI_PROVIDER_NAMES, applyAgentAttributes, applyModelCallAttributes, applyToolAttributes, 
    projectGenAIAttributes, toGenAIProvider, toGenAISpanName
} from '../../src/trace/genai.js';
import { createMeteredEmbeddingModel, createMeteredModel } from '../../src/providers/metered.js';
import type { ModelProtocol } from '../../src/core/protocol.js';
import type { ModelResponse } from '../../src/core/types.js';
import type { Trace } from '../../src/trace/types.js';

const attrOf = ( span: OTLPSpan, key: string ) => {return span.attributes.find( ( a ) => {return a.key === key;} )?.value;};
const spansOf = ( trace: Trace, options = {} ) => {return exportTraceToOTLP( trace, options ).resourceSpans[0]!.scopeSpans[0]!.spans;};

function agentModel(): ModelProtocol
{
    let n = 0;

    return {
        provider : 'gemini',
        model    : 'gemini-2.0-flash',
        generate : vi.fn( async (): Promise<ModelResponse> => 
        {
            n++;

            return n === 1
                ? { role : 'assistant', content : '', finishReason : 'tool_calls', toolCalls : [ { id : 'call_1', name : 'lookup', arguments : { q : 'x' } } ], usage : { promptTokens : 120, completionTokens : 30, totalTokens : 150, cachedPromptReadTokens : 40 }, raw : {} }
                : { role : 'assistant', content : 'done', finishReason : 'stop', usage : { promptTokens : 10, completionTokens : 5, totalTokens : 15 }, raw : {} };
        } ),
        stream : vi.fn()
    };
}

const lookup = createTool( { name : 'lookup', description : 'd', parameters : schema.object( { q : schema.string() } ), execute : async () => {return 'ok';} } );

describe( 'GenAI attribute helpers (R7-R10)', () => 
{
    it( 'maps provider ids to semconv values and passes unknown ones through', () => 
    {
        const table: Array<[ string, string ]> = 
            [
                [ 'openai', 'openai' ], [ 'anthropic', 'anthropic' ], [ 'gemini', 'gcp.gemini' ], [ 'GEMINI', 'gcp.gemini' ],
                [ 'mistral', 'mistral_ai' ], [ 'groq', 'groq' ], [ 'deepseek', 'deepseek' ], [ 'ollama', 'ollama' ], [ 'my-proxy', 'my-proxy' ]
            ];

        for( const [ id, expected ] of table )
        {
            expect( toGenAIProvider( id ) ).toBe( expected );
        }

        expect( GENAI_PROVIDER_NAMES.get( 'xai' ) ).toBe( 'x_ai' );
    } );

    it( 'applyModelCallAttributes sets request params, finish reasons and usage, keeping legacy names', () => 
    {
        const span = new SpanImpl( 'model:generate', { kind : 'model' } );

        applyModelCallAttributes( span, 
            {
                provider : 'anthropic', model : 'claude', request : { temperature : 0.2, maxTokens : 512, topP : 0.9 },
                response : { finishReason : 'length', usage : { promptTokens : 7, completionTokens : 3, reasoningTokens : 2, cachedPromptReadTokens : 4, cachedPromptWriteTokens : 1 } }
            } );

        expect( span.attributes ).toMatchObject( 
            {
                'model.provider'                           : 'anthropic',
                'model.name'                               : 'claude',
                'gen_ai.operation.name'                    : 'chat',
                'gen_ai.provider.name'                     : 'anthropic',
                'gen_ai.request.model'                     : 'claude',
                'gen_ai.request.temperature'               : 0.2,
                'gen_ai.request.max_tokens'                : 512,
                'gen_ai.request.top_p'                     : 0.9,
                'gen_ai.response.finish_reasons'           : [ 'length' ],
                'gen_ai.usage.input_tokens'                : 7,
                'gen_ai.usage.output_tokens'               : 3,
                'gen_ai.usage.reasoning.output_tokens'     : 2,
                'gen_ai.usage.cache_read.input_tokens'     : 4,
                'gen_ai.usage.cache_creation.input_tokens' : 1
            } );
    } );

    it( 'leaves usage gaps as gaps: no usage, undefined or non-finite counters set nothing', () => 
    {
        const span = new SpanImpl( 'm', { kind : 'model' } );

        applyModelCallAttributes( span, { provider : 'openai', model : 'gpt', request : { temperature : undefined, maxTokens : Number.NaN }, response : { finishReason : 'stop' } } );
        applyModelCallAttributes( span, { provider : 'openai', model : 'gpt', response : { usage : { promptTokens : Number.NaN } } } );

        const keys = Object.keys( span.attributes );

        expect( keys.some( ( k ) => {return k.startsWith( 'gen_ai.usage' );} ) ).toBe( false );
        expect( keys ).not.toContain( GENAI_ATTR.REQUEST_TEMPERATURE );
        expect( keys ).not.toContain( GENAI_ATTR.REQUEST_MAX_TOKENS );
        expect( span.attributes[GENAI_ATTR.RESPONSE_FINISH_REASONS] ).toEqual( [ 'stop' ] );
    } );

    it( 'embeddings operation, tool and agent helpers', () => 
    {
        const e = new SpanImpl( 'e' );
        const t = new SpanImpl( 't' );
        const a = new SpanImpl( 'a' );

        applyModelCallAttributes( e, { provider : 'openai', model : 'text-embedding-3', operation : 'embeddings', response : { dimensions : 1536, usage : { promptTokens : 5 } } } );
        applyToolAttributes( t, { name : 'lookup', callId : 'c1' } );
        applyAgentAttributes( a, { id : 'agent_1', threadId : 'thr', name : 'support' } );

        expect( e.attributes ).toMatchObject( { 'gen_ai.operation.name' : 'embeddings', 'gen_ai.embeddings.dimension.count' : 1536, 'gen_ai.usage.input_tokens' : 5 } );
        expect( t.attributes ).toMatchObject( { 'gen_ai.operation.name' : 'execute_tool', 'gen_ai.tool.name' : 'lookup', 'gen_ai.tool.call.id' : 'c1', 'gen_ai.tool.type' : 'function' } );
        expect( a.attributes ).toMatchObject( { 'gen_ai.operation.name' : 'invoke_agent', 'gen_ai.agent.id' : 'agent_1', 'gen_ai.agent.name' : 'support', 'gen_ai.conversation.id' : 'thr' } );
    } );

    it( 'projects GenAI attributes onto legacy spans without overriding present ones', () => 
    {
        const model = new SpanImpl( 'model:generate', { kind : 'model', attributes : { 'model.provider' : 'gemini', 'model.name' : 'g', 'gen_ai.request.model' : 'explicit' } } );

        model.addMetrics( { promptTokens : 9, completionTokens : 4, cachedTokens : 3, reasoningTokens : 2 } );

        const tool = new SpanImpl( 'tool:run:x', { kind : 'tool', attributes : { 'tool.name' : 'x' } } );
        const mcp = new SpanImpl( 'mcp:call:y', { kind : 'mcp', attributes : { 'mcp.tool' : 'y' } } );
        const agent = new SpanImpl( 'agent:run', { kind : 'agent', attributes : { 'agent.id' : 'a1', 'agent.threadId' : 't1' } } );
        const bare = new SpanImpl( 'model:x', { kind : 'model' } );
        const emb = new SpanImpl( 'model:embed', { kind : 'model', attributes : { 'model.name' : 'e' } } );

        expect( projectGenAIAttributes( model ) ).toEqual( 
            {
                'gen_ai.operation.name'                : 'chat',
                'gen_ai.provider.name'                 : 'gcp.gemini',
                'gen_ai.usage.input_tokens'            : 9,
                'gen_ai.usage.output_tokens'           : 4,
                'gen_ai.usage.cache_read.input_tokens' : 3,
                'gen_ai.usage.reasoning.output_tokens' : 2
            } );
        expect( projectGenAIAttributes( tool ) ).toEqual( { 'gen_ai.operation.name' : 'execute_tool', 'gen_ai.tool.name' : 'x' } );
        expect( projectGenAIAttributes( mcp ) ).toEqual( { 'gen_ai.tool.name' : 'y' } );
        expect( projectGenAIAttributes( agent ) ).toEqual( { 'gen_ai.operation.name' : 'invoke_agent', 'gen_ai.agent.id' : 'a1', 'gen_ai.conversation.id' : 't1' } );
        expect( projectGenAIAttributes( bare ) ).toEqual( {} );
        expect( projectGenAIAttributes( emb )[GENAI_ATTR.OPERATION_NAME] ).toBe( 'embeddings' );
    } );

    it( 'computes semconv span names and falls back to native names', () => 
    {
        const chat = new SpanImpl( 'model:generate', { attributes : { 'gen_ai.operation.name' : 'chat', 'gen_ai.request.model' : 'gpt' } } );
        const tool = new SpanImpl( 'tool:run:x', { attributes : { 'gen_ai.operation.name' : 'execute_tool', 'gen_ai.tool.name' : 'x' } } );
        const agent = new SpanImpl( 'agent:run', { attributes : { 'gen_ai.operation.name' : 'invoke_agent', 'gen_ai.agent.id' : 'a1' } } );
        const agentNamed = new SpanImpl( 'agent:run', { attributes : { 'gen_ai.operation.name' : 'invoke_agent', 'gen_ai.agent.id' : 'a1', 'gen_ai.agent.name' : 'support' } } );
        const noModel = new SpanImpl( 'm', { attributes : { 'gen_ai.operation.name' : 'chat' } } );
        const native = new SpanImpl( 'agent:step:1' );

        expect( toGenAISpanName( chat ) ).toBe( 'chat gpt' );
        expect( toGenAISpanName( tool ) ).toBe( 'execute_tool x' );
        expect( toGenAISpanName( agent ) ).toBe( 'invoke_agent a1' );
        expect( toGenAISpanName( agentNamed ) ).toBe( 'invoke_agent support' );
        expect( toGenAISpanName( noModel ) ).toBe( 'chat' );
        expect( toGenAISpanName( native ) ).toBe( 'agent:step:1' );
    } );
} );

describe( 'Agent run GenAI attributes (AE6)', () => 
{
    async function runAgent( withTracker: boolean )
    {
        const collector = new TraceCollector();
        const agent = new Agent( { model : agentModel(), tools : [ lookup ], ...( withTracker ? { spendTracker : new SpendTracker() } : {} ) } );
        let completed: Trace | undefined;

        collector.on( 'trace:complete', ( t ) => {completed = t;} );
        await agent.run( 'hi', { threadId : 'thread-1', agentId : 'agent-1', collector } );

        return completed!;
    }

    it.each( [ false, true ] )( 'exports chat tokens, tool name and agent ids (tracker=%s)', async ( withTracker ) => 
    {
        const trace = await runAgent( withTracker );
        const spans = spansOf( trace );
        const models = spans.filter( ( s ) => {return s.name === 'model:generate';} );
        const tool = spans.find( ( s ) => {return s.name === 'tool:run:lookup';} )!;
        const run = spans.find( ( s ) => {return s.name === 'agent:run';} )!;

        expect( models ).toHaveLength( 2 );
        expect( attrOf( models[0]!, 'gen_ai.usage.input_tokens' ) ).toEqual( { intValue : '120' } );
        expect( attrOf( models[0]!, 'gen_ai.usage.output_tokens' ) ).toEqual( { intValue : '30' } );
        expect( attrOf( models[0]!, 'gen_ai.usage.cache_read.input_tokens' ) ).toEqual( { intValue : '40' } );
        expect( attrOf( models[0]!, 'gen_ai.operation.name' ) ).toEqual( { stringValue : 'chat' } );
        expect( attrOf( models[0]!, 'gen_ai.provider.name' ) ).toEqual( { stringValue : 'gcp.gemini' } );
        expect( attrOf( models[0]!, 'gen_ai.request.model' ) ).toEqual( { stringValue : 'gemini-2.0-flash' } );
        expect( attrOf( models[0]!, 'gen_ai.response.finish_reasons' ) ).toEqual( { arrayValue : { values : [ { stringValue : 'tool_calls' } ] } } );
        expect( attrOf( models[0]!, 'model.provider' ) ).toEqual( { stringValue : 'gemini' } );
        expect( attrOf( models[0]!, 'metrics.promptTokens' ) ).toEqual( { intValue : '120' } );
        expect( attrOf( models[1]!, 'gen_ai.response.finish_reasons' ) ).toEqual( { arrayValue : { values : [ { stringValue : 'stop' } ] } } );
        expect( attrOf( tool, 'gen_ai.operation.name' ) ).toEqual( { stringValue : 'execute_tool' } );
        expect( attrOf( tool, 'gen_ai.tool.name' ) ).toEqual( { stringValue : 'lookup' } );
        expect( attrOf( tool, 'gen_ai.tool.call.id' ) ).toEqual( { stringValue : 'call_1' } );
        expect( attrOf( tool, 'tool.name' ) ).toEqual( { stringValue : 'lookup' } );
        expect( attrOf( run, 'gen_ai.operation.name' ) ).toEqual( { stringValue : 'invoke_agent' } );
        expect( attrOf( run, 'gen_ai.agent.id' ) ).toEqual( { stringValue : 'agent-1' } );
        expect( attrOf( run, 'gen_ai.conversation.id' ) ).toEqual( { stringValue : 'thread-1' } );
        expect( attrOf( run, 'agent.threadId' ) ).toEqual( { stringValue : 'thread-1' } );
    } );

    it( 'spanNameStyle genai rewrites names at export only; native keeps hierarchy names', async () => 
    {
        const trace = await runAgent( false );
        const native = spansOf( trace ).map( ( s ) => {return s.name;} );
        const genai = spansOf( trace, { spanNameStyle : 'genai' } ).map( ( s ) => {return s.name;} );

        expect( native ).toContain( 'agent:run' );
        expect( native.some( ( n ) => {return n.startsWith( 'agent:step:' );} ) ).toBe( true );
        expect( genai ).toContain( 'invoke_agent agent-1' );
        expect( genai ).toContain( 'chat gemini-2.0-flash' );
        expect( genai ).toContain( 'execute_tool lookup' );
        expect( genai.filter( ( n ) => {return n.startsWith( 'agent:step:' );} ).length ).toBeGreaterThan( 0 );
        expect( trace.rootSpan.name ).toBe( 'agent:run' );
    } );

    it( 'genaiCompat legacy and both spell provider and token attributes the older way', async () => 
    {
        const trace = await runAgent( false );
        const model = ( o: object ) => {return spansOf( trace, o ).find( ( s ) => {return s.name === 'model:generate';} )!;};

        const legacy = model( { genaiCompat : 'legacy' } );

        expect( attrOf( legacy, 'gen_ai.system' ) ).toEqual( { stringValue : 'gcp.gemini' } );
        expect( attrOf( legacy, 'gen_ai.usage.prompt_tokens' ) ).toEqual( { intValue : '120' } );
        expect( attrOf( legacy, 'gen_ai.usage.completion_tokens' ) ).toEqual( { intValue : '30' } );
        expect( attrOf( legacy, 'gen_ai.provider.name' ) ).toBeUndefined();
        expect( attrOf( legacy, 'gen_ai.usage.input_tokens' ) ).toBeUndefined();

        const both = model( { genaiCompat : 'both' } );

        expect( attrOf( both, 'gen_ai.system' ) ).toBeDefined();
        expect( attrOf( both, 'gen_ai.provider.name' ) ).toBeDefined();
        expect( attrOf( both, 'gen_ai.usage.input_tokens' ) ).toBeDefined();
        expect( attrOf( both, 'gen_ai.usage.prompt_tokens' ) ).toBeDefined();
    } );

    it( 'projectGenAI:false exports only what instrumentation set', () => 
    {
        const root = new SpanImpl( 'agent:run', { kind : 'agent', startTime : 1, attributes : { 'agent.id' : 'a' } } );

        root.end( 2 );

        const trace: Trace = { traceId : root.traceId, startTime : 1, endTime : 2, rootSpan : root, totalSpendUSD : 0, categorySpend : root.categorySpend };

        computeTraceRollup( trace );
        expect( attrOf( spansOf( trace )[0]!, 'gen_ai.agent.id' ) ).toBeDefined();
        expect( attrOf( spansOf( trace, { projectGenAI : false } )[0]!, 'gen_ai.agent.id' ) ).toBeUndefined();
        expect( exportTracesToOTLP( [ trace ], { projectGenAI : false } ).resourceSpans ).toHaveLength( 1 );
    } );
} );

describe( 'Standalone model telemetry (MeteredModel / embeddings / decisions)', () => 
{
    it( 'MeteredModel with a context creates its own model span with tokens and spend', async () => 
    {
        const collector = new TraceCollector();
        const { rootSpan, context, trace } = collector.startTrace( { name : 'job' } );
        const model = createMeteredModel( agentModel(), { tracker : new SpendTracker(), context } );

        await model.generate( { messages : [ { role : 'user', content : 'x' } ], temperature : 0.3, maxTokens : 99 } );
        rootSpan.end();
        collector.endTrace( trace.traceId );

        const [ child ] = rootSpan.children;

        expect( rootSpan.children ).toHaveLength( 1 );
        expect( child!.name ).toBe( 'model:generate' );
        expect( child!.endTime ).toBeDefined();
        expect( child!.attributes ).toMatchObject( { 'gen_ai.usage.input_tokens' : 120, 'gen_ai.request.temperature' : 0.3, 'gen_ai.request.max_tokens' : 99 } );
    } );

    it( 'MeteredModel streaming span ends with usage and also when the consumer abandons the stream', async () => 
    {
        const collector = new TraceCollector();
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const inner: ModelProtocol = 
            {
                provider : 'openai', model : 'gpt',
                generate : vi.fn(),
                stream   : async function* ()
                {
                    yield { deltaContent : 'a' };
                    yield { deltaContent : 'b', finishReason : 'stop' as const, usage : { promptTokens : 3, completionTokens : 2, totalTokens : 5 } };
                }
            };
        const model = createMeteredModel( inner, { tracker : new SpendTracker(), context } );

        for await ( const _chunk of model.stream( { messages : [] } ) ){ void _chunk }

        for await ( const _chunk of model.stream( { messages : [] } ) ){ break }

        const [ done, abandoned ] = rootSpan.children;

        expect( done!.name ).toBe( 'model:stream' );
        expect( done!.endTime ).toBeDefined();
        expect( done!.attributes ).toMatchObject( { 'gen_ai.usage.input_tokens' : 3, 'gen_ai.response.finish_reasons' : [ 'stop' ] } );
        expect( abandoned!.endTime ).toBeDefined();
    } );

    it( 'a failing model call marks the standalone span as error', async () => 
    {
        const collector = new TraceCollector();
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const inner: ModelProtocol = { provider : 'openai', model : 'gpt', generate : vi.fn( async () => {throw new TypeError( 'bad' );} ), stream : vi.fn() };
        const model = createMeteredModel( inner, { tracker : new SpendTracker(), context } );

        await expect( model.generate( { messages : [] } ) ).rejects.toThrow( 'bad' );
        expect( rootSpan.children[0]!.status ).toBe( 'error' );
        expect( rootSpan.children[0]!.errorDetails?.name ).toBe( 'TypeError' );
        expect( rootSpan.children[0]!.endTime ).toBeDefined();
    } );

    it( 'without getSpan or context nothing is traced and behavior is unchanged', async () => 
    {
        const model = createMeteredModel( agentModel(), { tracker : new SpendTracker() } );
        const response = await model.generate( { messages : [] } );

        expect( response.content ).toBe( '' );
    } );

    it( 'embeddings spans carry operation=embeddings, tokens and dimensions (R10a)', async () => 
    {
        const collector = new TraceCollector();
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const inner = { provider : 'openai', model : 'text-embedding-3-small', embed : vi.fn( async () => {return { vectors : [ [ 0.1, 0.2, 0.3 ] ], model : 'm', usage : { promptTokens : 8, completionTokens : 0, totalTokens : 8 }, raw : {} };} ) };
        const model = createMeteredEmbeddingModel( inner, { tracker : new SpendTracker(), context } );

        await model.embed( 'hello' );

        expect( rootSpan.children[0]!.name ).toBe( 'model:embed' );
        expect( rootSpan.children[0]!.attributes ).toMatchObject( { 'gen_ai.operation.name' : 'embeddings', 'gen_ai.embeddings.dimension.count' : 3, 'gen_ai.usage.input_tokens' : 8 } );

        const viaGetter = new SpanImpl( 'x', { kind : 'model' } );

        await createMeteredEmbeddingModel( inner, { tracker : new SpendTracker(), getSpan : () => {return viaGetter;} } ).embed( 'a' );
        expect( viaGetter.attributes['gen_ai.operation.name'] ).toBe( 'embeddings' );

        inner.embed.mockRejectedValueOnce( new Error( 'nope' ) );
        await expect( model.embed( 'x' ) ).rejects.toThrow( 'nope' );
        expect( rootSpan.children[1]!.status ).toBe( 'error' );
    } );

    it( 'decision spans get GenAI attributes and usage', async () => 
    {
        const collector = new TraceCollector();
        const { rootSpan, context } = collector.startTrace( { name : 'job' } );
        const decider = { provider : 'jev', model : 'jev-1', decide : vi.fn( async () => {return { answers : {}, calibrated : true, usage : { promptTokens : 11, completionTokens : 1, totalTokens : 12 } };} ) };

        await decideWithContext( context, decider as never, { questions : { q : { question : 'x', choices : [ 'a' ] } } } as never );

        const span = rootSpan.children[0]!;

        expect( span.attributes ).toMatchObject( { 'gen_ai.operation.name' : 'chat', 'gen_ai.request.model' : 'jev-1', 'gen_ai.usage.input_tokens' : 11 } );
    } );
} );
