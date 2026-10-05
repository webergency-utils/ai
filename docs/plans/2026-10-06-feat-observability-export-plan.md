---
title: Observability Export - Plan
type: feat
date: 2026-10-06
topic: observability-export
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Observability Export - Plan

## Goal Capsule

- **Objective**: Completed traces leave the process. A `TraceCollector` can push them to any OTLP/HTTP backend (Langfuse, Phoenix, Jaeger, Grafana Tempo, Datadog, Honeycomb) with batching, bounded memory, flush/shutdown, and visible failures; spans carry OpenTelemetry GenAI semantic-convention attributes so backends render model, token, and tool data natively.
- **Product Authority**: Area 7 of 8 from the 2026-10-04 library assessment. Hierarchical tracing and the OTLP JSON mapping landed earlier (`2026-09-19-0923-feat-hierarchical-spans-tracing-plan.md`).
- **Open Blockers**: None. GenAI semantic conventions are still marked experimental upstream; attribute names are isolated in one module so a rename is one edit. Verify names against the current semconv registry at implementation time.
- **Execution profile**: Test-first with an injected `fetch`; no collector process required. A manual smoke against a local OTel collector or Jaeger is documented, not automated.

---

## Product Contract

### Summary

Add GenAI attribute mapping (both at instrumentation time and as an export-time projection), an `OTLPHttpExporter` that subscribes to `TraceCollector` `trace:complete`, correct OTLP encoding fixes, opt-in content capture with redaction, and sampling. Metrics export and logs are out.

### Problem Frame (what exists vs missing)

**Exists** (`src/trace/*`):

- `SpanImpl`/`TraceCollector` (EventEmitter: `span:start|end`, `trace:start|end|complete`, `warning`), `subscribe()`, bounded active/completed trace stores, `createExecutionContext()`.
- `exportTraceToJSON( trace )` and `exportTraceToOTLP( trace, { serviceName, serviceVersion } )` return an **in-memory OTLP/JSON request object**. Nothing sends it anywhere.
- Instrumentation: `Agent` sets `agent.id|threadId|runId`, `model.provider`, `model.name`, `step.index`, `tool.name`, metrics `promptTokens|completionTokens|totalTokens`; storage spans set `storage.collection`; MCP spans set `mcp.tool`; spend is on span fields (`spend.usd` attribute emitted by the exporter).
- Ids are W3C-compatible (32/16 hex).

**Missing / defects**:

- No transport: no HTTP POST to `/v1/traces`, no headers/auth, no batching, retries, timeouts, flush, or shutdown; export failures have no surface.
- No GenAI semantic-convention attributes (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`, `gen_ai.conversation.id`, `gen_ai.agent.id`, error type). Metrics are exported as `metrics.promptTokens`, which backends do not understand.
- Span names are `agent:run`, `model:generate`, `tool:run:*` — not the `invoke_agent`/`chat {model}`/`execute_tool {tool}` shape the conventions describe.
- Exporter defects: unfinished spans export with `endTime = startTime` (looks like instant success); `cachedTokens`/`reasoningTokens` metrics are dropped from GenAI names; non-number metrics skipped silently; no span `events` (exceptions), no `flags`/`traceState`; error spans do not set `error.type`; non-finite numbers pass straight into `doubleValue` (`NaN` becomes `null` under `JSON.stringify`, producing an invalid OTLP value).
- `model:generate` spans exist only inside `Agent` and decision calls; a standalone `MeteredModel` call creates no span, so non-agent users get no model telemetry.
- No privacy controls: nothing captures prompts/completions (good), but there is no way to opt in with redaction either.
- No `traceparent` propagation to model providers or MCP HTTP servers (MCP already carries `_meta` ids in-band).

### Key Decisions

- **Exporter is a subscriber, not a rewrite of the collector** (chosen over hooking spans individually): `OTLPHttpExporter.attach( collector )` listens to `trace:complete`, so the span model stays unchanged. Governs R1–R6.
- **Own tiny OTLP/JSON over `fetch`** (chosen over depending on `@opentelemetry/*`): the JSON mapping already exists; zero dependencies preserved. Protobuf and gRPC are out. Governs R1.
- **GenAI attributes are set at instrumentation, with the legacy `model.*` names kept** (chosen over rename: existing tests and users read `model.provider`). A single `src/trace/genai.ts` owns names and mapping. Governs R7–R10.
- **Span names stay; semconv names are added as `gen_ai.operation.name`** (chosen over renaming spans: `agent:step:N` hierarchy tests depend on names; backends key on the attribute). An exporter option `spanNameStyle: 'native' | 'genai'` (default `native`) rewrites names at export time only. Governs R9.
- **Content capture is off by default and explicit** (chosen over capturing messages for debuggability): `captureContent: false` default; when true, a required `redact( content ) => content` function is mandatory (constructor throws without it). Governs R13–R14.
- **Export never throws into the app and never disappears silently** (chosen over fire-and-forget): failures emit collector `warning` events with code `TRACE_EXPORT_FAILED` and increment `exporter.stats`; queue overflow drops oldest with a counted warning. Governs R4–R6.
- **Incomplete spans are marked, not faked** (chosen over `end = start`): the exporter ends open spans at export time with attribute `trace.span.unfinished = true` and status error `unfinished`. Governs R11.

### Requirements

**Exporter**

- R1. `OTLPHttpExporter( options )` with `endpoint` (full URL, default `http://localhost:4318/v1/traces`), `headers`, `timeoutMs` (default 10 s), `serviceName`, `serviceVersion`, `resourceAttributes`, `fetch` (injectable) posts `application/json` bodies produced by `exportTraceToOTLP`.
- R2. `exporter.attach( collector ): () => void` subscribes to `trace:complete`; returns a detach function. `exporter.export( trace ): Promise<void>` exists for manual use.
- R3. Batching: traces accumulate until `maxBatchTraces` (default 32) or `scheduleDelayMs` (default 5000); each batch is one POST with multiple `resourceSpans` entries/spans merged under one resource.
- R4. Retry: network errors, `429`, `502`, `503`, `504` retry with exponential backoff and jitter up to `maxRetries` (default 3), honoring `Retry-After`; `4xx` (other than 408/429) fail immediately.
- R5. Memory bound: queue capped at `maxQueueTraces` (default 2048); overflow drops the oldest trace and emits a `warning` (`TRACE_EXPORT_DROPPED`) with a drop count.
- R6. `forceFlush(): Promise<void>` resolves when queued batches are sent or failed; `shutdown(): Promise<void>` detaches, flushes (bounded by `timeoutMs`), and makes later `export` throw `AIError` (`TRACE_EXPORTER_SHUTDOWN`). Timers are `unref()`ed so the exporter never keeps the process alive.

**GenAI attributes**

- R7. `src/trace/genai.ts` exports attribute-name constants and `applyModelCallAttributes( span, { provider, model, request, response } )`, `applyToolAttributes( span, { name, callId } )`, `applyAgentAttributes( span, { id, threadId } )`.
- R8. Model spans (agent steps and decision calls) set `gen_ai.operation.name = 'chat'`, `gen_ai.provider.name`, `gen_ai.request.model`, request params when set (`gen_ai.request.temperature`, `max_tokens`, `top_p`), `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus cache/reasoning token attributes when present. Legacy `model.provider|model.name` and span metrics stay.
- R9. Tool spans set `gen_ai.operation.name = 'execute_tool'`, `gen_ai.tool.name`, `gen_ai.tool.call.id`; agent run spans set `gen_ai.operation.name = 'invoke_agent'`, `gen_ai.agent.id`, `gen_ai.conversation.id` (= threadId). `spanNameStyle: 'genai'` rewrites export names to `chat {model}`, `execute_tool {tool}`, `invoke_agent {agent}`.
- R10. Provider ids map to the registered semconv values where one exists (`openai`, `anthropic`, `gcp.gemini`, ...); unknown ones pass through verbatim. Mapping table is tested.
- R10a. Embedding calls (`MeteredEmbeddingModel`) get spans with `gen_ai.operation.name = 'embeddings'` when a span getter is supplied.

**Encoding correctness**

- R11. Unfinished spans export with `trace.span.unfinished = true` and error status; `endTimeUnixNano >= startTimeUnixNano` always.
- R12. Non-finite numbers (`NaN`, `±Infinity`) in attributes/metrics are dropped with a collector `warning` (`TRACE_ATTRIBUTE_INVALID`) and never serialized (they are not valid JSON). Error spans add `error.type` (error class name) and an `exception` span event (`exception.type`, `exception.message`, truncated `exception.stacktrace`).

**Privacy and sampling**

- R13. `captureContent` option on the exporter/instrumentation (default false). When true, `redact` is required; captured values (`gen_ai.input.messages`, `gen_ai.output.messages` JSON strings) are truncated at `maxContentBytes` (default 16 KiB) and mark `...truncated`.
- R14. API keys, `Authorization` headers, and request `rawOptions` are never attached to spans (regression test greps exported payloads).
- R15. `sampler?: ( trace ) => boolean` and `sampleRate` (0–1, deterministic by `traceId` hash) apply at `trace:complete`; errors are always kept when `alwaysSampleErrors` (default true).

**Propagation**

- R16. `traceparent` (W3C) helper `toTraceparent( span )` / `fromTraceparent( header )` exported; `StreamableHTTPTransport` and provider `BaseProviderAdapter.request` accept an optional `propagateTraceContext: boolean` (default false) to send the header. (MCP in-band `_meta` stays.)

### Acceptance Examples

- AE1. Batched export
  - **Covers R1, R3.** **Given** 40 completed traces and `maxBatchTraces: 32`. **Then** two POSTs (32 + 8 after `forceFlush`) with correct `Content-Type` and headers.
- AE2. Retry on 503
  - **Covers R4.** **Given** fetch fails with 503 twice then 200. **Then** three attempts, delays grow, final success, no warning.
- AE3. Permanent failure surfaces
  - **Covers R4, R5.** **Given** 401 on the first POST. **Then** no retry, a `TRACE_EXPORT_FAILED` warning is emitted with status, and the app code path never throws.
- AE4. Queue overflow
  - **Covers R5.** **Given** a blocked fetch, `maxQueueTraces: 4`, and 10 traces. **Then** 6 are dropped, one warning carries `dropped: 6`.
- AE5. Shutdown
  - **Covers R6.** **Given** queued traces. **Then** `shutdown()` flushes, a later `export` rejects with `TRACE_EXPORTER_SHUTDOWN`, and no timers remain (process exits).
- AE6. Agent trace attributes
  - **Covers R8, R9.** **Given** an agent run with one tool call on a stub model reporting 120/30 tokens. **Then** the exported model span has `gen_ai.usage.input_tokens=120`, `gen_ai.usage.output_tokens=30`, `gen_ai.operation.name=chat`; the tool span has `gen_ai.tool.name`.
- AE7. Unfinished span
  - **Covers R11.** **Given** a trace exported while a child span is still open. **Then** that span carries `trace.span.unfinished` and error status, not a zero-length success.
- AE8. Redaction required
  - **Covers R13.** **Given** `captureContent: true` without `redact`. **Then** construction throws; with `redact`, secrets matched by the callback do not appear in the payload.
- AE9. Sampling keeps errors
  - **Covers R15.** **Given** `sampleRate: 0`. **Then** healthy traces are dropped, an errored trace is exported.

### Success Criteria

- Pointing `OTLPHttpExporter` at a local OTel collector or Langfuse OTLP endpoint shows agent runs with model, token, and tool data without custom mapping.
- No unhandled rejections or open handles from the exporter in any test.
- Existing `tests/trace/*` still pass (additive attributes only; `exportTraceToOTLP` output for old inputs unchanged except R11/R12 fixes, which have updated assertions).

### Scope Boundaries

**In scope**: `src/trace/*`, instrumentation touch-points in `src/agent`, `src/providers/metered.ts`, `src/agent/decision.ts`, `src/mcp` (header hook only), README tracing section.

**Deferred**

- OTLP metrics (token/latency histograms) and logs export.
- OTLP protobuf / gRPC encoding.
- Vendor-specific exporters (Langfuse SDK-style APIs); they ingest OTLP.
- Span links, baggage, tail-sampling in-process.
- Persistent trace storage (`IDocumentStore`-backed trace store).
- Auto-instrumentation of the SDK bridge.

**Out of scope**: agent behavior (Area 4), storage adapters (Area 6).

### Dependencies / Assumptions

- Node 20+ global `fetch`, `AbortSignal.timeout`.
- Agent capabilities work (Area 4) will add `model:stream` spans and guardrail spans; they call the same `genai.ts` helpers.

### Outstanding Questions

**Deferred to implementation**

- Exact current semconv names (`gen_ai.provider.name` vs older `gen_ai.system`); keep a single constant table and, if the registry has not settled, emit both behind `genaiCompat: 'latest' | 'legacy' | 'both'`.
- Whether to allow `Content-Encoding: gzip` bodies (default off; add if large batches matter).

---

## Planning Contract (KTD)

| Topic | Decision |
| --- | --- |
| New modules | `src/trace/genai.ts`, `src/trace/otlp-http.ts`, `src/trace/sampling.ts`, `src/trace/propagation.ts` |
| Export surface | `OTLPHttpExporter` exported from `@webergency-utils/ai/trace` |
| Failure channel | Collector `warning` events (existing `TraceWarningEvent { code, message, details }`) |
| Timers | `setTimeout` + `unref()`; injectable clock/timer for tests |
| Content keys | `gen_ai.input.messages` / `gen_ai.output.messages` JSON strings only when opted in |

---

## Implementation Units

### U1. Exporter encoding fixes

- **Goal:** Make `exportTraceToOTLP` safe to ship before adding transport.
- **Requirements:** R11, R12
- **Dependencies:** none
- **Files:** `src/trace/exporter.ts`, `src/trace/types.ts` (optional span `events`), `tests/trace/exporter.test.ts`
- **Approach:** Close open spans at export time with markers; guard non-finite numbers; add `error.type` and exception event; ensure `parentSpanId` is omitted (not `undefined`) for roots.
- **Test scenarios:** AE7; NaN attribute dropped with warning callback; error span has exception event; deterministic ordering preserved; old fixture outputs updated deliberately.

### U2. GenAI attribute helpers and instrumentation

- **Goal:** Backends understand model/tool/agent spans.
- **Requirements:** R7–R10a
- **Dependencies:** U1
- **Files:** `src/trace/genai.ts` (new), `src/trace/index.ts`, `src/agent/agent.ts`, `src/agent/decision.ts`, `src/providers/metered.ts`, `src/mcp/client.ts` (`gen_ai.tool.name` on MCP spans), `tests/trace/genai.test.ts` (new), `tests/agent/agent-loop.test.ts`
- **Approach:** Replace inline `setAttribute( 'model.*' )` blocks with helper calls that also keep legacy names; request params read from `ModelRequest`; finish reasons from `ModelResponse`; `spanNameStyle` implemented in the exporter.
- **Test scenarios:** AE6; provider mapping table; embeddings span; missing usage sets no zero-valued token attributes (usage gaps stay gaps).

### U3. `OTLPHttpExporter` (batching, retry, bounds)

- **Goal:** Ship traces over OTLP/HTTP JSON.
- **Requirements:** R1–R6
- **Dependencies:** U1
- **Files:** `src/trace/otlp-http.ts` (new), `src/trace/index.ts`, `tests/trace/otlp-http.test.ts` (new)
- **Approach:** Queue + timer + in-flight promise chain (single sender to preserve order); `Retry-After` parsing (seconds and HTTP-date); jitter injectable; `forceFlush` awaits the chain; errors → `collector.emit( 'warning', ... )` via the attached collector or an `onError` option when used standalone.
- **Test scenarios:** AE1–AE5; timeout aborts request; `attach`/detach idempotent; shutdown with in-flight request; unref'd timers (no hang under vitest).

### U4. Privacy: content capture, redaction, sampling

- **Goal:** Opt-in prompt capture and volume control.
- **Requirements:** R13–R15
- **Dependencies:** U2, U3
- **Files:** `src/trace/sampling.ts` (new), `src/trace/genai.ts`, `src/agent/agent.ts` (pass messages to helper only when capture on), `tests/trace/privacy.test.ts` (new)
- **Approach:** Capture config lives on the collector (`TraceCollectorOptions.capture`) so instrumentation reads it from the execution context; redaction applied before truncation; sampler evaluated in `attach` handler.
- **Test scenarios:** AE8, AE9; payload grep finds no `apiKey`/`Authorization`; truncation marker; deterministic hash sampling stable across runs.

### U5. Trace context propagation (header hook)

- **Goal:** Join library spans to upstream/downstream services.
- **Requirements:** R16
- **Dependencies:** U2
- **Files:** `src/trace/propagation.ts` (new), `src/providers/base.ts` (optional header), `src/mcp/http-transport.ts` (when Area 5 lands; otherwise `SSETransport`), `tests/trace/propagation.test.ts` (new)
- **Approach:** Pure parse/format functions with strict validation (reject invalid versions/all-zero ids); adapters add the header only when the flag is on and an active span exists.
- **Test scenarios:** Round-trip; malformed header rejected; header absent by default.

### U6. Docs and example

- **Goal:** Copy-pasteable setup for common backends.
- **Requirements:** R1, R13
- **Dependencies:** U3
- **Files:** `README.md` (Tracing & Export section)
- **Approach:** Examples for local collector, Langfuse, Honeycomb headers; documents warnings, shutdown-in-signal-handler pattern, and privacy defaults.
- **Test scenarios:** README snippet compiled in the Area 8 docs-snippet check.

---

## Verification Matrix

| Requirement group | Primary tests |
| --- | --- |
| R1–R6 | `tests/trace/otlp-http.test.ts` |
| R7–R10a | `tests/trace/genai.test.ts`, `tests/agent/agent-loop.test.ts` |
| R11–R12 | `tests/trace/exporter.test.ts` |
| R13–R15 | `tests/trace/privacy.test.ts` |
| R16 | `tests/trace/propagation.test.ts` |

Run order: U1 → U2 and U3 in parallel → U4 → U5 → U6. Ship U1 + U3 first (export works), then U2.

---

## How This Work Fits Together

- **Agent capabilities (Area 4):** new spans (`model:stream`, `guardrail:*`) reuse `genai.ts`.
- **MCP modernization (Area 5):** HTTP transport gets the `traceparent` hook in U5.
- **Production storage (Area 6):** storage spans already map to client kind; no change.
- **Release readiness (Area 8):** README snippet verification and the package export of `./trace` are covered there.
