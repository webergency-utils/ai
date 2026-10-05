---
title: MCP Modernization - Plan
type: feat
date: 2026-10-06
topic: mcp-modernization
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# MCP Modernization - Plan

## Goal Capsule

- **Objective**: `MCPClient` and `MCPServer` speak current MCP over the transport real servers use today (Streamable HTTP), negotiate protocol versions instead of hardcoding one, expose resources and prompts alongside tools, and support bearer-style auth. Anything the library cannot honor (unknown protocol version, missing server capability, unsupported content) fails with a typed error instead of being ignored.
- **Product Authority**: Area 5 of 8 from the 2026-10-04 library assessment. Reliability pass already hardened timeouts, cancellation (R40), and transport close (R58).
- **Open Blockers**: None. Spec details (version strings, header names) are checked against the official MCP specification at implementation time; tests lock behavior with fixtures.
- **Execution profile**: Test-first; transports tested with injected `fetch` returning real `Response` bodies (`tests/helpers/http.ts` pattern); no network.

---

## Product Contract

### Summary

Add protocol version negotiation and capability tracking, a Streamable HTTP client transport and a web-standard server handler, harden the legacy SSE transport, add resources and prompts on both client and server, and add a pluggable auth hook with 401 handling. Full OAuth 2.1 flows are out of scope.

### Problem Frame (what exists vs missing)

**Exists** (`src/mcp/*`):

- `MCPClient`: `connect()` sends `initialize` with hardcoded `protocolVersion: '2024-11-05'`, **ignores the result**, sends `notifications/initialized`. `listTools` (no pagination), `callTool` (trace `_meta`, spend, spans, cancel/timeouts), `toToolDefinitions`.
- `MCPServer`: handles `initialize` (always replies `2024-11-05`, `capabilities: { tools: {} }`), `tools/list`, `tools/call`; every other method returns `-32601`, including `ping`.
- Transports: `InMemoryTransport`, `StdioTransport` (NDJSON), legacy `SSETransport` (GET event stream + POST to the `endpoint` event URL).
- `MCPClient.handleIncoming` only resolves responses; server-initiated requests and notifications are silently dropped.

**Defects/gaps in current code**:

- `SSETransport.connect()` resolves before the `endpoint` event arrives; an early `send` falls back to POSTing to the stream URL. No custom headers, so no auth. Malformed event JSON is swallowed (`catch {}`).
- No version check: a server answering with a different version, or an error, is not detected beyond `request()` surfacing a JSON-RPC error.
- No `ping`, no server capability inspection, no `nextCursor` handling, no resources/prompts, `MCPContentItem` lacks `resource_link`, `structuredContent`, and annotations.
- A server-initiated request (e.g. `ping`, `roots/list`) never gets a response, so well-behaved servers can stall.

### Key Decisions

- **Negotiation is explicit and fail-loud** (chosen over accept-anything): client offers its newest supported version; if the server replies with a version outside the supported list, the client closes the transport and throws `MCP_PROTOCOL_VERSION_UNSUPPORTED`. Governs R1–R4.
- **Capabilities gate methods** (chosen over best-effort calls): `listResources()` on a server without `resources` capability throws `MCP_CAPABILITY_MISSING` before sending. Governs R3.
- **Server HTTP handler is a web-standard `(Request) => Promise<Response>`** (chosen over binding to `node:http`): works in Node 20+, Bun, and any framework adapter; no new dependencies. Governs R9–R12.
- **Stateless server by default, optional sessions** (chosen over mandatory sessions): tool-only servers need no session store; session id support is available for stateful deployments. Governs R10.
- **Streamable HTTP client transport tries POST-JSON-or-SSE responses; legacy SSE kept** behind explicit `SSETransport` plus a `connectMCPClient( url )` helper that falls back per the spec's backwards-compat rule (POST `initialize`; on 4xx try legacy). Governs R5–R8.
- **Auth is a hook, not an OAuth client** (chosen over bundling OAuth 2.1/PKCE/DCR): `authProvider` supplies headers and may refresh once on `401`. Governs R15–R17.
- **Server-initiated messages get an explicit policy** (chosen over silent drop): `ping` answered, unsupported requests answered with `-32601`, notifications routed to an optional listener. Governs R4.

### Requirements

**Negotiation and lifecycle**

- R1. A module-level `SUPPORTED_PROTOCOL_VERSIONS` (newest first; at implementation time at minimum `2025-06-18`, `2025-03-26`, `2024-11-05`, plus the newest published revision) and `LATEST_PROTOCOL_VERSION` are exported.
- R2. `MCPClient.connect()` sends the latest version, validates the server's `protocolVersion` against the supported list, stores `negotiatedVersion`, `serverCapabilities`, `serverInfo`, and `instructions` (readable getters), and throws before `notifications/initialized` on mismatch.
- R3. Client methods requiring a capability (`tools`, `resources`, `prompts`) throw `AIError` code `MCP_CAPABILITY_MISSING` naming the capability when the server did not advertise it. `connect()` options allow `strictCapabilities: false` to opt out.
- R4. Server-initiated traffic: `ping` request → `{}` result; unknown requests → `-32601` error response; notifications dispatched to `client.onNotification( handler )`. Client sends `ping` via `client.ping()`.
- R4a. `MCPServer` negotiates: echoes the client's version if supported, otherwise replies with its latest; answers `ping`; rejects any method before `initialize` (`-32002`) except `ping`.

**Streamable HTTP transport (client)**

- R5. `StreamableHTTPTransport( url, options )` POSTs each JSON-RPC message with `Accept: application/json, text/event-stream`. A `application/json` response is delivered as one message; `text/event-stream` is parsed as SSE and each event delivered; `202` is accepted for notifications/responses.
- R6. `Mcp-Session-Id` from the initialize response is stored and sent on every later request; after `initialize` the negotiated version is sent as `MCP-Protocol-Version` (new optional `MCPTransport.setProtocolVersion?`). `close()` sends `DELETE` when a session exists (best-effort, ignoring failure).
- R7. HTTP `404` with a session id is a distinct `MCP_SESSION_EXPIRED` error (no automatic re-initialize); other non-2xx responses throw `MCP_TRANSPORT_ERROR` with status and a truncated body.
- R8. Optional GET listening stream for server-initiated messages (`listen: true`); a dropped SSE response mid-request rejects pending requests via `onClose`; resume with `Last-Event-ID` is attempted once, then fails.

**Streamable HTTP (server) and legacy SSE hardening**

- R9. `createMCPHttpHandler( server, options )` returns `( req: Request ) => Promise<Response>` handling POST (single or batched JSON-RPC → JSON response, or 202 for notifications-only), `GET` → `405`, `DELETE` → terminate session if sessions enabled.
- R10. `options.sessions?: boolean` (default false). When true, `initialize` issues `Mcp-Session-Id`; requests without a valid id get `400`/`404` per spec.
- R11. `Origin` validation: if an `Origin` header is present it must match `options.allowedOrigins` (default: reject any cross-origin; missing Origin allowed); violation → `403`.
- R12. `options.authenticate?( req ) => Promise<AuthResult>`; failure → `401` with `WWW-Authenticate: Bearer` (+ optional `resource_metadata`).
- R13. `SSETransport.connect()` resolves only after the `endpoint` event (bounded by `connectTimeoutMs`, default 10 s, error otherwise); `send` before that is impossible; custom `headers`/`fetch` options are accepted; malformed event JSON surfaces through an `onError` hook and closes with `MCP_PROTOCOL_ERROR` instead of being swallowed.

**Resources and prompts**

- R14. Server: `registerResource( { uri, name, description?, mimeType? }, read )`, `registerResourceTemplate( { uriTemplate, ... }, read )`, `registerPrompt( { name, description?, arguments? }, get )`. Capabilities are advertised only for registered kinds. Methods: `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`. Unknown URI/prompt → `-32602`.
- R14a. Client: `listResources`, `listResourceTemplates`, `readResource( uri )`, `listPrompts`, `getPrompt( name, args )`, all following `nextCursor` (cap `maxPages`, default 100, throwing beyond).
- R14b. Content types: `MCPContentItem` gains `resource_link`; `MCPToolResult` gains `structuredContent`; resource contents carry `text` xor `blob` (validated; both or neither throws).

**Auth**

- R15. Transports accept `headers` and `authProvider: { getHeaders(): Promise<Record<string,string>>, onUnauthorized?( info ): Promise<boolean> }`.
- R16. On `401`, call `onUnauthorized` once; if it returns true retry the request once; otherwise throw `MCPAuthError` (`MCP_UNAUTHORIZED`) carrying the parsed `WWW-Authenticate` challenge and `resource_metadata` URL when present. `403` throws `MCP_FORBIDDEN`.
- R17. Authorization headers are never logged, never included in error messages or spans.

### Acceptance Examples

- AE1. Version mismatch
  - **Covers R2.** **Given** a server replying `protocolVersion: '1999-01-01'`. **Then** `connect()` rejects with `MCP_PROTOCOL_VERSION_UNSUPPORTED` and the transport is closed; `initialized` is not sent.
- AE2. Missing capability
  - **Covers R3.** **Given** a tools-only server. **Then** `client.listResources()` rejects with `MCP_CAPABILITY_MISSING` and no request is sent.
- AE3. Streamable HTTP, JSON response
  - **Covers R5, R6.** **Given** a fake fetch returning JSON for `initialize` with `Mcp-Session-Id: s1`. **Then** the next POST carries `Mcp-Session-Id: s1` and `MCP-Protocol-Version: <negotiated>`.
- AE4. Streamable HTTP, SSE response
  - **Covers R5.** **Given** `tools/call` answered by an SSE body with a progress notification then the result. **Then** the notification reaches `onNotification` and the call resolves with the result.
- AE5. Session expired
  - **Covers R7.** **Given** a 404 after a session id was issued. **Then** the pending call rejects with `MCP_SESSION_EXPIRED`.
- AE6. Server handler round trip
  - **Covers R9, R10.** **Given** `createMCPHttpHandler( server, { sessions: true } )` and `StreamableHTTPTransport` with `fetch = handler`. **Then** `initialize`, `tools/list`, `tools/call` succeed; missing session id on a later request returns 400.
- AE7. DNS-rebinding guard
  - **Covers R11.** **Given** `Origin: https://evil.example`. **Then** the handler returns 403 without invoking any tool.
- AE8. 401 refresh
  - **Covers R16.** **Given** first response 401 and `onUnauthorized` returning true with a new token. **Then** exactly one retry is sent; a second 401 throws `MCPAuthError`.
- AE9. Legacy SSE endpoint race
  - **Covers R13.** **Given** an SSE stream emitting `endpoint` after 50 ms. **Then** `connect()` resolves after the event and the first POST goes to the endpoint URL; with no event within `connectTimeoutMs` it rejects.
- AE10. Resources and prompts
  - **Covers R14.** **Given** a server with one resource and one prompt over `InMemoryTransport`. **Then** list/read/get round-trip; `resources/read` for an unknown URI yields `-32602`.

### Success Criteria

- A client built with this library can connect to a Streamable HTTP MCP server and list/call tools; a server built with it can be mounted behind `Bun.serve` / Node `http` with a 10-line adapter.
- No MCP error is swallowed; legacy tests (`tests/mcp/*`) keep passing.

### Scope Boundaries

**In scope**: `src/mcp/*`, new error codes, README MCP section, tests under `tests/mcp/`.

**Deferred**

- Full OAuth 2.1 (PKCE, dynamic client registration, protected-resource metadata discovery, token storage).
- Server-to-client features: sampling, roots, elicitation (client answers `-32601` per R4).
- Resource subscriptions and `list_changed` notifications; progress/log notifications on the server side.
- Server-side SSE streaming of long tool calls (handler returns JSON only), resumable server streams.
- Batching on the client (server accepts batches per R9).
- Tasks / long-running operations extensions.

**Out of scope**: agent binding (Area 4 U5), trace export (Area 7).

### Dependencies / Assumptions

- Reliability pass MCP work merged (timeouts, cancel, `onClose`).
- `parseSSEStream` in `src/core/stream.ts` is reused for event parsing; it already yields the SSE `id` per event, which is enough for `Last-Event-ID` resume.
- Node 20+ global `fetch`, `Request`, `Response`.

### Outstanding Questions

**Deferred to implementation**

- Exact newest protocol revision string to include (check spec site on implementation day).
- Whether `initialize` may be sent in a stateless server handler when no session is requested (spec-optional; default yes).

---

## Planning Contract (KTD)

| Topic | Decision |
| --- | --- |
| Version list | `src/mcp/protocol.ts` constants; server and client share |
| Transport hook | Optional `setProtocolVersion?( v )` on `MCPTransport`; no breaking change |
| New transport | `src/mcp/http-transport.ts` (client), `src/mcp/http-handler.ts` (server) |
| Errors | `AIError` subclasses/codes: `MCP_PROTOCOL_VERSION_UNSUPPORTED`, `MCP_CAPABILITY_MISSING`, `MCP_SESSION_EXPIRED`, `MCP_UNAUTHORIZED`, `MCP_FORBIDDEN`, `MCP_PROTOCOL_ERROR` |
| Pagination | One internal `paginate( method, key )` helper, `maxPages` guard |

---

## Implementation Units

### U1. Protocol negotiation, capabilities, ping, pagination

- **Goal:** Replace the hardcoded handshake with negotiated lifecycle.
- **Requirements:** R1–R4, R4a, R14a (pagination part)
- **Dependencies:** none
- **Files:** `src/mcp/protocol.ts` (new), `src/mcp/client.ts`, `src/mcp/server.ts`, `src/mcp/types.ts`, `tests/mcp/negotiation.test.ts` (new); regression `tests/mcp/client-server.test.ts`
- **Approach:** Parse the `initialize` result in `connect()`; add getters; `request()` routes incoming server requests through a handler (ping/-32601). Server tracks `initialized` state per transport connection.
- **Test scenarios:** AE1, AE2; old-version server accepted; error response to `initialize` surfaces; `tools/list` with two pages; page cap exceeded throws; pre-initialize request rejected.

### U2. Streamable HTTP client transport

- **Goal:** Working client against Streamable HTTP servers.
- **Requirements:** R5–R8, R15–R17 (headers/auth part)
- **Dependencies:** U1
- **Files:** `src/mcp/http-transport.ts` (new), `src/mcp/index.ts`, `tests/mcp/http-transport.test.ts` (new)
- **Approach:** Per-message POST; response dispatch by `content-type`; session and version headers; optional GET listener with one `Last-Event-ID` resume; abort via `AbortController` per request, linked to `close()`. Injected `fetch` option for tests and custom agents.
- **Test scenarios:** AE3, AE4, AE5; 202 for notifications; unknown content-type throws; truncated SSE rejects pending; `close()` sends DELETE; headers not leaked into errors.

### U3. Auth hook and 401/403 handling

- **Goal:** Pluggable auth on HTTP transports.
- **Requirements:** R15–R17
- **Dependencies:** U2
- **Files:** `src/mcp/auth.ts` (new), `src/mcp/http-transport.ts`, `src/mcp/client.ts` (`SSETransport` options), `tests/mcp/auth.test.ts` (new)
- **Approach:** Shared `applyAuth( transportOptions )` + `WWW-Authenticate` parser (Bearer params incl. `resource_metadata`, `scope`, `error`). One retry rule implemented once and used by both HTTP transports.
- **Test scenarios:** AE8; 403; challenge parsing with quoted params; token never in error text.

### U4. Legacy SSE hardening and fallback helper

- **Goal:** Close the endpoint race and swallow-errors defects; offer one-call connect.
- **Requirements:** R13, R8 (fallback)
- **Dependencies:** U2, U3
- **Files:** `src/mcp/client.ts` (move `SSETransport` to `src/mcp/sse-transport.ts`, re-export), `src/mcp/connect.ts` (new `connectMCPClient( url, options )`), `tests/mcp/sse-transport.test.ts` (new)
- **Approach:** Promise resolved by `endpoint` event with timeout; error hook; helper POSTs `initialize` with Streamable HTTP and falls back to SSE on 400/404/405 per spec.
- **Test scenarios:** AE9; malformed event closes with protocol error; fallback chooses SSE on 405 and Streamable on 200.

### U5. Server HTTP handler

- **Goal:** Mountable Streamable HTTP server endpoint.
- **Requirements:** R9–R12
- **Dependencies:** U1
- **Files:** `src/mcp/http-handler.ts` (new), `src/mcp/server.ts` (per-connection state, session-agnostic `handleMessage` remains), `src/mcp/index.ts`, `tests/mcp/http-handler.test.ts` (new)
- **Approach:** Decode JSON (400 on parse error with JSON-RPC `-32700`), dispatch each message through `server.handleMessage`, aggregate batch responses, sessions via in-memory map with TTL and max-count, `authenticate` and `allowedOrigins` run before parsing.
- **Test scenarios:** AE6, AE7; invalid JSON; batch mix of request + notification; GET → 405; session terminate; 401 header shape; body size cap (`maxBodyBytes`, default 4 MiB → 413).

### U6. Resources and prompts

- **Goal:** Server registration and client access for resources and prompts.
- **Requirements:** R14, R14a, R14b
- **Dependencies:** U1
- **Files:** `src/mcp/server.ts`, `src/mcp/client.ts`, `src/mcp/types.ts`, `tests/mcp/resources-prompts.test.ts` (new)
- **Approach:** Capability map built from registrations; URI template matching limited to RFC 6570 level-1 `{var}` (document; reject other operators at registration); content validation helper shared by `readResource`.
- **Test scenarios:** AE10; template read; blob/text validation; capability absent → `-32601` from server and `MCP_CAPABILITY_MISSING` from client; prompt argument required-check.

---

## Verification Matrix

| Requirement group | Primary tests |
| --- | --- |
| R1–R4a | `tests/mcp/negotiation.test.ts` |
| R5–R8 | `tests/mcp/http-transport.test.ts` |
| R9–R12 | `tests/mcp/http-handler.test.ts` |
| R13 | `tests/mcp/sse-transport.test.ts` |
| R14–R14b | `tests/mcp/resources-prompts.test.ts` |
| R15–R17 | `tests/mcp/auth.test.ts` |

Run order: U1 → (U2 → U3 → U4) and (U5, U6) in parallel after U1. Ship U1+U2 first (client interoperability), then U5.

---

## How This Work Fits Together

- **Agent capabilities (Area 4):** `createMCPTools` consumes the client; pagination (U1) and auth (U3) apply automatically.
- **Observability (Area 7):** HTTP transport requests should carry `traceparent` once trace export lands; reserve the header hook in U2 (no behavior now).
- **Release readiness (Area 8):** README MCP section and the "HTTP SSE" wording are corrected there after this lands.
