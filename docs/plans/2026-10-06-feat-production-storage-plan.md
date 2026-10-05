---
title: Production Storage Backends - Plan
type: feat
date: 2026-10-06
topic: production-storage
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Production Storage Backends - Plan

## Goal Capsule

- **Objective**: Agents, workflows, caches, and retrieval can run on durable, multi-process storage. Postgres (+pgvector), SQLite/LibSQL, Redis, and S3-compatible object stores (S3, R2, MinIO) implement the **existing** `IDocumentStore`, `IVectorStore`, `ICacheStore`, and `IFileStore` interfaces, with real compare-and-swap for `conditionalWrite`. A shared contract suite proves every backend behaves like the in-memory reference.
- **Product Authority**: Area 6 of 8 from the 2026-10-04 library assessment. Reliability pass R23 (CAS) defined `conditionalWrite`; only `MemoryDocStore` implements it today.
- **Open Blockers**: None. Integration services (Postgres+pgvector, Redis, MinIO) are CI service containers; tests skip locally when env vars are unset.
- **Execution profile**: Contract-test-first: write the suite against `Memory*`, then add each adapter until green. Adapters take **injected clients** — no new runtime dependencies.

---

## Product Contract

### Summary

Add a contract test harness, a driver-agnostic SQL layer with Postgres and SQLite/LibSQL document/cache stores, a pgvector vector store, a Redis cache and document store, and an S3-compatible file store using native `fetch` + SigV4. Make `CheckpointManager` use CAS for its "latest" pointer so concurrent writers cannot regress state.

### Problem Frame (what exists vs missing)

**Exists** (`src/storage/*`):

- Interfaces: `IDocumentStore` (`get`, `getWithMeta` → `{doc,version}`, `set`, `conditionalWrite( collection, id, doc, { expectedVersion: number | null } ) → { written, version }`, `delete`, `list( collection, filter )`, `count`, `clear`), `IVectorStore` (`upsert`, `query(vector, topK|options, filter)`, `delete`, `count`, `clear`; cosine similarity, `DimensionMismatchError`), `ICacheStore` (`get/set(ttl)/delete/has/clear/size`), `IFileStore` (`write/read/readStream/delete/exists/getMetadata`).
- Implementations: `MemoryDocStore`, `MemoryVectorStore`, `MemoryCacheStore` (LRU + TTL), `MemoryFileStore`, `LocalDiskFileStore` (path-escape protection).
- Every memory implementation repeats the same instrumentation: storage spans (`storage:doc:list`, ...), `reportSpend` with `storagePricing`, and `ExecutionContext` handling.
- `WorkflowRunner.resume` already relies on `conditionalWrite` for exclusive claims; tests cover only the memory store.

**Missing / defects**:

- No durable document, vector, or cache store; `LocalDiskFileStore` is the only persistent adapter.
- No shared behavioral spec — adapter drift (filter semantics, `version` rules, TTL edge cases) would be invisible.
- `CheckpointManager.saveCheckpoint` writes the checkpoint then overwrites `<collection>_latest/<threadId>` with plain `set`; two processes on one thread can regress "latest". The workflow runner uses CAS; the agent checkpoint path does not.
- No object-storage file store, so `MessageAttachment` and agent artifacts cannot live off-box.

### Key Decisions

- **Contract suite before adapters** (chosen over per-adapter ad hoc tests): one parametrized suite per interface, run against `Memory*` first; every adapter must pass unmodified. Governs R1–R3.
- **Injected clients, zero new dependencies** (chosen over peer-depending on `pg`/`ioredis`/`@libsql/client`): adapters accept a tiny structural interface; shims (`fromPg`, `fromLibsql`, `fromNodeSqlite`, `fromIoRedis`, `fromNodeRedis`) are provided and tested with fakes. Governs R4, R12.
- **S3 over native `fetch` + SigV4** (chosen over AWS SDK): matches the package's native-HTTP adapter stance; Cloudflare R2 and MinIO compatible via `endpoint` + path-style option. Governs R16–R19.
- **Explicit schema management** (chosen over implicit DDL on each call): `await store.ensureSchema()` is idempotent and caller-invoked; operations on a missing schema fail with the driver error wrapped as `StorageError`. Governs R5.
- **Identifiers are validated, values are parameterized** (chosen over quoting): table/collection prefixes must match `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`; all user data goes through bind parameters. Governs R6.
- **Version semantics identical to memory**: `version` starts at 1, increments on every write, `conditionalWrite( null )` means create-only. Governs R7–R9.
- **Vectors: pgvector only in this plan** (chosen over also doing LibSQL native vectors/Redis Search): one proven path first. Governs R13–R15.
- **Shared instrumentation helper** (chosen over copy-pasting spans/spend into four more files): extract the span+spend wrapper used by `Memory*` into `src/storage/instrument.ts` and migrate memory stores onto it before adding adapters. Governs R3.

### Requirements

**Contract and shared behavior**

- R1. Contract suites exist for the four interfaces under `tests/storage/contract/`, exporting `runDocumentStoreContract( name, factory )` etc. Memory and LocalDisk stores run them in the default `npm test`.
- R2. Adapter suites run only when their env var is set (`TEST_POSTGRES_URL`, `TEST_REDIS_URL`, `TEST_S3_ENDPOINT` + credentials, SQLite via `node:sqlite` when available); skipped suites are reported as skipped, never as passed.
- R3. `src/storage/instrument.ts` provides one wrapper used by all stores for spans (`storage:<kind>:<op>`, `storage.collection` attribute), spend reporting, and `context` propagation; behavior of existing memory stores is unchanged (existing tests pass).
- R4. Adapter clients are structural interfaces (`SqlClient`, `RedisClient`) exported from `src/storage`; no `import` of vendor packages from `src/`.
- R5. Each SQL/Redis store exposes `ensureSchema()` (SQL only) and `close()` is **not** provided (caller owns the client).
- R6. Invalid table/prefix identifiers throw `InvalidInputError` at construction.
- R6a. Driver errors are wrapped in `StorageError` (`AIError` subclass, code `STORAGE_ERROR`) with `backend`, `operation`, and the cause; unique-violation races inside `conditionalWrite` map to `{ written: false }`, never to a throw.

**Document store (Postgres, SQLite/LibSQL, Redis)**

- R7. `conditionalWrite` is a single atomic statement per backend: Postgres/SQLite `INSERT ... ON CONFLICT DO NOTHING` for `expectedVersion: null` and `UPDATE ... SET version = version + 1 WHERE version = $n` otherwise (row count decides `written`); Redis uses one Lua script (`EVAL`).
- R8. `set` bumps the version (upsert); `getWithMeta` returns the stored version; `delete` returns whether a row existed; `list` supports the same equality filter semantics as `MemoryDocStore.matchesFilter` (documented JSON-path equality on top-level keys, plus nested dot paths if memory supports them — verified by contract tests).
- R9. Documents round-trip as JSON; values that `structuredClone` accepts but JSON cannot represent (`undefined` inside arrays, `Date`, `bigint`, `NaN`) throw `InvalidInputError` on write instead of corrupting silently. (Memory store gets the same guard in the same unit so the contract holds.)
- R10. Postgres stores docs in `JSONB` with `(collection, id)` primary key and a `version bigint`; SQLite/LibSQL use `TEXT` JSON with `json_extract` filters. Redis stores `{doc, version}` JSON under `<prefix>:doc:<collection>:<id>` plus a per-collection `SET` index for `list/count/clear` (documented O(n) `list`).
- R11. `CheckpointManager` writes the checkpoint document, then advances `<collection>_latest/<threadId>` via `conditionalWrite` with a bounded retry loop; a write whose `(runId, sequence)` is not newer than the stored latest for the same run throws `AIError` code `CHECKPOINT_CONFLICT` rather than overwriting. The legacy positional `saveCheckpoint( threadId, step, ... )` overload keeps working.

**Cache store (Postgres, SQLite, Redis)**

- R12. TTL honored per entry: Redis uses native `PX`; SQL stores keep `expires_at` and filter reads, with explicit `purgeExpired()`; `has`/`size` never count expired entries.
- R12a. `maxEntries` is not enforced by Redis/SQL stores (documented); constructing with `maxEntries` throws to avoid false expectations.

**Vector store (pgvector)**

- R13. `PgVectorStore( client, { table, dimensions } )`: `dimensions` is required (column type `vector(N)`); wrong-length input throws `DimensionMismatchError` before SQL is sent.
- R14. `query` returns cosine **similarity** (`1 - (embedding <=> $1)`) in the same ordering and score range as `MemoryVectorStore`; metadata filter is `metadata @> $filter::jsonb` for scalar equality and is documented as containment; unsupported operators throw.
- R15. `ensureSchema()` runs `CREATE EXTENSION IF NOT EXISTS vector`, creates the table, and an optional HNSW index (`index: { type: 'hnsw', m?, efConstruction? }`); a missing extension surfaces as `StorageError` with a remediation hint.

**File store (S3-compatible)**

- R16. `S3FileStore( { endpoint?, region, bucket, credentials, prefix?, forcePathStyle? } )` implements `IFileStore` using SigV4-signed `fetch`; credentials may be a static object or `() => Promise<Credentials>`.
- R17. `write` of a `ReadableStream` uses multipart upload above `multipartThresholdBytes` (default 8 MiB) with abort-on-failure cleanup; smaller content uses a single `PutObject`. Content type from metadata/extension.
- R18. `readStream` returns the response body without buffering; `read` buffers with a `maxReadBytes` guard (default 256 MiB, throw beyond). `getMetadata` uses `HEAD`; missing objects return `null`/`false`, any other non-2xx throws `StorageError` with status and S3 error code.
- R19. Paths reuse the traversal protection of `LocalDiskFileStore` (`PathEscapeError` for `..`, absolute, or NUL); keys are prefixed and URI-encoded per SigV4 rules.

### Acceptance Examples

- AE1. CAS exclusivity
  - **Covers R7.** **Given** any document store and `N=20` concurrent `conditionalWrite( 'c', 'a', doc, { expectedVersion: null } )`. **Then** exactly one returns `written: true`; the rest return `written: false` with the winner's version.
- AE2. Version monotonic
  - **Covers R7, R8.** **Given** `set` ×3 on one id. **Then** `getWithMeta().version === 3`; `conditionalWrite( expectedVersion: 2 )` returns `written: false, version: 3`.
- AE3. Unrepresentable value
  - **Covers R9.** **Given** a document containing `new Date()`. **Then** `set` throws `InvalidInputError` naming the path, on every backend.
- AE4. Cache TTL
  - **Covers R12.** **Given** `set( k, v, 1 )` and a fake clock (memory) / real 1.1 s wait (Redis/SQL). **Then** `get` is `null`, `has` false, `size` excludes it.
- AE5. Dimension lock
  - **Covers R13.** **Given** a store with `dimensions: 3`. **Then** `upsert` with a 4-vector throws `DimensionMismatchError` and issues no SQL (fake client records zero calls).
- AE6. Vector parity
  - **Covers R14.** **Given** the same 50 seeded vectors in memory and pgvector stores. **Then** top-5 ids match and scores agree within `1e-6`.
- AE7. Checkpoint race
  - **Covers R11.** **Given** two `CheckpointManager`s on a shared store saving sequence 3 and 2 of one run concurrently. **Then** latest is sequence 3 regardless of order; the stale writer gets `CHECKPOINT_CONFLICT`.
- AE8. Multipart cleanup
  - **Covers R17.** **Given** a streamed write whose part 2 request fails. **Then** the store issues `AbortMultipartUpload` and rejects with `StorageError`.
- AE9. Identifier injection
  - **Covers R6.** **Given** `table: 'docs; DROP TABLE x'`. **Then** construction throws `InvalidInputError`.

### Success Criteria

- `WorkflowRunner` and `CheckpointManager` run unchanged on Postgres, SQLite, and Redis document stores (e2e test per backend with env gating).
- Contract suites are the single definition of store behavior; adding a backend requires no new behavioral tests, only a factory.

### Scope Boundaries

**In scope**: `src/storage/**`, `src/agent/checkpoint.ts`, tests and CI service containers, README storage section.

**Deferred**

- LibSQL native vectors, Redis Stack vector search, sqlite-vec.
- DynamoDB / Mongo / Firestore adapters; GCS/Azure Blob native APIs (S3 compatibility endpoints work meanwhile).
- Schema migrations/versioned DDL beyond idempotent `ensureSchema()`.
- Connection pooling, retries, circuit breaking (owned by the injected client).
- Cross-store transactions; distributed locks beyond CAS.
- Redis cluster multi-key script safety (single-key scripts only; the collection index is best-effort and documented).

**Out of scope**: model-layer embeddings (done), changing interface shapes (additive-only here), trace storage backends (Area 7).

### Dependencies / Assumptions

- Interfaces stay stable; any new optional method is added as optional.
- CI can run service containers (`pgvector/pgvector`, `redis`, `minio`).
- Node ≥ 22.5 for `node:sqlite` in tests; the SQLite adapter itself targets the `SqlClient` shape, so it works with `better-sqlite3`/LibSQL shims on Node 20.

### Outstanding Questions

**Deferred to implementation**

- Whether `list` filters beyond top-level equality exist in `MemoryDocStore.matchesFilter` (contract tests decide the supported surface; unsupported operators throw uniformly).
- Whether `SqlClient` should expose a `transaction()` helper (not needed for single-statement CAS; skip until a caller needs it).

---

## Planning Contract (KTD)

| Topic | Decision |
| --- | --- |
| Layout | `src/storage/adapters/{sql,postgres,sqlite,pgvector,redis,s3}.ts`, barrel-exported from `src/storage/index.ts` |
| SQL client shape | `SqlClient { query<T>( sql: string, params: unknown[] ): Promise<{ rows: T[], rowCount: number }> }` |
| Redis client shape | `RedisClient { eval( script, keys, args ), get, set( key, val, { px }? ), del, sAdd, sRem, sMembers }`-style minimal surface with shims |
| Errors | `StorageError extends AIError` |
| Contract location | `tests/storage/contract/*.ts`, factories in `tests/storage/backends.ts` |

---

## Implementation Units

### U1. Contract suites and shared instrumentation

- **Goal:** Executable definition of store behavior; one instrumentation helper.
- **Requirements:** R1–R3, R9 (memory guard), R6a (`StorageError`)
- **Dependencies:** none
- **Files:** `tests/storage/contract/{document,vector,cache,file}.contract.ts` (new), `tests/storage/backends.ts` (new), `src/storage/instrument.ts` (new), `src/storage/errors.ts` (new), `src/storage/{document,vector,cache,file}.ts`, `tests/storage/memory-stores.test.ts`, `tests/storage/disk-store.test.ts`
- **Approach:** Port existing memory/disk assertions into the contract functions, add CAS race (AE1/AE2), TTL, filter, and JSON-guard cases; migrate memory stores to `instrument()`.
- **Test scenarios:** AE1–AE4 on Memory; spans/spend assertions remain in memory-specific tests.

### U2. SQL document and cache stores (Postgres, SQLite/LibSQL)

- **Goal:** Durable `IDocumentStore` and `ICacheStore` with atomic CAS.
- **Requirements:** R4–R10, R12, R12a
- **Dependencies:** U1
- **Files:** `src/storage/adapters/sql.ts` (client types, identifier validation, shims), `src/storage/adapters/postgres.ts`, `src/storage/adapters/sqlite.ts`, `src/storage/index.ts`, `tests/storage/sql-adapters.test.ts` (fake-client unit tests: SQL text, params, error mapping), `tests/storage/backends.ts` (env-gated factories)
- **Approach:** Dialect object (placeholder style, JSON ops, upsert syntax) shared by Postgres and SQLite classes; single-statement CAS; unique-violation → `written: false`; `ensureSchema` DDL per dialect.
- **Test scenarios:** Contract suites against Postgres (env) and `node:sqlite` (Node ≥ 22.5); AE9; fake-client tests assert no SQL is issued on invalid input and driver errors wrap into `StorageError`.

### U3. Redis cache and document store

- **Goal:** Redis-backed `ICacheStore` and `IDocumentStore`.
- **Requirements:** R4, R7, R8, R10 (Redis), R12
- **Dependencies:** U1
- **Files:** `src/storage/adapters/redis.ts`, `src/storage/index.ts`, `tests/storage/redis-adapters.test.ts`
- **Approach:** Lua scripts for CAS and for `set` (version increment + index add); `fromIoRedis` / `fromNodeRedis` shims; TTL via `PX`.
- **Test scenarios:** Contract (env-gated); fake client verifies script args/keys; AE1 under real Redis concurrency.

### U4. pgvector store

- **Goal:** `IVectorStore` on Postgres.
- **Requirements:** R13–R15
- **Dependencies:** U1, U2 (shared `SqlClient`)
- **Files:** `src/storage/adapters/pgvector.ts`, `src/storage/index.ts`, `tests/storage/pgvector.test.ts`
- **Approach:** Vector literal serialization (`'[1,2,3]'::vector`) via bind parameter; cosine operator; `topK` clamp; filter → `@>`; upsert via `ON CONFLICT (id) DO UPDATE`.
- **Test scenarios:** AE5, AE6 (env-gated); missing extension error message; HNSW index DDL snapshot; `count`/`clear`/`delete` per contract.

### U5. Checkpoint CAS

- **Goal:** `CheckpointManager` latest pointer is CAS-protected.
- **Requirements:** R11
- **Dependencies:** U1
- **Files:** `src/agent/checkpoint.ts`, `tests/agent/checkpoint.test.ts`, `tests/agent/resume.test.ts`, `tests/storage/checkpoint-race.test.ts` (new)
- **Approach:** `getWithMeta` → compare `(runId, sequence)` → `conditionalWrite`, retry up to 5 times on version change, then throw `CHECKPOINT_CONFLICT`. Different `runId` always advances (new run supersedes).
- **Test scenarios:** AE7 on memory and (env-gated) Postgres; legacy overload unaffected; existing agent resume tests green.

### U6. S3-compatible file store

- **Goal:** `IFileStore` over S3/R2/MinIO.
- **Requirements:** R16–R19
- **Dependencies:** U1
- **Files:** `src/storage/adapters/s3-sigv4.ts` (signing, unit-tested with AWS published vectors), `src/storage/adapters/s3.ts`, `src/storage/index.ts`, `tests/storage/s3-sigv4.test.ts`, `tests/storage/s3-file-store.test.ts`
- **Approach:** Signing uses `node:crypto` only; XML responses parsed with a minimal tag extractor for the few shapes needed (`UploadId`, `Error/Code`); multipart state machine with abort on failure; injected `fetch` for tests.
- **Test scenarios:** AE8; SigV4 canonical request vectors; path escape; `read` guard; 404 vs 403 distinct; contract suite against MinIO (env-gated).

### U7. CI service matrix and docs

- **Goal:** Integration suites actually run in CI.
- **Requirements:** R2
- **Dependencies:** U2–U6
- **Files:** `.github/workflows/storage-integration.yml` (new), `README.md` storage section
- **Approach:** Job with `pgvector/pgvector:pg16`, `redis:7`, `minio/minio` services and env vars; failure if the job runs but a suite is skipped (grep the vitest JSON reporter for `skipped` on required suites).
- **Test scenarios:** Workflow runs on `main` and PRs touching `src/storage/**`.

---

## Verification Matrix

| Requirement group | Primary tests |
| --- | --- |
| R1–R3, R6a, R9 | contract suites + `tests/storage/memory-stores.test.ts` |
| R4–R10, R12 | `tests/storage/sql-adapters.test.ts`, contract on Postgres/SQLite |
| R7, R8, R10 (Redis) | `tests/storage/redis-adapters.test.ts` |
| R11 | `tests/storage/checkpoint-race.test.ts` |
| R13–R15 | `tests/storage/pgvector.test.ts` |
| R16–R19 | `tests/storage/s3-*.test.ts` |

Run order: U1 → U2, U3, U5, U6 in parallel → U4 (needs U2) → U7. Ship U1 + U5 first (fixes a real race on existing code), then U2.

---

## How This Work Fits Together

- **Reliability pass (Area 1):** defined CAS (R23); this plan makes it real for durable stores.
- **Agent capabilities (Area 4):** parallel tools raise checkpoint write rates; U5 CAS guards that path.
- **Observability (Area 7):** instrumented stores keep emitting `storage.*` spans that the exporter maps to client spans; a trace-store backend can reuse `IDocumentStore`.
- **Release readiness (Area 8):** storage CI job and README claims verified there.
