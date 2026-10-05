---
title: Agent Capabilities - Plan
type: feat
date: 2026-10-06
topic: agent-capabilities
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Agent Capabilities - Plan

## Goal Capsule

- **Objective**: `Agent` becomes usable for interactive and production workloads: it streams events while running, executes tool calls from one model turn concurrently when asked, enforces caller-supplied guardrails, returns a schema-validated final object, and can use tools exposed by an `MCPClient` without hand-written glue. Every new path fails loudly (typed errors, no silent drops).
- **Product Authority**: Area 4 of 8 from the 2026-10-04 library assessment (reliability pass deferred list). Builds on Area 2 (model-layer parity, merged on `feat-decision-models`: `ToolCallStreamAssembler`, `finalizeStream`, `outputSchema`, capability flags).
- **Open Blockers**: None. Assumes the model-layer parity and decision-model work on `feat-decision-models` is merged to `main` first.
- **Execution profile**: Test-first; use scripted `LanguageModel` fakes (see `tests/agent/agent-loop.test.ts`) and `InMemoryTransport` pairs for MCP. No live keys.

---

## Product Contract

### Summary

Add `Agent.runStream()` (event stream), opt-in parallel tool execution with ordered, checkpoint-safe commits, input/output/tool guardrails with a tripwire error, structured final output via `outputSchema`, and a `createMCPTools()` bridge that turns an `MCPClient` into executable `Tool[]`.

### Problem Frame (what exists vs missing)

**Exists** (`src/agent/agent.ts`, `tool.ts`, `checkpoint.ts`, `jit-retriever.ts`):

- `Agent.run()` / `resume()`: loop of `model.generate` → sequential tool execution → repeat until no tool calls or `maxIterations` (default 10, status `step_limit` with empty text).
- Checkpoints per tool (`pendingToolCalls`, `completedToolIds`), `abandon`, spans (`agent:run`, `agent:step:N`, `model:generate`, `tool:run:*`), metering via `createMeteredModel`.
- `Tool.run` validates args with `validateSchema(..., 'strip')` and throws `InvalidInputError`; the agent converts every tool error (except `CancelledError`/`BudgetRefusedError`) to a model-visible `Error: ...` string.
- Core already provides `ToolCallStreamAssembler`, `assembleStream`, `finalizeStream` (`src/core/tool-stream.ts`), `ModelRequest.outputSchema`, `ModelResponse.structured`, and optional `LanguageModel.capabilities` (read via `getCapabilities( model )`, falling back to `NO_CAPABILITIES`). `finalizeStream` already tolerates `outputSchema` alongside tools: it expects `structured` only on the tool-free turn.

**Missing**:

- Streaming: the agent never calls `model.stream`; no incremental text/tool events for UIs.
- Concurrency: `for ( const tc of pendingToolCalls )` runs tools one by one; `ToolCall[]` from a single turn are independent but never overlapped.
- Guardrails: no hook to inspect/deny input, tool calls, tool results, or final output; budget refusal is the only built-in stop.
- Structured final output: `AgentConfig` has no `outputSchema`; `AgentResult` has only `text`.
- MCP binding: `MCPClient.toToolDefinitions()` returns `ToolDefinition[]` (no `execute`), but `AgentConfig.tools` takes `Tool[]`, so MCP tools cannot be bound; README line "Bindable directly to Agent" is inaccurate.
- `maxIterations` exhaustion returns `text: ''` with status `step_limit`; callers cannot tell from `AgentResult` alone why there is no output when `outputSchema` is requested.

### Key Decisions

- **One step engine, two surfaces** (chosen over duplicating `run` and `runStream`): `run()` is implemented by draining `runStream()` internally so checkpointing, spans, and metering exist once. Governs R1–R5.
- **Streaming uses `model.stream` + `finalizeStream`** (chosen over parsing deltas in the agent): the assembler already validates tool JSON and structured output and raises on missing terminators. Governs R2, R3.
- **Parallelism is opt-in, default 1** (chosen over default-parallel: existing tools may share state; the package is unpublished but behavior preservation keeps the checkpoint tests valid). `Tool` may declare `parallelSafe: false` to force serial execution. Governs R6–R9.
- **Tool messages commit in model-call order, not completion order** (chosen over completion-order appends: providers require tool results to align with `toolCalls`; and resume correctness depends on a contiguous completed prefix). Governs R7, R8.
- **Guardrails are plain async functions returning allow/deny** (chosen over a rules DSL). A deny is model-visible for tool-level checks and a thrown `GuardrailTripwireError` for input/output checks. Governs R10–R14.
- **Structured output goes through the model's native `outputSchema`** (chosen over a prompt-and-parse fallback); agent construction fails when `getCapabilities( model ).structuredOutput` is false. Governs R15–R18.
- **MCP bridge lives in `src/mcp/tools.ts`** (chosen over `src/agent/`: `mcp` already depends on `agent/context`; keeps the dependency direction one-way). Governs R19–R22.

### Requirements

**Streaming**

- R1. `Agent.runStream( input, options )` returns `AsyncIterable<AgentEvent>` and resolves its final `AgentResult` through the terminal `finish` event; `Agent.run` returns the same result as draining `runStream`.
- R2. `AgentEvent` is a discriminated union: `step:start`, `text:delta`, `reasoning:delta`, `tool:call` (assembled, validated), `tool:result`, `step:finish` (with usage), `finish` (with `AgentResult`). Order is deterministic per step.
- R3. Tool-call JSON that fails assembly or schema validation throws `ProviderError` / `InvalidInputError` out of the iterator (no partial `tool:call` emitted); a stream without terminator throws (existing core behavior).
- R4. Breaking out of the iterator or aborting `options.signal` cancels the in-flight model request and saves an `interrupted` checkpoint, same as `run` today.
- R5. Checkpoint, span, and spend semantics are identical between `run` and `runStream` (same span names; `model:generate` becomes `model:stream` only for streamed steps).

**Parallel tools**

- R6. `AgentConfig.toolConcurrency?: number` (default `1`, integer ≥ 1, validated in the constructor). Values > 1 execute the tool calls of a single model turn with at most that many in flight.
- R7. Tool result messages are appended in the order of the assistant message's `toolCalls`; `completedToolIds` and checkpoints only include tools whose result message has been committed.
- R8. On resume after interruption, tools not yet committed are re-run; committed ones are skipped (existing `completedToolIds` contract).
- R9. First `CancelledError` / `BudgetRefusedError` from any tool aborts siblings (via a derived `AbortSignal`), waits for them to settle, saves `interrupted`, and rethrows. Other errors stay model-visible strings.

**Guardrails**

- R10. `AgentConfig.guardrails?: { input?, toolCall?, toolResult?, output? }`, each an array of `( payload, ctx ) => Promise<GuardrailVerdict> | GuardrailVerdict`, where `GuardrailVerdict = { allow: true } | { allow: false, reason: string, tripwire?: boolean }`.
- R11. `input` runs once before the first model call of a fresh run (not on resume); `output` runs on the final text/structured value before status `completed`.
- R12. `toolCall` runs before each tool executes; a non-tripwire deny produces the tool message `Error: blocked by guardrail: <reason>` without executing the tool. `toolResult` runs after execution and may deny the same way.
- R13. A deny with `tripwire: true`, or any `input`/`output` deny, throws `GuardrailTripwireError` (`AIError` code `AGENT_GUARDRAIL_TRIPPED`, carries `stage`, `reason`), saves status `blocked`, and ends the span with error.
- R14. A guardrail that throws is a tripwire (fail closed), wrapping the cause.

**Structured final output**

- R15. `AgentConfig.outputSchema?: JsonSchema | Record<string, unknown>`. Construction throws `AIError` (`AGENT_CAPABILITY`) naming `structuredOutput` and provider when the model lacks the capability.
- R16. With `outputSchema`, the final step (no tool calls) returns `AgentResult.output` equal to the validated `structured` value; a final response without `structured` throws `InvalidInputError`.
- R17. `outputStrategy?: 'inline' | 'finalize'` (default `'finalize'`): `finalize` runs the tool loop without a schema and issues one extra tool-less `generate` with `outputSchema` over the history; `inline` sends the schema on every step (opt-in; relies on provider support for schema + tools together).
- R18. `status: 'step_limit'` with `outputSchema` set never fabricates `output`; `output` is `undefined` and the existing status signals the cause.

**MCP binding**

- R19. `createMCPTools( client, options? ): Promise<Tool[]>` lists tools (all pages) and returns `Tool` instances whose `execute` calls `client.callTool( name, args, { context, signal } )`.
- R20. Options: `prefix?: string`, `include?: string[] | RegExp`, `exclude?`; duplicate resulting names throw `AIError` before returning.
- R21. `isError: true` results throw (surfaced to the model as `Error: ...` by the agent); text items join with `\n`; any non-`text` item throws `AIError` (`MCP_UNSUPPORTED_CONTENT`) naming the type rather than dropping it.
- R22. Tool `parameters` use the server `inputSchema` verbatim; schema keywords the validator rejects fail at bind time (`createMCPTools` throws), not at call time.

### Acceptance Examples

- AE1. Streaming order
  - **Covers R1, R2.** **Given** a scripted model that streams text "Looking up" then one tool call, then "Done". **When** `runStream` is consumed. **Then** events arrive `step:start`, `text:delta`…, `tool:call`, `tool:result`, `step:finish`, `step:start`, `text:delta`, `step:finish`, `finish`.
- AE2. Malformed streamed tool JSON
  - **Covers R3.** **Given** a stream with `{"q":` then terminator. **Then** iteration throws `ProviderError`; no `tool:call` event was emitted.
- AE3. Parallel with ordered commit
  - **Covers R6, R7.** **Given** `toolConcurrency: 3` and three tool calls where call 1 takes 50 ms and call 3 takes 5 ms. **Then** all three overlap (wall time < 80 ms) and tool messages are appended 1, 2, 3.
- AE4. Interrupt mid-batch then resume
  - **Covers R8.** **Given** call 3 finished before call 1 when the signal aborts. **Then** the checkpoint's `completedToolIds` is empty (call 1 uncommitted); `resume` re-runs 1, 2, 3 once each.
- AE5. Tool guardrail
  - **Covers R12.** **Given** a `toolCall` guardrail denying `delete_*`. **Then** the tool body is not invoked and the model receives `Error: blocked by guardrail: ...`.
- AE6. Output tripwire
  - **Covers R13.** **Given** an `output` guardrail that denies. **Then** `run` throws `GuardrailTripwireError`, the checkpoint status is `blocked`.
- AE7. Structured output unsupported
  - **Covers R15.** **Given** a model with `capabilities.structuredOutput === false`. **Then** `new Agent({ outputSchema })` throws naming `structuredOutput`.
- AE8. MCP binding
  - **Covers R19, R21.** **Given** an `MCPServer` registering `add(a,b)` over `InMemoryTransport`. **Then** `createMCPTools` returns a `Tool` named `add`; an agent run calls it and the result text reaches the model; an image content item throws `MCP_UNSUPPORTED_CONTENT`.

### Success Criteria

- A chat UI can render token deltas and tool progress from `runStream` alone.
- Existing `tests/agent/*` pass unchanged (default `toolConcurrency: 1`).
- Every R# has at least one regression test; no catch-and-ignore paths added.

### Scope Boundaries

**In scope**: `src/agent/*`, `src/mcp/tools.ts`, new error class in `src/core/error.ts`, README agent/MCP sections for the new surface.

**Deferred**

- Sub-agents / handoffs / agent-as-tool.
- Human-in-the-loop approval hooks inside `Agent` (workflow engine already owns HITL).
- Streaming of partial structured objects (only the validated final object).
- Per-tool timeouts and retry policy for tools.
- Memory/summarization of long histories (`context` truncation).

**Out of scope**: model-layer changes (Area 2), MCP protocol changes (Area 5), trace export (Area 7).

### Dependencies / Assumptions

- `LanguageModel.capabilities` and `finalizeStream` from model-layer parity are on `main`.
- Area 5 is not required; `createMCPTools` uses the existing `listTools` / `callTool`. Pagination support (Area 5 U1) improves it automatically.

### Outstanding Questions

**Deferred to implementation**

- Whether `inline` strategy is safe on Anthropic/Gemini with tools present (probe via provider tests; if unsupported, throw a capability error for `inline`).
- Whether `parallelSafe` belongs on `ToolConfig` or only on `AgentConfig.serialTools: string[]` (prefer `ToolConfig`).

---

## Planning Contract (KTD)

| Topic | Decision |
| --- | --- |
| Event type | `AgentEvent` discriminated union in `src/agent/events.ts` |
| Streaming step | `model.stream` → `finalizeStream`; emits events as chunks arrive, `tool:call` only after assembly |
| Concurrency primitive | Small internal `mapLimit` in `src/agent/concurrency.ts`; ordered commit queue |
| Statuses | Add `'blocked'` to `AgentRunStatus` |
| Errors | `GuardrailTripwireError extends AIError` |
| MCP bridge | `src/mcp/tools.ts`, exported from `src/mcp/index.ts` |

---

## Implementation Units

### U1. Agent event stream (`runStream`)

- **Goal:** Single step engine emitting events; `run()` drains it.
- **Requirements:** R1–R5
- **Dependencies:** none
- **Files:** `src/agent/events.ts` (new), `src/agent/agent.ts`, `src/agent/index.ts`, `tests/agent/agent-stream.test.ts` (new); regression: `tests/agent/agent-loop.test.ts`, `resume.test.ts`
- **Approach:**
  1. Extract the per-step body of `#executeRun` into an async generator; `run` iterates it and returns the `finish` payload.
  2. Streamed step: `finalizeStream( model.stream( req ), { tools, outputSchema } )`; map chunks to `text:delta` / `reasoning:delta`; emit `tool:call` per assembled call.
  3. Keep `save()` points identical (before tools, after each commit, on completion).
  4. Iterator `return()` aborts a derived controller and saves `interrupted`.
- **Test scenarios:** AE1, AE2; abort mid-stream saves `interrupted`; spend recorded once per step via `MeteredModel.stream`; `run` and `runStream` produce equal `messages`.

### U2. Parallel tool execution

- **Goal:** Bounded concurrency with ordered commits and checkpoint safety.
- **Requirements:** R6–R9
- **Dependencies:** U1
- **Files:** `src/agent/concurrency.ts` (new), `src/agent/agent.ts`, `src/agent/tool.ts` (`parallelSafe`), `tests/agent/parallel-tools.test.ts` (new)
- **Approach:**
  1. Constructor validates `toolConcurrency`.
  2. Run tools via limiter; results land in an index-keyed array; a commit cursor appends contiguous finished results and pushes to `completedToolIds`, then `save( 'interrupted' )`.
  3. Derived `AbortController` linked to `options.signal`; fatal errors abort siblings, `allSettled`, then rethrow.
  4. Tools with `parallelSafe === false` act as barriers (run alone).
- **Test scenarios:** AE3, AE4; fatal error cancels siblings and still saves `interrupted`; concurrency cap respected (track max in flight); `toolConcurrency: 0` throws.

### U3. Guardrails

- **Goal:** Input/tool/output guardrails with fail-closed semantics.
- **Requirements:** R10–R14
- **Dependencies:** U1 (events/spans), U2 for tool ordering
- **Files:** `src/agent/guardrails.ts` (new), `src/core/error.ts` (`GuardrailTripwireError`), `src/agent/checkpoint.ts` (`'blocked'`), `src/agent/agent.ts`, `tests/agent/guardrails.test.ts` (new)
- **Approach:** Guardrail runner evaluates arrays in order (first deny wins), wraps throws per R14, records a `guardrail:<stage>` span with `guardrail.allowed` / `guardrail.reason` attributes.
- **Test scenarios:** AE5, AE6; input deny prevents any model call and writes no `running` checkpoint beyond the marker; guardrail throw becomes tripwire; guardrails skipped on `resume` for `input`.

### U4. Structured final output

- **Goal:** `AgentResult.output` validated against `outputSchema`.
- **Requirements:** R15–R18
- **Dependencies:** U1
- **Files:** `src/agent/agent.ts`, `src/agent/index.ts` (types), `tests/agent/structured-output.test.ts` (new)
- **Approach:** Reuse `generateStructured` / `ModelRequest.outputSchema`; `finalize` strategy adds one step after the tool loop (counts toward `runStepCount`, bypasses `maxIterations` check so it cannot be starved—document). Output guardrails (U3) run on `output`.
- **Test scenarios:** AE7; valid object returned; schema mismatch throws `InvalidInputError`; `step_limit` leaves `output` undefined; `inline` capability probe.

### U5. MCP tools for agents

- **Goal:** `createMCPTools` bridge.
- **Requirements:** R19–R22
- **Dependencies:** none (parallel to U1–U4)
- **Files:** `src/mcp/tools.ts` (new), `src/mcp/index.ts`, `src/mcp/types.ts` (content item types), `tests/mcp/tools.test.ts` (new), README MCP section
- **Approach:** `client.listTools()` → `createTool({ name, description, parameters: inputSchema, execute })`; execute forwards `context` and `signal` from the tool's `ExecutionContext` so MCP spans/spend nest under `tool:run:*`.
- **Test scenarios:** AE8; prefix/include/exclude; duplicate names; `isError` becomes thrown error; schema keyword rejected at bind time; agent + in-memory MCP end-to-end with tracing (MCP spans appear under the tool span).

---

## Verification Matrix

| Requirement group | Primary tests |
| --- | --- |
| R1–R5 | `tests/agent/agent-stream.test.ts` |
| R6–R9 | `tests/agent/parallel-tools.test.ts` |
| R10–R14 | `tests/agent/guardrails.test.ts` |
| R15–R18 | `tests/agent/structured-output.test.ts` |
| R19–R22 | `tests/mcp/tools.test.ts` |

Run order: U1 → U2 → U3 → U4; U5 anytime. Ship U5 and U1 first (largest user value).

---

## How This Work Fits Together

- **Model-layer parity (Area 2):** supplies the assembler, structured output, and capabilities used here.
- **MCP modernization (Area 5):** independent; U5 gains pagination/auth for free once Area 5 lands.
- **Observability (Area 7):** agent events and spans from U1/U3 should carry GenAI attributes defined there; coordinate span names.
- **Release readiness (Area 8):** README agent section is finalized after this plan.
