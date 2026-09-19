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
import { z } from 'zod';
import { createModel, createTool, Agent, MemoryDocStore, CheckpointManager } from '@webergency-utils/ai';

// 1. Resolve model dynamically with zero external dependencies
const model = createModel( {
    provider : 'openai',
    model    : 'gpt-4o'
});

// 2. Define strongly-typed tools with Zod schemas
const weatherTool = createTool( {
    name        : 'get_weather',
    description : 'Get the current weather forecast for a city',
    parameters  : z.object( {
        city : z.string().describe( 'City name' )
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
npm install @webergency-utils/ai zod
```

### Peer Dependencies

The core library ships with zero required external dependencies outside of `zod`. Official vendor SDKs are optional peer dependencies loaded lazily if you choose to bridge an existing SDK client instance:

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
- **`Tool`**: Executable function unit bundling a Zod or JSON Schema parameter validator, description, and execution logic.
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

### Model Context Protocol (MCP)

#### MCP Server

Expose local toolkit tools to Cursor, Claude Desktop, or external MCP clients:

```typescript
import { MCPServer, createTool } from '@webergency-utils/ai';
import { z } from 'zod';

const server = new MCPServer( { name : 'analytics-server', version : '1.0.0' } );

server.registerTool( {
    name        : 'query_metric',
    description : 'Query daily active users metric',
    parameters  : z.object( { date : z.string() } )
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
const toolDefs = await client.toToolDefinitions(); // Bindable directly to Agent
```

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
