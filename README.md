# @webergency-utils/ai

High-performance, developer-first TypeScript AI toolkit providing protocol-level model execution, multimodal support, dynamic provider imports, abstract storage contracts, token spend tracking, Model Context Protocol (MCP) tooling, and autonomous agent orchestration. ESM-only, for Node.js `>=20.3.0` (Bun smoke-tested, see [Runtime support](#runtime-support)).

[![npm version](https://img.shields.io/npm/v/%40webergency-utils%2Fai)](https://www.npmjs.com/package/@webergency-utils/ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Maintenance](https://img.shields.io/badge/maintenance-active-brightgreen.svg)](#maintenance)
[![npm downloads](https://img.shields.io/npm/dm/%40webergency-utils%2Fai)](https://www.npmjs.com/package/@webergency-utils/ai)<br>
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/webergency-utils/ai/badge)](https://securityscorecards.dev/viewer/?uri=github.com/webergency-utils/ai)
[![CI](https://github.com/webergency-utils/ai/actions/workflows/ci.yml/badge.svg)](https://github.com/webergency-utils/ai/actions/workflows/ci.yml)
[![CodeQL](https://github.com/webergency-utils/ai/actions/workflows/codeql.yml/badge.svg)](https://github.com/webergency-utils/ai/actions/workflows/codeql.yml)

## TL;DR

<!-- check -->
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
        city : schema.string( { description : 'City name' } )
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

### Runtime support

| Runtime | Status |
|---|---|
| Node.js `>=20.3.0` | Full test suite on Node 20, 22 and 24 (Linux), plus Node 22 on Windows and macOS. |
| Bun | Smoke-tested in CI: the packed tarball is imported under Bun, and the core, provider (recorded replay), in-memory storage and in-memory MCP test files run under `bun x --bun vitest`. The full suite (and the Node-specific storage drivers) is not run on Bun. |

The package is **ESM-only** (`"type": "module"`, `import` conditions only). From CommonJS use dynamic `import()`. Nothing in the package has install-time side effects (`"sideEffects": false`), and no vendor SDK is required: the built-in adapters use `fetch`.

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
| `MISTRAL_API_KEY` | `mistral` | Mistral La Plateforme key |
| `DEEPSEEK_API_KEY` | `deepseek` | DeepSeek platform key |
| `TYPESAFE_API_KEY` | `typesafe` (`jev`) | TypeSafe Jev decision model key |

`ollama` needs no key; it talks to `http://localhost:11434` unless `baseUrl` is set. Any provider accepts `apiKey`, or `apiKeyEnvVar` to read a differently named variable.

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
│         │               ├─ Groq, Mistral, DeepSeek     │
│         │               ├─ Ollama                      │
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

- **`LanguageModel`**: Normalized interface (`generate`, `stream`, optional `capabilities`) implemented by all provider adapters. `ModelProtocol` is an alias kept for existing imports.
- **`ModelRegistry`**: Dynamic provider resolver that instantiates and caches provider adapters without boot-time static vendor imports.
- **`BaseProviderAdapter`**: Abstract adapter base class handling HTTP request serialization, streaming SSE parsing, and standardized error mapping.
- **`Tool`**: Executable function unit bundling a JSON Schema / typechecker parameter validator, description, and execution logic.
- **`Agent`**: Autonomous multi-turn agent loop executing tools, persisting checkpoints, and aggregating spend.
- **`Workflow`**: Directed Acyclic Graph (DAG) builder supporting typed steps, retries, conditional branches, and Human-in-the-Loop interrupts (`WaitNode`).
- **`WorkflowRunner`**: Execution engine running workflow DAGs, capturing step checkpoints, suspending on external signals, and resuming state.
- **`MCPClient`**: Client implementing the Model Context Protocol (version-negotiated, capability-aware) over stdio child processes, Streamable HTTP, or legacy HTTP+SSE.
- **`MCPServer`**: Server exposing tools, resources and prompts as an MCP-compliant JSON-RPC service; mount it over HTTP with `createMCPHttpHandler`.
- **`SpendCalculator`**: Financial engine computing exact USD token spend accounting for prompt caching discounts and reasoning models.
- **`SpendTracker`**: Aggregator tracking token spend across runs, threads, and agents with hard budget cap guardrails.

## API Reference

### Dynamic Model Provider Resolution

#### `createModel( config: ModelConfig ): LanguageModel`

Resolves and caches a model provider adapter. Providers: `openai`, `anthropic`, `gemini`, `groq`, `mistral`, `deepseek`, `ollama` (OpenAI-compatible servers work through `openai` with `baseUrl`). Every call is retried (`maxRetries`, default 2) on network errors and `408`/`429`/`5xx`, honoring `retry-after`; set `retry : false` on a request to disable.

<!-- check -->
```typescript
import { createModel } from '@webergency-utils/ai';

const model = createModel( {
    provider    : 'anthropic',
    model       : 'claude-sonnet-4-5',
    temperature : 0.7
});

const response = await model.generate( {
    messages : [ { role : 'user', content : 'Summarize modern distributed systems architecture' } ]
});

console.log( response.content );        // text
console.log( response.finishReason );   // 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other'
console.log( response.usage );          // { promptTokens, completionTokens, totalTokens, reasoningTokens?, cachedPromptReadTokens?, ... }
console.log( response.usageMissing );   // true when the provider reported no usage (never treated as free)
```

#### Streaming

`stream()` yields `ModelStreamChunk`s. Text arrives as `deltaContent`; the terminal chunk carries `finishReason` and, when the provider reports it, `usage`. Tool calls stream as `deltaToolCall` fragments and the terminal chunk carries the assembled, argument-parsed `toolCalls`.

<!-- check -->
```typescript
import { createModel } from '@webergency-utils/ai';

const model = createModel( { provider : 'openai', model : 'gpt-4o-mini' } );

let text = '';

for await ( const chunk of model.stream( { messages : [ { role : 'user', content : 'Stream a poem' } ] } ) )
{
    text += chunk.deltaContent;

    if( chunk.deltaReasoningContent ) process.stderr.write( chunk.deltaReasoningContent );

    if( chunk.finishReason )
    {
        console.log( chunk.finishReason, chunk.usage, chunk.toolCalls );   // terminal chunk
    }
}
```

Streaming responses are never retried once headers have arrived, and an idle stream is aborted after `idleTimeoutMs`.

#### Tool calls

Pass `tools` (name, description, JSON Schema `parameters`) and optionally `toolChoice` (`'auto'`, `'none'`, `'required'` or `{ name }`). Calls come back as `response.toolCalls` (`{ id, name, arguments }`, arguments already parsed); answer them with `role : 'tool'` messages that carry the `toolCallId`. `Agent` runs this loop for you.

<!-- check -->
```typescript
import { createModel } from '@webergency-utils/ai';
import type { ChatMessage, ToolDefinition } from '@webergency-utils/ai';

const model = createModel( { provider : 'openai', model : 'gpt-4o-mini' } );
const tools: ToolDefinition[] = [ {
    name        : 'get_weather',
    description : 'Get the weather for a city',
    parameters  : { type : 'object', properties : { city : { type : 'string' } }, required : [ 'city' ] }
} ];

const messages: ChatMessage[] = [ { role : 'user', content : 'Weather in Prague?' } ];
const first = await model.generate( { messages, tools } );

for( const call of first.toolCalls ?? [] )
{
    messages.push( { role : 'assistant', content : first.content, toolCalls : first.toolCalls } );
    messages.push( { role : 'tool', toolCallId : call.id, name : call.name, content : JSON.stringify( { tempC : 18 } ) } );
}

const answer = await model.generate( { messages, tools } );
```

#### Model capabilities

Each adapter reports honest `capabilities`; unsupported requests fail with a `CapabilityError` that names the provider and the missing feature instead of being silently dropped. Config can override the defaults for a specific model (`createModel( { ..., capabilities : { structuredOutput : false } } )`). The table below is generated from the adapters' flags (`npm run gen:capabilities`) and CI fails if it drifts.

<!-- capabilities:start -->
| Provider | Structured output | Reasoning content | Prompt cache | Embeddings | Image | Audio | Video | Document |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | yes | yes | yes | yes | yes | yes | - | yes |
| `anthropic` | yes | - | yes | - | yes | - | - | yes |
| `gemini` | yes | - | - | yes | yes | yes | yes | yes |
| `groq` | yes | yes | - | - | yes | - | - | - |
| `mistral` | yes | - | - | - | yes | - | - | - |
| `deepseek` | yes | yes | - | - | - | - | - | - |
| `ollama` | yes | - | - | yes | yes | - | - | - |
<!-- capabilities:end -->

Custom `LanguageModel` implementations may omit `capabilities`; `getCapabilities( model )` treats that as "nothing supported".

#### Structured output

`outputSchema` (a JSON Schema or a `schema.*` builder) makes the response carry a parsed and validated `structured` value. The adapter picks the strongest wire mode the provider offers (`json_schema` by default; `outputMode : 'json'` for plain JSON mode with the schema injected as an instruction). A truncated or refused answer throws instead of returning partial JSON. Streaming delivers `structured` on the terminal chunk.

<!-- check -->
```typescript
import { createModel, generateStructured, schema } from '@webergency-utils/ai';

const model = createModel( { provider : 'openai', model : 'gpt-4o-mini' } );

const { structured } = await generateStructured<{ label: string }>( model, {
    messages     : [ { role : 'user', content : 'Classify: "I love this library"' } ],
    outputSchema : schema.object( { label : schema.enum( [ 'positive', 'negative', 'neutral' ] ) } )
} );

console.log( structured.label );
```

#### Reasoning content

Providers that expose reasoning text (`reasoningContent` capability) return it as `response.reasoningContent` and stream it as `deltaReasoningContent`; reasoning token counts appear in `usage.reasoningTokens`. Pass an assistant message's `reasoningContent` back unchanged in later turns where the provider requires it (the agent loop does this for you).

#### Multimodal input

Attach media to **user** messages with `attachments` (`{ type, mimeType, data | url }`). Support is per provider (see the table above); an unsupported type throws `CapabilityError` before any request is sent, and attachments on non-user messages throw `InvalidInputError`.

| Provider | Accepted attachments | Notes |
|---|---|---|
| `openai` | image (bytes or URL), audio, document | audio and documents must be supplied as bytes |
| `anthropic` | image, document | bytes or URL |
| `gemini` | image, audio, video, document | bytes are sent inline, URL-only attachments as `fileData` |
| `groq`, `mistral` | image | |
| `ollama` | image | base64 bytes only; a URL-only image is rejected |
| `deepseek` | none | |

<!-- check -->
```typescript
import { createModel } from '@webergency-utils/ai';
import { readFile } from 'node:fs/promises';

const model = createModel( { provider : 'gemini', model : 'gemini-2.0-flash' } );

const response = await model.generate( {
    messages : [ {
        role        : 'user',
        content     : 'What is in this picture?',
        attachments : [ { type : 'image', mimeType : 'image/png', data : await readFile( './photo.png' ) } ]
    } ]
} );
```

#### Prompt caching

Providers with `promptCacheControl` accept cache hints; others reject them with a `CapabilityError`. Anthropic takes message-level breakpoints (`cacheControl : { type : 'ephemeral', ttl : '5m' | '1h' }`), OpenAI takes a request-level `promptCacheKey`. Cache reads and writes are reported in `usage.cachedPromptReadTokens` / `cachedPromptWriteTokens` and priced by the spend engine.

<!-- check -->
```typescript
import { createModel } from '@webergency-utils/ai';

const claude = createModel( { provider : 'anthropic', model : 'claude-sonnet-4-5' } );

await claude.generate( {
    messages : [
        { role : 'system', content : 'Long, stable instructions...', cacheControl : { type : 'ephemeral', ttl : '1h' } },
        { role : 'user', content : 'Question' }
    ]
} );

const gpt = createModel( { provider : 'openai', model : 'gpt-4o-mini' } );

await gpt.generate( { messages : [ { role : 'user', content : 'Question' } ], promptCacheKey : 'support-bot-v3' } );
```

#### Embeddings

Embedding models are separate objects (`createEmbeddingModel`) for `openai`, `gemini` and `ollama`; other providers throw a `CapabilityError`. `embed()` takes a string or an array and returns one vector per input, in order.

<!-- check -->
```typescript
import { createEmbeddingModel } from '@webergency-utils/ai';

const embedder = createEmbeddingModel( { provider : 'openai', model : 'text-embedding-3-small' } );
const { vectors, usage } = await embedder.embed( [ 'hello world', 'goodbye world' ], { dimensions : 256 } );

console.log( vectors.length, vectors[ 0 ]!.length, usage?.totalTokens );
```

### Storage Subsystem

Abstract interfaces with zero-dependency in-memory / local-disk reference drivers, plus production adapters that take **injected** clients (no new runtime dependencies):

<!-- check -->
```typescript
import { 
    MemoryDocStore, 
    MemoryVectorStore, 
    MemoryCacheStore, 
    LocalDiskFileStore,
    PostgresDocStore,
    fromPg,
    RedisCacheStore,
    fromIoRedis,
    PgVectorStore,
    S3FileStore
} from '@webergency-utils/ai';

// 1. Documents & Checkpoints (memory reference)
const docStore = new MemoryDocStore();
await docStore.set( 'users', 'u_101', { name : 'Alice', tier : 'pro' } );
const user = await docStore.get( 'users', 'u_101' );

// 2. Durable document store (inject `pg` yourself)
// import pg from 'pg';
// const pool = new pg.Pool( { connectionString : process.env.DATABASE_URL } );
// const pgDocs = new PostgresDocStore( fromPg( pool ), { tablePrefix : 'ai' } );
// await pgDocs.ensureSchema();

// 3. Vector Store & Cosine Similarity
const vectorStore = new MemoryVectorStore();
await vectorStore.upsert( [
    { id : 'vec_1', values : [ 1, 0, 0 ], content : 'Vector math' }
] );
const matches = await vectorStore.query( [ 0.95, 0.05, 0 ], 1 );

// 4. Memory & TTL Cache Store
const cache = new MemoryCacheStore( { maxEntries : 5000 } );
await cache.set( 'session_token', { userId : 'u_101' }, 3600 );

// 5. Local Disk File Store / S3-compatible object store
const fileStore = new LocalDiskFileStore( './data/storage' );
await fileStore.write( 'reports/monthly.pdf', new Uint8Array( [ 0x25, 0x50, 0x44, 0x46 ] ) );

// const s3 = new S3FileStore( {
//     endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle : true
// } );
```

Adapters: `PostgresDocStore` / `PostgresCacheStore`, `SqliteDocStore` / `SqliteCacheStore`, `RedisDocStore` / `RedisCacheStore` (Lua CAS), `PgVectorStore`, `S3FileStore` (native `fetch` + SigV4). Call `ensureSchema()` once before use. Integration suites run when `TEST_POSTGRES_URL`, `TEST_REDIS_URL`, and `TEST_S3_*` are set (see `.github/workflows/storage-integration.yml`).

### Spend Tracking & Pricing Engine

Extract exact provider-reported metrics and compute costs:

<!-- check -->
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

<!-- check -->
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

<!-- check -->
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

<!-- check -->
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

Resources and prompts are registered next to tools. Capabilities are advertised only for the kinds you registered (`tools` is always advertised):

```typescript
server.registerResource(
    { uri : 'file:///readme.md', name : 'readme', mimeType : 'text/markdown' },
    async () => '# Hello'                                   // string, { text }, { blob } (base64), or an array of those
);

server.registerResourceTemplate(
    { uriTemplate : 'user://{org}/{id}', name : 'user' },   // RFC 6570 level 1 only: `{var}`; other operators throw
    async ( uri, vars ) => JSON.stringify( vars )
);

server.registerPrompt(
    { name : 'greet', arguments : [ { name : 'who', required : true } ] },
    async ( args ) => [ { role : 'user', content : { type : 'text', text : `Hello ${args.who}` } } ]
);
```

Unknown URIs, unknown prompts, missing/undeclared prompt arguments answer `-32602`; a reader returning both or neither of `text` / `blob` is a `-32603` error.

#### Serving over HTTP

`createMCPHttpHandler( server, options? )` returns a web-standard `( req: Request ) => Promise<Response>` implementing the Streamable HTTP server side (JSON responses; no server-initiated stream, so `GET` is `405`):

```typescript
import { createServer } from 'node:http';
import { createMCPHttpHandler } from '@webergency-utils/ai';

const handler = createMCPHttpHandler( server, {
    sessions            : true,                         // issue Mcp-Session-Id; default false (stateless)
    allowedOrigins      : [ 'https://app.example' ],    // default: Origin, if present, must be same-origin (DNS-rebinding guard)
    authenticate        : async ( req ) => verify( req.headers.get( 'authorization' ) )
        ? { ok : true }
        : { ok : false, error : 'invalid_token' },       // -> 401 + WWW-Authenticate: Bearer ...
    resourceMetadataUrl : 'https://mcp.example/.well-known/oauth-protected-resource',
    maxBodyBytes        : 4 * 1024 * 1024                // -> 413 beyond this
} );

// Node adapter (Bun.serve( { fetch : handler } ) needs none)
createServer( async ( req, res ) => {
    const chunks: Buffer[] = [];
    for await ( const chunk of req ) chunks.push( chunk );

    const response = await handler( new Request( `http://${req.headers.host}${req.url}`, {
        method  : req.method,
        headers : req.headers as Record<string, string>,
        body    : [ 'GET', 'HEAD' ].includes( req.method! ) ? undefined : Buffer.concat( chunks )
    } ) );

    res.writeHead( response.status, Object.fromEntries( response.headers ) );
    res.end( Buffer.from( await response.arrayBuffer() ) );
} ).listen( 3000 );
```

Origin and `authenticate` run before the body is read. Sessions live in memory (`sessionTtlMs`, default 30 min; `maxSessions`, default 1000, beyond which `initialize` gets `503`); `DELETE` ends one. Batched POSTs are accepted; `initialize` must not be batched.

#### MCP Client

`connectMCPClient( url, options? )` connects over HTTP: it tries Streamable HTTP and falls back to the legacy SSE transport only when the server answers `400`/`404`/`405`. Other failures (auth, version mismatch, network) are thrown, not masked.

```typescript
import { connectMCPClient, MCPClient, StdioTransport, StreamableHTTPTransport } from '@webergency-utils/ai';

const client = await connectMCPClient( 'https://mcp.example/mcp', {
    authProvider : {
        getHeaders     : async () => ( { authorization : `Bearer ${await tokens.get()}` } ),
        onUnauthorized : async () => { await tokens.refresh(); return true; }   // called once per request on 401; true = retry once
    }
} );

// Or pick the transport yourself:
const http  = new MCPClient( new StreamableHTTPTransport( 'https://mcp.example/mcp', { headers : { 'x-tenant' : 'acme' }, listen : true } ) );
const stdio = new MCPClient( new StdioTransport( 'npx', [ '-y', '@modelcontextprotocol/server-memory' ] ) );
await stdio.connect();

const tools = await stdio.listTools();                  // follows nextCursor (maxPages, default 100)
const toolDefs = await stdio.toToolDefinitions();      // Definitions only (no `execute`)
```

`connect()` negotiates the protocol revision (offers the newest of `SUPPORTED_PROTOCOL_VERSIONS`; a server answering with anything else closes the transport and throws `MCP_PROTOCOL_VERSION_UNSUPPORTED`) and exposes `negotiatedVersion`, `serverCapabilities`, `serverInfo` and `instructions`. Methods need the matching server capability: `listResources()` against a tools-only server throws `MCP_CAPABILITY_MISSING` before anything is sent (`connect( { strictCapabilities : false } )` opts out).

```typescript
const resources = await client.listResources();
const [ readme ] = await client.readResource( 'file:///readme.md' );   // { uri, mimeType?, text | blob }
const prompts   = await client.listPrompts();
const prompt    = await client.getPrompt( 'greet', { who : 'Ada' } );  // { description?, messages }
await client.ping();

const off = client.onNotification( ( n ) => console.log( n.method, n.params ) );
```

Server-initiated traffic is handled, not dropped: `ping` is answered, other requests (`roots/list`, sampling, ...) get `-32601`, and notifications reach `onNotification`. Failures with no request to reject (a throwing notification handler, a dropped listening stream, malformed SSE) go to `new MCPClient( transport, { onError } )`; without `onError` they are rethrown asynchronously.

**Auth** is a hook, not an OAuth client: `headers` and `authProvider` apply to `StreamableHTTPTransport` and `SSETransport`. A `401` calls `onUnauthorized` once and retries once; otherwise `MCPAuthError` (`MCP_UNAUTHORIZED`) carries the parsed `WWW-Authenticate` challenge and `resourceMetadata` URL. A `403` is `MCP_FORBIDDEN`. Credentials never appear in errors or spans. Full OAuth 2.1 (PKCE, dynamic client registration, token storage) is out of scope.

| Error code | Meaning |
| --- | --- |
| `MCP_PROTOCOL_VERSION_UNSUPPORTED` | Server answered `initialize` with a revision outside `SUPPORTED_PROTOCOL_VERSIONS` |
| `MCP_CAPABILITY_MISSING` | Server did not advertise `tools` / `resources` / `prompts` |
| `MCP_NOT_CONNECTED` | A method was called before `connect()` completed |
| `MCP_SESSION_EXPIRED` | `404` after a session id was issued (reconnect; no automatic re-initialize) |
| `MCP_UNAUTHORIZED` / `MCP_FORBIDDEN` | `401` (after the single retry) / `403` |
| `MCP_PROTOCOL_ERROR` | Malformed JSON-RPC, SSE event, or result shape from the peer |
| `MCP_TRANSPORT_ERROR` | Non-2xx HTTP (status and truncated body in `details`), dropped stream, endpoint timeout |
| `MCP_PAGINATION_LIMIT` / `MCP_PAGINATION_LOOP` | `maxPages` exceeded / repeated cursor |
| `MCP_INVALID_RESOURCE_CONTENT` | Resource contents with both or neither of `text` / `blob` |
| `MCP_INVALID_URI_TEMPLATE` | Unsupported RFC 6570 expression in a resource template |

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

<!-- check -->
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

### Tracing & Export (OpenTelemetry)

Every `Agent` run, model call, tool call, MCP call, and storage operation is a span in a `TraceCollector`. `OTLPHttpExporter` ships completed traces to any OTLP/HTTP backend (Langfuse, Phoenix, Jaeger, Grafana Tempo, Datadog, Honeycomb, a local OpenTelemetry Collector) with batching, retries, a bounded queue, and visible failures. It has no dependency on `@opentelemetry/*`.

```typescript
import { Agent } from '@webergency-utils/ai/agent';
import { TraceCollector, OTLPHttpExporter } from '@webergency-utils/ai/trace';

const collector = new TraceCollector();
const exporter = new OTLPHttpExporter( {
    endpoint    : 'http://localhost:4318/v1/traces', // default; a full URL
    serviceName : 'support-bot'
} );

exporter.attach( collector );

// Export never throws into your code; failures arrive as collector warnings.
collector.on( 'warning', ( w ) => console.warn( w.code, w.message ) );

const agent = new Agent( { model, tools, collector } );

await agent.run( 'Where is my order?' );
await exporter.shutdown(); // flushes queued traces
```

Spans carry [OpenTelemetry GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes next to the original `model.*` / `tool.name` names, so backends render model, token, and tool data natively: `gen_ai.operation.name` (`chat`, `execute_tool`, `invoke_agent`, `embeddings`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`, `gen_ai.conversation.id`. Missing usage stays missing; it is never exported as zero. The semantic conventions are still experimental upstream: every name lives in `GENAI_ATTR`, and `genaiCompat: 'legacy' | 'both'` also emits the older `gen_ai.system` / `prompt_tokens` spelling.

#### Backends

```typescript
// Langfuse Cloud (OTLP endpoint; basic auth is public key : secret key)
new OTLPHttpExporter( {
    endpoint : 'https://cloud.langfuse.com/api/public/otel/v1/traces',
    headers  : { Authorization : `Basic ${Buffer.from( `${publicKey}:${secretKey}` ).toString( 'base64' )}` }
} );

// Honeycomb
new OTLPHttpExporter( {
    endpoint : 'https://api.honeycomb.io/v1/traces',
    headers  : { 'x-honeycomb-team' : process.env.HONEYCOMB_API_KEY! }
} );

// Backends that group by span name (Jaeger, Tempo) can use the semconv shape
new OTLPHttpExporter( { spanNameStyle : 'genai' } ); // "chat gpt-4o", "execute_tool search", "invoke_agent support"
```

Header values are sent, never stored on spans or put in warnings. Attributes whose key looks like a credential (`apiKey`, `authorization`, `rawOptions`, ...) and bearer-token / `sk-...` shaped strings are removed from exports.

#### Batching, failures, and shutdown

| Option | Default | Meaning |
| --- | --- | --- |
| `maxBatchTraces` | `32` | Traces per POST |
| `scheduleDelayMs` | `5000` | Longest wait before a partial batch is sent |
| `maxQueueTraces` | `2048` | Queue bound; overflow drops the oldest and warns `TRACE_EXPORT_DROPPED` with a count |
| `maxRetries` | `3` | Network errors, `408`, `429`, `502`, `503`, `504` retry with exponential backoff and jitter, honoring `Retry-After`; other `4xx` fail immediately |
| `timeoutMs` | `10000` | Per request, and the bound on `shutdown()` flushing |

Failures never throw into your code: the collector emits `warning` events (`TRACE_EXPORT_FAILED`, `TRACE_EXPORT_DROPPED`, `TRACE_EXPORT_PARTIAL`, `TRACE_ATTRIBUTE_INVALID`) and `exporter.stats` counts exported, failed, dropped, and sampled-out traces. Without a collector, pass `onError`. Timers are `unref()`ed, so the exporter never keeps the process alive. Flush on shutdown signals:

```typescript
for( const signal of [ 'SIGTERM', 'SIGINT' ] as const )
{
    process.once( signal, () => { void exporter.shutdown().finally( () => process.exit( 0 ) ); } );
}
```

After `shutdown()`, `exporter.export()` rejects with `TRACE_EXPORTER_SHUTDOWN`. `forceFlush()` sends what is queued without shutting down (use it in serverless handlers).

#### Privacy and sampling

Prompts and completions are **not** exported by default. To opt in, configure capture on the collector (so instrumentation records it) and the exporter (so the export enforces it); a `redact` function is mandatory and construction throws without one. Content is redacted first, then truncated at `maxContentBytes` (16 KiB) with a `...truncated` marker:

```typescript
const redact = ( text: string ) => text.replace( /sk-[A-Za-z0-9_-]+/g, '[KEY]' ).replace( /\b\d{16}\b/g, '[CARD]' );

const collector = new TraceCollector( { capture : { captureContent : true, redact } } );
const exporter = new OTLPHttpExporter( { captureContent : true, redact } );
```

Captured content goes to `gen_ai.input.messages` / `gen_ai.output.messages` as JSON strings. Reduce volume with `sampleRate` (0-1, deterministic by trace id) or a custom `sampler( trace ) => boolean`; traces with an errored span are always kept unless `alwaysSampleErrors: false`.

#### Trace context propagation

`toTraceparent( span )` and `fromTraceparent( header )` convert to and from the W3C `traceparent` header. Sending it is opt-in: set `propagateTraceContext : true` on a provider's `ModelConfig` (the agent and metered models supply the header from the active model span), or on `StreamableHTTPTransport` / `SSETransport` for MCP (derived from the in-band `_meta` ids, which are always sent).

#### Standalone model calls

Outside an `Agent`, give the metered wrapper an execution context and each call becomes its own `model` span with the same attributes and spend:

```typescript
const { context } = collector.startTrace( { name : 'nightly-job' } );
const metered = createMeteredModel( model, { tracker, context } );
```

#### Manual check against a local collector

Run `docker run --rm -p 4318:4318 -p 16686:16686 -e COLLECTOR_OTLP_ENABLED=true jaegertracing/all-in-one` and point the exporter at the default endpoint; runs appear in Jaeger at `http://localhost:16686`. This is a manual smoke test; automated tests use an injected `fetch`.

## Contributing & Release Checks

```bash
npm run release:check     # lint, typecheck, build, coverage thresholds, tarball checks, smoke install, publint, attw, README checks
npm test                  # offline suite, including recorded provider replay
npm run test:coverage     # v8 coverage with enforced thresholds (see vitest.config.ts)
npm run smoke:pack        # pack, install into a clean project, import every subpath, compile a TypeScript consumer
```

CI runs the same scripts. The published tarball contains `dist`, `src` (so source maps resolve), `README.md`, `LICENSE`, `SECURITY.md` and `CHANGELOG.md`, nothing else; `npm run check:pack` enforces that list.

### Recorded provider fixtures

`tests/fixtures/recorded/<provider>/<case>.json` holds scrubbed request/response pairs (streams as chunk lists). `tests/providers/recorded/replay.test.ts` replays them through each adapter's real code path and fails with a body diff when an adapter's request drifts from the recording. A fixture's `source` is `recorded` (captured from the live API) or `synthetic` (hand-authored from the provider's documented wire format until someone records it). Recorded fixtures older than 180 days produce a CI warning.

### Live provider tests

The live suite calls real provider APIs and **costs money** (small token budgets, cheapest default models; override with `AI_LIVE_<PROVIDER>_MODEL`). It never runs in CI or `npm test`.

```bash
AI_LIVE=1 OPENAI_API_KEY=... npm run test:live              # providers without keys are skipped, with a printed reason
AI_LIVE=1 AI_LIVE_REQUIRE=openai,anthropic npm run test:live # a listed provider without a key FAILS the run
npm run record:fixtures -- --provider openai                # re-run live and rewrite that provider's fixtures
```

Review regenerated fixtures like code before committing: the recorder refuses to write anything that looks like a credential, and a repository test scans every fixture.

### Releasing

See [`docs/release-runbook.md`](docs/release-runbook.md). Publishing is a manual, dry-run-first GitHub workflow.

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
