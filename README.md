# @webergency-utils/ai

High-performance, developer-first TypeScript AI toolkit providing protocol-level model execution, multimodal support, dynamic provider imports, abstract storage contracts, token spend tracking, Model Context Protocol (MCP) tooling, and autonomous agent orchestration for Node.js (20+) and Bun.

[![npm version](https://img.shields.io/npm/v/%40webergency-utils%2Fai)](https://www.npmjs.com/package/@webergency-utils/ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen.svg)](#maintenance)
[![dependencies](https://img.shields.io/badge/dependencies-1-brightgreen.svg)](https://www.npmjs.com/package/@webergency-utils/ai?activeTab=dependencies)
[![npm downloads](https://img.shields.io/npm/dm/%40webergency-utils%2Fai)](https://www.npmjs.com/package/@webergency-utils/ai)<br>
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/webergency-utils/ai/badge)](https://securityscorecards.dev/viewer/?uri=github.com/webergency-utils/ai)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](#)
[![CI](https://github.com/webergency-utils/ai/actions/workflows/ci.yml/badge.svg)](https://github.com/webergency-utils/ai/actions/workflows/ci.yml)
[![CodeQL](https://github.com/webergency-utils/ai/actions/workflows/codeql.yml/badge.svg)](https://github.com/webergency-utils/ai/actions/workflows/codeql.yml)

## TL;DR

```typescript
import { createModel, createTool, Agent, MemoryDocStore, CheckpointManager, schema } from '@webergency-utils/ai';

// 1. Resolve model dynamically with zero external dependencies
const model = createModel( {
    provider : 'openai',
    model    : 'gpt-4o'
});

// 2. Define strongly-typed tools with schemas
const weatherTool = createTool( {
    name        : 'get_weather',
    description : 'Get the current weather forecast for a city',
    parameters  : schema.object( {
        city : schema.string().describe( 'City name' )
    }),
    execute : async ( args ) => 
    {
        return { city : args.city, temp : '21C', condition : 'Sunny' };
    }
});

// 3. Instantiate checkpointed autonomous agent
const agent = new Agent( {
    model,
    instructions      : 'You are a helpful weather assistant.',
    tools             : [ weatherTool ],
    checkpointManager : new CheckpointManager( new MemoryDocStore() )
});

// 4. Run multi-turn tool calling loop with state persistence
const result = await agent.run( 'What is the weather in Prague right now?' );
console.log( result.text );
// "The weather in Prague is currently 21C and Sunny."
```

## Installation & Setup

Install the core package using your preferred package manager:

```bash
npm install @webergency-utils/ai
```

### Peer Dependencies

The core library ships with zero required external dependencies outside of `@webergency-utils/typechecker`. Official vendor SDKs are optional peer dependencies loaded lazily if you choose to bridge an existing SDK client instance:

```bash
# Optional: only if using the SDK bridge rather than built-in native fetch adapters
npm install openai @anthropic-ai/sdk @google/genai ollama
```

### Environment Variables

When using built-in native REST/SSE adapters without explicitly providing `apiKey` in `ModelConfig`, the toolkit automatically inspects the environment:

| Variable | Provider | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | `openai` | OpenAI platform access token |
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic Messages API key |
| `GEMINI_API_KEY` | `gemini` | Google AI Gemini API key |
| `GROQ_API_KEY` | `groq` | Groq Cloud fast inference key |
| `TYPESAFE_API_KEY` | `typesafe` (`jev`) | TypeSafe Jev decision model key |

## Architecture & Internals

`@webergency-utils/ai` is structured around a protocol-first design that decouples consumer applications from vendor SDK churn:

```text
┌────────────────────────────────────────────────────────┐
│                  Consumer Application                  │
│       agent.run()  │  workflow.execute()  │  MCP       │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│               @webergency-utils/ai Core                │
│                                                        │
│  ModelRegistry ──► BaseProviderAdapter (Native Fetch)   │
│         │               ├─ OpenAI (REST / SSE)         │
│         │               ├─ Anthropic (Messages / SSE)  │
│         │               ├─ Gemini (Generate / SSE)     │
│         │               ├─ Groq & Ollama               │
│         │               └─ Optional SDK Lazy Bridge    │
│         │                                              │
│         ▼                                              │
│  SpendEngine ◄───── Provider Raw Telemetry Metrics     │
│                                                        │
│  Storage Subsystem ◄── IDocumentStore, IVectorStore    │
│  Checkpoints       ◄── IFileStore, ICacheStore         │
│                                                        │
│  Orchestration     ◄── Autonomous Agent & Step DAG     │
└────────────────────────────────────────────────────────┘
```

- **Wire Metal Access**: Built-in HTTP and SSE streaming adapters use native `fetch` and `TransformStream` to ensure sub-millisecond cold starts in serverless and container runtimes.
- **Provider Raw Escape Hatch**: Every `ModelResponse` and stream chunk carries an unaltered `raw` wire payload, granting immediate access to new lab capabilities (thinking/reasoning tokens, search results, computer use) before library updates occur.
- **Exact Spend Calculation**: Telemetry extracts exact vendor token metrics (prompt tokens, reasoning tokens, cache creation, cache read) directly from response headers/bodies and computes precise monetary costs against an extensible `PriceMap`.
- **Durable Checkpoints**: State is serialized into `IDocumentStore` after each tool invocation and transition, preventing data loss on process crashes and allowing zero-loss resumption.

## Glossary

- **`ModelProtocol`**: Normalized interface (`generate`, `stream`) implemented by all provider adapters.
- **`ModelRegistry`**: Dynamic provider resolver that instantiates and caches provider adapters without boot-time static vendor imports.
- **`BaseProviderAdapter`**: Abstract adapter base class handling HTTP request serialization, streaming SSE parsing, and standardized error mapping.
- **`Tool`**: Executable function unit bundling a JSON Schema / typechecker parameter validator, description, and execution logic.
- **`Agent`**: Autonomous multi-turn agent loop executing tools, persisting checkpoints, and aggregating spend.
- **`Workflow`**: Directed Acyclic Graph (DAG) builder supporting typed steps, retries, conditional branches, and Human-in-the-Loop interrupts (`WaitNode`).
- **`WorkflowRunner`**: Execution engine running workflow DAGs, capturing step checkpoints, suspending on external signals, and resuming state.
- **`MCPClient`**: Client implementing the Model Context Protocol over stdio child processes or HTTP SSE streams.
- **`MCPServer`**: Server utility exposing local tools and agents as an MCP-compliant JSON-RPC service.
- **`SpendCalculator`**: Financial engine computing exact USD token spend accounting for prompt caching discounts and reasoning models.
- **`SpendTracker`**: Aggregator tracking token spend across runs, threads, and agents with hard budget cap guardrails.

## API Reference

### Dynamic Model Provider Resolution

#### `createModel( config: ModelConfig ): ModelProtocol`

Resolves and caches a model provider adapter.

```typescript
import { createModel } from '@webergency-utils/ai';

const model = createModel( {
    provider    : 'anthropic',
    model       : 'claude-3-7-sonnet-20250219',
    temperature : 0.7
});

const response = await model.generate( {
    messages : [ { role : 'user', content : 'Summarize modern distributed systems architecture' } ]
});
console.log( response.content );
```

#### Streaming SSE Generation

```typescript
for await ( const chunk of model.stream( { messages : [ { role : 'user', content : 'Stream a poem' } ] } ) )
{
    process.stdout.write( chunk.deltaContent );
}
```

### Storage Subsystem

The toolkit provides abstract interfaces with zero-dependency reference implementations for all major persistence tiers:

```typescript
import { 
    MemoryDocStore, 
    MemoryVectorStore, 
    MemoryCacheStore, 
    LocalDiskFileStore 
} from '@webergency-utils/ai';

// 1. Documents & Checkpoints
const docStore = new MemoryDocStore();
await docStore.set( 'users', 'u_101', { name : 'Alice', tier : 'pro' } );
const user = await docStore.get( 'users', 'u_101' );

// 2. Vector Store & Cosine Similarity
const vectorStore = new MemoryVectorStore();
await vectorStore.upsert( [
    { id : 'vec_1', values : [ 1, 0, 0 ], content : 'Vector math' }
] );
const matches = await vectorStore.query( [ 0.95, 0.05, 0 ], 1 );

// 3. Memory & TTL Cache Store
const cache = new MemoryCacheStore( { maxEntries : 5000 } );
await cache.set( 'session_token', { userId : 'u_101' }, 3600 );

// 4. Local Disk File Store
const fileStore = new LocalDiskFileStore( './data/storage' );
await fileStore.write( 'reports/monthly.pdf', new Uint8Array( [ 0x25, 0x50, 0x44, 0x46 ] ) );
```

### Spend Tracking & Pricing Engine

Extract exact provider-reported metrics and compute costs:

```typescript
import { calculateSpend, SpendTracker } from '@webergency-utils/ai';

const tracker = new SpendTracker( { maxBudgetUSD : 5.00 } );

const spend = tracker.record( 'claude-3-7-sonnet-20250219', {
    promptTokens            : 400,
    completionTokens        : 150,
    totalTokens             : 550,
    cachedPromptReadTokens  : 1600,
    cachedPromptWriteTokens : 200
});

console.log( spend.totalCost ); // Calculated with exact prompt-caching discounts
```

#### Dynamic Pricing Sync & Local Registry

Keep model pricing continuously up-to-date with event-driven notifications and automatic periodic synchronization:

```typescript
import { 
    LocalPricingRegistry, 
    PricingSyncService, 
    OpenRouterPricingSource, 
    defaultPricingRegistry 
} from '@webergency-utils/ai';

// 1. Subscribe to pricing change events
defaultPricingRegistry.on( 'change', ( event ) => {
    console.log( `Price updated for ${ event.model }:`, event.current );
});

// 2. Local registry with custom user updater and periodic refresh
const localRegistry = new LocalPricingRegistry( {
    refreshIntervalMs : 60_000,
    updater           : async () => {
        return {
            'custom-internal-model' : { inputPerMillion : 0.50, outputPerMillion : 1.00 }
        };
    },
    autoStart : true
});

// Update manually at any time
localRegistry.update( 'custom-internal-model', { inputPerMillion : 0.40, outputPerMillion : 0.80 } );

// 3. Automated background sync from public catalog (OpenRouter or LiteLLM)
const syncService = new PricingSyncService( {
    registry   : defaultPricingRegistry,
    source     : new OpenRouterPricingSource(),
    intervalMs : 24 * 60 * 60 * 1000 // Every 24 hours
} );

// Non-blocking timer that unrefs automatically
syncService.startAutoSync();
```

#### Multi-Category Telemetry & Budget Enforcement

Track operational spend across all dimensions—model inference, storage operations, compute runtime, network transport, MCP calls, and paid tools—with unified budgets, soft warning thresholds, and dynamic unit rate resolution:

```typescript
import { 
    SpendTracker, 
    UnitCostRegistry, 
    createTool, 
    MemoryVectorStore, 
    Agent,
    schema
} from '@webergency-utils/ai';

// 1. Configure SpendTracker with aggregate cap and category ceilings
const tracker = new SpendTracker( {
    maxBudgetUSD     : 10.00,
    categoryBudgets  : {
        tools   : 1.00,
        storage : 0.50
    },
    warningThreshold : 0.8 // Soft warning at 80% of any budget limit
} );

// 2. Subscribe to early warning alerts before hard breaches occur
tracker.on( 'warning', ( event ) => {
    console.warn( `[Budget Alert] ${event.category} spend reached ${event.percentage.toFixed( 1 )}% ($${event.currentSpend.toFixed( 4 )}/$${event.budgetLimit.toFixed( 4 )})` );
} );

// 3. Define custom unit pricing or use built-in defaults
const unitPricing = new UnitCostRegistry();
unitPricing.register( 'storage:vector_query', 0.0001 ); // $0.0001 per query

// 4. Dual-level storage metering: auto-report or per-call context override
const vectorStore = new MemoryVectorStore( {
    tracker,
    storagePricing : unitPricing
} );

// 5. Tools report spend ambiently without altering business return signatures
const paidSearchTool = createTool( {
    name        : 'web_search',
    description : 'Execute paid web search API',
    parameters  : schema.object( { query : schema.string() } ),
    execute     : async ( args, context ) => {
        // Direct USD cost reporting
        context?.reportSpend( {
            category    : 'tools',
            subcategory : 'web_search',
            costUSD     : 0.005
        } );
        return `Top results for: ${args.query}`;
    }
} );

// 6. Inspect unified telemetry breakdown
console.log( tracker.totalSpendUSD );
console.log( tracker.categorySpend );
// { model: 0.012, storage: 0.001, compute: 0, network: 0.0002, mcp: 0, tools: 0.005, custom: 0 }
```

### Model Context Protocol (MCP)


#### MCP Server

Expose local toolkit tools to Cursor, Claude Desktop, or external MCP clients:

```typescript
import { MCPServer, createTool, schema } from '@webergency-utils/ai';

const server = new MCPServer( { name : 'analytics-server', version : '1.0.0' } );

server.registerTool( {
    name        : 'query_metric',
    description : 'Query daily active users metric',
    parameters  : schema.object( { date : schema.string() } )
}, async ( args ) => {
    return { activeUsers : 42100 };
});
```

#### MCP Client

Connect to external MCP servers via `stdio` or `SSE`:

```typescript
import { MCPClient, StdioTransport } from '@webergency-utils/ai';

const transport = new StdioTransport( 'npx', [ '-y', '@modelcontextprotocol/server-memory' ] );
const client = new MCPClient( transport );
await client.connect();

const tools = await client.listTools();
const toolDefs = await client.toToolDefinitions(); // Definitions only (no `execute`)
```

#### Using MCP tools in an Agent

`createMCPTools( client, options? )` turns every tool of a connected `MCPClient` into an executable agent `Tool`. Calls forward the agent's `ExecutionContext` and abort signal, so MCP spans and spend nest under `tool:run:*`.

```typescript
import { Agent, MCPClient, createMCPTools } from '@webergency-utils/ai';

const mcpTools = await createMCPTools( client, {
    prefix  : 'mem_',                       // optional: prepended to bound names
    include : /^(read|search)_/,            // optional: string[] | RegExp on server-side names
    exclude : [ 'delete_all' ]              // optional: applied after `include`
} );

const agent = new Agent( { model, tools : mcpTools } );
```

Failures are loud: `isError` results throw `MCP_TOOL_ERROR` (the agent shows the model `Error: ...`), non-text content throws `MCP_UNSUPPORTED_CONTENT` instead of being dropped, duplicate names throw `MCP_DUPLICATE_TOOL`, and input schemas the validator cannot compile throw `MCP_UNSUPPORTED_SCHEMA` at bind time.

### Agent: Streaming, Parallel Tools, Guardrails & Structured Output

`Agent.run()` and `Agent.runStream()` share one step engine (checkpoints, spans, spend). `runStream()` yields typed `AgentEvent`s as the model streams; the last event is `finish` with the `AgentResult`.

```typescript
for await ( const event of agent.runStream( 'Weather in Prague and Berlin?' ) )
{
    switch( event.type )
    {
        case 'text:delta'  : process.stdout.write( event.delta ); break;
        case 'tool:call'   : console.log( 'calling', event.toolCall.name ); break;
        case 'tool:result' : console.log( event.name, event.isError ? 'failed' : 'ok' ); break;
        case 'finish'      : console.log( event.result.spendUSD ); break;
    }
}
```

Event order per step: `step:start`, `text:delta` / `reasoning:delta`, `tool:call` (only after the call JSON is assembled and schema-validated), `tool:result` (always in model-call order), `step:finish`. Malformed tool JSON throws out of the iterator. Leaving the loop early, or aborting `options.signal`, cancels the request and saves an `interrupted` checkpoint.

**Parallel tools.** `toolConcurrency: 4` runs the tool calls of one model turn with at most four in flight (default `1`). Results are appended and checkpointed in call order, so `resume()` re-runs only uncommitted calls. A `CancelledError` / `BudgetRefusedError` aborts sibling tools and is rethrown; mark shared-state tools with `parallelSafe: false` to run them alone.

**Guardrails.** Plain functions returning `{ allow : true }` or `{ allow : false, reason, tripwire? }`:

```typescript
const agent = new Agent( {
    model,
    tools,
    guardrails : {
        input      : [ ( { messages } ) => { return looksLikeInjection( messages ) ? { allow : false, reason : 'injection' } : { allow : true }; } ],
        toolCall   : [ ( call ) => { return call.name.startsWith( 'delete_' ) ? { allow : false, reason : 'destructive' } : { allow : true }; } ],
        toolResult : [ ( { result } ) => { return result.includes( 'SECRET' ) ? { allow : false, reason : 'leak', tripwire : true } : { allow : true }; } ],
        output     : [ async ( { text } ) => { return await moderate( text ) ? { allow : true } : { allow : false, reason : 'moderation' }; } ]
    }
} );
```

A tool-level deny is shown to the model as `Error: blocked by guardrail: <reason>` and the tool is not executed. An `input` / `output` deny, a `tripwire` deny, or a guardrail that throws (fail closed) raises `GuardrailTripwireError` (`stage`, `reason`) and saves the thread as `blocked`; history is rolled back to the last safe point. `input` guardrails do not run again on `resume()`.

**Structured output.** `outputSchema` makes the result carry a validated `output`:

```typescript
const agent = new Agent( { model, tools, outputSchema : schema.object( { city : schema.string(), tempC : schema.number() } ) } );
const { output } = await agent.run( 'Weather in Prague?' ); // { city, tempC }
```

The model must report `capabilities.structuredOutput` (construction throws a `CapabilityError` otherwise). The default `outputStrategy: 'finalize'` runs the tool loop normally and then makes one extra tool-less call with the schema; `'inline'` sends the schema on every step and needs a provider that supports schema together with tools. On `step_limit` no `output` is produced.

### Step-Based Workflow Engine (DAG & HITL)

Build resilient directed acyclic graph workflows with Human-in-the-Loop interrupts:

```typescript
import { Workflow, WorkflowRunner, MemoryDocStore } from '@webergency-utils/ai';

const workflow = new Workflow( 'content-publishing' );

workflow
    .step( 'draft_article', async () => {
        return { title : 'Agentic AI', body : 'Draft text...' };
    })
    .wait( 'editor_review', { dependencies : [ 'draft_article' ] } )
    .step( 'publish_article', async ( input, ctx ) => {
        const approval = ctx.stepOutputs.editor_review as { approved: boolean };
        const draft = ctx.stepOutputs.draft_article as { title: string };
        return { published : approval.approved, title : draft.title };
    }, { dependencies : [ 'editor_review' ] } );

const runner = new WorkflowRunner( workflow, { checkpointStore : new MemoryDocStore() } );

// 1. Initial execution suspends at wait node
const initialRun = await runner.execute( {}, 'article-run-1' );
console.log( initialRun.status ); // 'suspended'

// 2. Resume execution with external decision payload
const finalRun = await runner.resume( 'article-run-1', { approved : true } );
console.log( finalRun.status ); // 'completed'
```

### Decision Models (Jev) & Decision Steps

A decision model takes input data plus named, typed questions and returns one typed answer per question, with probabilities. TypeSafe's Jev is the native implementation (native HTTP, no SDK needed); any `LanguageModel` with structured output can stand in.

```typescript
import { createDecisionModel, question } from '@webergency-utils/ai';

const questions = {
    team    : question.choice( { billing : 'Payments, invoices', technical : 'Bugs, outages', other : null } ),
    urgency : question.score( [ 'can wait', 'today', 'right now' ] ),
    refund  : question.yesNo( { instructions : 'Will the customer demand a refund?' } )
};

// Jev: reads TYPESAFE_API_KEY; pin a version or use the default 'jev-latest'
const jev = createDecisionModel( { provider : 'typesafe', model : 'jev-latest' } );
// Or any language model with structured output (answers are marked calibrated: false)
const standIn = createDecisionModel( { provider : 'openai', model : 'gpt-4o' } );

const { answers, calibrated } = await jev.decide( { input : { subject : 'Charged twice' }, questions } );

answers.team.value;             // 'billing' | 'technical' | 'other' (a misspelled label fails to compile)
answers.team.probabilities;     // { billing : 0.88, technical : 0.12, other : 0 }
answers.urgency.value;          // probability-weighted level, e.g. 1.05
answers.refund.probability;     // 0..1
```

Question types: `question.choice` (1–255 labels), `question.score` (2–10 levels), `question.yesNo`. Vendor wire names (Jev's `noul`) stay inside the adapter. Requests over the model's input limit fail with `InputLimitError`; input is never truncated. Cancellation, timeouts, and retries match language-model calls; wrap with `createMeteredDecisionModel` or use `decideWithContext` for spend and trace spans (Jev is priced on input tokens only).

A workflow decision step asks its questions in one call and a typed routing function picks the single branch that runs:

```typescript
workflow
    .decision( 'triage', {
        model        : jev,
        questions,
        dependencies : [ 'intake' ],
        input        : ( ticket ) => ticket,
        branches     : { billing : 'billing_flow', technical : 'tech_flow' }, // branch name -> node id
        route        : ( answers ) => answers.team.value === 'billing' ? 'billing' : 'technical',
        retries      : 2 // a failed call follows the workflow retry policy; no other model is tried
    } );
```

The answers are saved in the checkpoint as the step output, so a resumed run does not ask again.

## Troubleshooting

### Missing optional vendor SDK

When wrapping official vendor SDK clients via `SDKBridgeAdapter` without installing the optional peer package, the toolkit throws `MissingDependencyError` with the exact copy-pasteable installation command:

```text
MissingDependencyError: Missing dependency: please install @anthropic-ai/sdk using 'npm install @anthropic-ai/sdk'
```

*Remedy*: Install the requested vendor SDK via `npm install <package>` or switch to the built-in zero-dependency native fetch adapter (`createModel({ provider: 'anthropic', model: 'claude-3-7-sonnet' })`).

### Rate limit 429 response

When an upstream AI lab rate limits an endpoint, the adapter throws `RateLimitError` carrying `retryAfterSeconds` parsed from the provider's `retry-after` HTTP header.

*Remedy*: Wrap generation calls in a retry handler inspecting `err.retryAfterSeconds`.

## Maintenance

This package is actively maintained.

Bug reports and pull requests are welcome. Security issues and critical
regressions are prioritized. New features are considered when they align
with the package's existing scope.
