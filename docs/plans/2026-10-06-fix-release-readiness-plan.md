---
title: Release Readiness - Plan
type: fix
date: 2026-10-06
topic: release-readiness
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Release Readiness - Plan

## Goal Capsule

- **Objective**: `@webergency-utils/ai@0.1.0` can be published to npm with claims that are true and gates that prove them: README matches the code, coverage is measured (not asserted by a static badge), the tarball installs and type-checks in a clean consumer project, CI covers the supported runtimes, and provider adapters are exercised against recorded real responses.
- **Product Authority**: Area 8 of 8 from the 2026-10-04 library assessment. This is the last plan to execute; it verifies the outcomes of Areas 4–7.
- **Open Blockers**: Owner decision needed on Node 20 (end-of-life as of April 2026; see Outstanding Questions). Recording live fixtures needs real provider keys held by the owner.
- **Execution profile**: Mostly CI, config, and docs. Fixture recording is a manual, key-gated script; CI only replays.

---

## Product Contract

### Summary

Fix packaging defects found in `npm pack`, add type-checking and lint for tests, add coverage with enforced thresholds, add a packed-tarball install smoke test, extend the CI runtime matrix (Node versions, OS, Bun smoke), build a record/replay harness plus opt-in live tests for provider adapters, correct stale README and policy claims, and harden the publish workflow.

### Problem Frame (what exists vs missing)

**Exists**:

- CI (`.github/workflows/ci.yml`): `ubuntu-latest`, Node 20 and 22, `npm ci` → lint → build → `vitest run`. Runs on pushes to `main` and `feat-*`, PRs to `main`.
- Other workflows: CodeQL, OpenSSF Scorecard, Jazzer.js fuzzing (`fuzz.yml`, triggers on `main, master`), ClusterFuzzLite PR job, Dependabot (npm + actions weekly; `typescript >= 5.8.0` ignored), `publish.yml` (on GitHub release published; Node 22, `npm install -g npm@latest`, `npm ci`, build, `npm publish --provenance --access public`).
- 58 test files / 370 tests, all offline with hand-written mock `Response` bodies (`tests/helpers/http.ts`).
- `package.json`: ESM-only `exports` for 9 subpaths, `files: ["dist/**/*"]`, optional peer SDKs. `npm pack --dry-run`: 271 files, 176 kB.

**Defects / gaps found**:

- **Static coverage badge**: README shows `coverage-100%25` as a hard-coded shields image; no coverage tool is installed (`@vitest/coverage-v8` absent), so the claim is unverifiable and almost certainly false.
- **Broken source maps**: `tsconfig` sets `sourceMap` and `declarationMap`, maps reference `../src/*.ts`, but `src` is not in `files`, so shipped maps point at missing files.
- **Tests are never type-checked**: `tsconfig.json` excludes `tests`; `vitest` transpiles without checking; `npm run lint` only globs `src/**/*.ts` although `eslint.config.js` includes `tests/**`.
- **Stale/inaccurate README**: `createModel(...)` documented as returning `ModelProtocol` (now an alias; `LanguageModel` is the contract); MCP described as "HTTP SSE" only; Streaming example omits terminal chunks/tool calls; `toToolDefinitions()` commented as "Bindable directly to Agent" (it is not, until Area 4 U5); no documentation of structured output, embeddings, reasoning content, prompt-cache controls, capability flags, or multimodal limits that already exist; "Node.js (20+) and Bun" is claimed but Bun is never run in CI; "dependencies: 1" badge is static.
- **SECURITY.md** lists `1.x` as supported while the package is `0.1.0`.
- **Package metadata gaps**: no `engines`, `keywords`, `homepage`, `bugs`, `sideEffects: false`, or `./package.json` export; no `CHANGELOG.md`; no CJS story (documented as ESM-only? currently silent).
- **No packed-artifact test**: nothing installs the tarball and imports every subpath or compiles a consumer against the `.d.ts` files; `exports` typos would ship.
- **No recorded real-provider data**: every provider test uses invented payloads, so wire-format drift (the reliability pass's main defect class) is not caught. No live tests exist, opt-in or otherwise.
- **Publish workflow** does not run lint/tests, does not verify that the release tag matches `package.json` version, and `npm@latest` is unpinned.
- `fuzz.yml` lists `master` (branch does not exist) and `scratch/` is an empty untracked directory in the workspace.

### Key Decisions

- **Measured coverage with thresholds, badge from CI output** (chosen over deleting the claim only): add `@vitest/coverage-v8`, enforce thresholds (starting lines/statements 85, branches 80, functions 85, adjustable upward only) and the static badge is removed (a live badge via an external service is optional later); CI prints the summary and uploads lcov. Governs R4–R6.
- **Ship `src` in the tarball** (chosen over disabling maps): `files: ["dist/**/*", "src/**/*", "README.md", "LICENSE"]`-style so maps resolve; size cost is small (< 400 kB unpacked). Alternative (drop maps) rejected because stack traces in consumers benefit. Governs R1.
- **Recorded fixtures + replay in CI, live tests opt-in** (chosen over live-in-CI: keys, flakiness, cost). A `recordingFetch` wrapper writes scrubbed request/response pairs to `tests/fixtures/recorded/<provider>/<case>.json`; tests replay through the injected `fetch`. A `npm run test:live` suite runs only when `AI_LIVE=1` and keys exist. Governs R12–R16.
- **Matrix covers Node LTS lines + OS + Bun smoke** (chosen over ubuntu-only): path handling (`LocalDiskFileStore`) and stream APIs differ across OSes; Bun runs a smoke subset, not the entire suite. Governs R8–R10.
- **Tarball smoke test is the release gate** (chosen over trusting `exports`): pack, install into a temp consumer, import every subpath at runtime and compile a TS file against the types. Governs R7.
- **README is verified, not just edited**: fenced `typescript` snippets that are marked runnable are compiled in CI against the built types. Governs R17–R19.
- **First publish is manual-dispatch with dry run first** (chosen over auto-publish on any release): `workflow_dispatch` input `dry_run` defaulting to true; tag/version equality enforced. Governs R20–R22.

### Requirements

**Packaging**

- R1. `npm pack` contents are intentional: `dist`, `src` (for maps), `README.md`, `LICENSE`, `SECURITY.md`; no tests, fixtures, `scratch`, fuzz harnesses. A script (`scripts/check-pack.mjs`) asserts the file list against an allowlist/denylist and fails on `.map` files referencing paths not in the tarball.
- R2. `package.json` gains `engines.node`, `keywords`, `homepage`, `bugs`, `sideEffects: false`, `"./package.json"` export, and explicit `"type": "module"` documentation (ESM-only) in README.
- R3. `publint` and `@arethetypeswrong/cli` (`attw --pack`) run in CI and pass for the declared module format (ESM; `node16`/`bundler` resolution), failing the build on any error-level finding.

**Quality gates**

- R4. `npm run typecheck` runs `tsc -p tsconfig.test.json --noEmit` covering `src` and `tests`; CI runs it. Existing type errors in tests are fixed, not suppressed with `@ts-ignore` (a lint rule bans new `@ts-ignore` without description).
- R5. `npm run lint` covers `src` and `tests`; lint failures in tests are fixed or rule-scoped with justification.
- R6. `npm run test:coverage` writes `coverage/` (lcov + json-summary + text), enforces thresholds in `vitest.config.ts`, excludes only `src/**/index.ts` barrels and type-only files; CI uploads the lcov as an artifact and prints the summary. The README coverage badge is replaced with a truthful value or removed.

**Packed-artifact smoke**

- R7. `scripts/smoke-pack.mjs` (run in CI and before publish): `npm pack` → install the tarball in a temp project → `node --input-type=module` imports `.`, `./core`, `./providers`, `./storage`, `./mcp`, `./spend`, `./agent`, `./workflow`, `./trace` and asserts at least one known export from each → `tsc --noEmit` on a consumer file using the main types with `moduleResolution: NodeNext` and `bundler`. Optional peer SDKs are absent in this project, proving the "no vendor SDK required" claim.

**CI runtime matrix**

- R8. `ci.yml` matrix: Node `[20, 22, 24]` on `ubuntu-latest`; Node 22 on `windows-latest` and `macos-latest` (tests + build, no lint duplication). The set is read from one place (`.nvmrc`-style env block) and matches `engines`.
- R9. A `bun` job installs Bun, runs `bun install --frozen-lockfile` equivalent smoke (or `npm ci` + `bun run` of the packed-artifact import script) and a subset: core, providers (replay), storage memory, mcp in-memory. If Bun support is not demonstrated, README stops claiming it (decision rule, not optional).
- R10. Workflows: `fuzz.yml` branches corrected to `main`; all `uses:` actions pinned to commit SHAs with version comments (Scorecard Pinned-Dependencies); Dependabot keeps them updated; top-level `permissions: contents: read` remains minimal per job.
- R11. The default suite must not contain unexpected skips: CI parses the vitest JSON report and fails if any test is skipped outside an explicit allowlist (env-gated integration suites from Area 6 are listed there).

**Recorded and live provider tests**

- R12. `tests/helpers/recording.ts` provides `recordingFetch( realFetch, { dir, name } )` and `replayFetch( { dir, name } )`. Recorded files store request method, URL (with API keys and `key=` query values redacted), headers allowlist (`content-type`, `anthropic-version`, `openai-beta`), body JSON, response status, headers allowlist, and body (streaming responses stored as the chunk list).
- R13. Scrubbing is mandatory and tested: any value matching known key patterns (`sk-`, `sk-ant-`, `AIza`, `Bearer ...`, `gsk_`) or any header outside the allowlist fails the recorder (throws) instead of writing the file. A repo test scans `tests/fixtures/recorded/**` for secret patterns and fails on a match.
- R14. Replay validates the outgoing request against the recorded one on method, URL path, and a canonical JSON body (key-order independent, ignoring volatile fields: `stream_options` ordering, request ids); mismatch throws `ReplayMismatchError` with a diff — drift in adapters surfaces as a test failure instead of silently passing.
- R15. A live suite `tests/live/*.live.test.ts`, excluded from `npm test` via config and run by `npm run test:live` only when `AI_LIVE=1`, covers per provider (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Ollama if reachable): plain generate, streaming, tool call round trip, structured output, embeddings where supported, one multimodal image case. Missing key for a provider **skips with a printed reason**, never passes silently as success under `AI_LIVE=1` when `AI_LIVE_REQUIRE=<provider>` is set.
- R16. `npm run record:fixtures` re-runs the live suite in record mode and writes fixtures; CI replays them in `tests/providers/recorded/*.test.ts` through each adapter's real `fetch` path. Fixtures carry `recordedAt` and model id; a CI warning (not failure) fires when fixtures are older than 180 days.

**Docs accuracy**

- R17. README is rewritten for the actual API: `LanguageModel` naming, `ModelCapabilities`, structured output, embeddings, reasoning content, prompt-cache controls, multimodal limits (per provider table generated from the capability flags in a script so it cannot drift), agent streaming/guardrails/parallel tools (Area 4), MCP transports/auth/resources (Area 5), storage adapters (Area 6), trace export (Area 7). Sections for features not yet merged are omitted, not stubbed.
- R18. `scripts/check-readme.mjs` extracts fenced ```typescript blocks tagged `<!-- check -->` and compiles them with `tsc --noEmit` against the built package (path-mapped to `dist`); CI runs it. Untagged blocks are illustrative only.
- R19. Badges: remove the static coverage and dependency-count claims or compute them in CI; "Node.js (20+) and Bun" text is derived from `engines` and R9 outcome. `SECURITY.md` supported-versions table lists `0.x` as supported. A `CHANGELOG.md` (Keep a Changelog) exists with a `0.1.0` entry.

**Publish workflow**

- R20. `publish.yml` runs on `release: published` and `workflow_dispatch` (`dry_run` default true). Steps in order: checkout (pinned), setup-node 22 with `registry-url`, `npm ci`, lint, typecheck, build, test with coverage, `smoke-pack`, `publint`/`attw`, version-vs-tag check, then `npm publish --provenance --access public` (with `--dry-run` when requested).
- R21. The workflow fails if `package.json` `version` does not equal the release tag (`v` prefix stripped) or if the tag points to a commit not on `main`.
- R22. `npm` is pinned to a major (`npm@11` or the version bundled with Node 22 verified for provenance support), not `latest`.

### Acceptance Examples

- AE1. Pack allowlist
  - **Covers R1.** **Given** a stray `tests/` or `.env` path entering `files`. **Then** `scripts/check-pack.mjs` exits non-zero naming the path.
- AE2. Broken export caught
  - **Covers R7.** **Given** a typo in the `./trace` export `types` path. **Then** the smoke test fails on the TypeScript consumer compile for that subpath.
- AE3. Tests type-check
  - **Covers R4.** **Given** a test calling a function with the wrong argument type. **Then** `npm run typecheck` fails; `vitest` alone would pass.
- AE4. Coverage gate
  - **Covers R6.** **Given** a change deleting tests so branches fall below the threshold. **Then** `npm run test:coverage` exits non-zero and the CI job fails.
- AE5. Windows path safety
  - **Covers R8.** **Given** the Windows job. **Then** `LocalDiskFileStore` traversal tests pass (`..\\`, drive-letter absolute paths rejected).
- AE6. Recorder refuses secrets
  - **Covers R13.** **Given** a response body containing `sk-live-...`. **Then** the recorder throws and no file is written.
- AE7. Replay drift
  - **Covers R14.** **Given** an adapter change that renames `max_tokens` to `max_completion_tokens` without re-recording. **Then** the replay test fails with a body diff showing the rename.
- AE8. Live suite gating
  - **Covers R15.** **Given** `AI_LIVE=1`, `AI_LIVE_REQUIRE=openai`, and no `OPENAI_API_KEY`. **Then** the suite fails; without `AI_LIVE_REQUIRE` it skips with a reason.
- AE9. README snippet drift
  - **Covers R18.** **Given** a tagged snippet using a renamed export. **Then** `check-readme` fails with the TypeScript error and the README line number.
- AE10. Publish guard
  - **Covers R20, R21.** **Given** tag `v0.2.0` and `package.json` `0.1.0`. **Then** the workflow fails before `npm publish`.

### Success Criteria

- A maintainer can run one command (`npm run release:check`: lint, typecheck, build, coverage, smoke-pack, publint, attw, readme check) and trust it equals CI.
- First `npm publish --dry-run` shows the intended file list and no warnings.
- Every provider adapter has at least generate and stream replay fixtures from real responses.

### Scope Boundaries

**In scope**: `package.json`, `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `scripts/`, `.github/workflows/*`, `tests/helpers/recording.ts`, `tests/live`, `tests/fixtures`, `README.md`, `SECURITY.md`, `CHANGELOG.md`.

**Deferred**

- Dual ESM/CJS build (ESM-only stays; documented).
- Automated semantic-release / changesets (manual versioning for 0.x).
- Windows/macOS fuzzing; Bun full-suite parity.
- Performance benchmarks and bundle-size budgets.
- Live tests in CI with repository secrets.
- API reference site generation (TypeDoc).

**Out of scope**: feature work from Areas 4–7; pricing data refresh policy (Area 1).

### Dependencies / Assumptions

- Areas 4–7 land first so README sections describe merged code (R17). Packaging, CI, coverage, and recording units (U1–U5) can ship earlier and independently.
- Owner supplies provider API keys locally for recording; none are stored in CI.
- npm provenance requires the existing `id-token: write` permission and an npm trusted publisher/token configured on the `npm` environment (already referenced by `publish.yml`).

### Outstanding Questions

**Deferred to implementation**

- **Node 20 support**: end-of-life since April 2026. Default in this plan keeps 20 in `engines` and the matrix until the owner decides; if dropped, change `engines` to `>=22`, matrix to `[22, 24]`, and README text in one commit.
- Whether coverage thresholds should start at the measured baseline (preferred: measure first, set thresholds ≈ 2 points below, then ratchet).
- Whether a Codecov-style external service is wanted later (not required).

---

## Planning Contract (KTD)

| Topic | Decision |
| --- | --- |
| Coverage provider | `@vitest/coverage-v8` matching the installed `vitest` major |
| Test type-check config | `tsconfig.test.json` extending `tsconfig.json`, `include: ["src", "tests"]`, `noEmit: true` |
| Pack checks | `scripts/check-pack.mjs` (uses `npm pack --json --dry-run`), `scripts/smoke-pack.mjs` |
| Fixtures | `tests/fixtures/recorded/<provider>/<case>.json`, one request/response (or chunk list) per file |
| Live gating env | `AI_LIVE=1`, `AI_LIVE_REQUIRE=a,b`, provider key env vars as in README |
| Action pinning | Full commit SHAs with `# vX.Y.Z` comments |
| Release check | `npm run release:check` composes the same scripts CI uses |

---

## Implementation Units

### U1. Packaging fixes and metadata

- **Goal:** Intentional, valid tarball.
- **Requirements:** R1–R3, R19 (SECURITY/CHANGELOG)
- **Dependencies:** none
- **Files:** `package.json`, `scripts/check-pack.mjs` (new), `SECURITY.md`, `CHANGELOG.md` (new), `.npmignore` not used (allowlist via `files`), `.github/workflows/ci.yml` (add steps)
- **Approach:** Add `src` to `files`; metadata fields; script parses `npm pack --json`; add `publint` and `@arethetypeswrong/cli` as devDependencies and scripts `lint:package`.
- **Test scenarios:** AE1; fixture-driven unit test for the checker's allow/deny logic (`tests/scripts/check-pack.test.ts`); `attw` passes for ESM.

### U2. Type-check and lint tests

- **Goal:** Tests are first-class code.
- **Requirements:** R4, R5
- **Dependencies:** none
- **Files:** `tsconfig.test.json` (new), `package.json` scripts, `eslint.config.js`, `.github/workflows/ci.yml`, whichever `tests/**` files fail
- **Approach:** Enable, fix failures in small commits, no blanket ignores; add `@typescript-eslint/ban-ts-comment` with `allow-with-description`.
- **Test scenarios:** AE3.

### U3. Coverage tooling and thresholds

- **Goal:** Measured coverage and honest badge.
- **Requirements:** R6, R19 (badge)
- **Dependencies:** U2
- **Files:** `package.json`, `vitest.config.ts`, `.github/workflows/ci.yml` (artifact + summary), `README.md` (badge)
- **Approach:** Run once to get baseline; set thresholds from it; exclude only barrels/types; add a text summary to `$GITHUB_STEP_SUMMARY`.
- **Test scenarios:** AE4 (verified manually by temporarily raising thresholds; recorded in PR description).

### U4. Packed-artifact smoke test

- **Goal:** Prove the published shape works for consumers.
- **Requirements:** R7
- **Dependencies:** U1
- **Files:** `scripts/smoke-pack.mjs` (new), `scripts/fixtures/consumer.ts` (new), `.github/workflows/ci.yml`, `package.json` (`smoke:pack`)
- **Approach:** Temp dir via `fs.mkdtemp`; `npm pack --pack-destination`; `npm install --no-audit --no-fund <tgz>`; run import script and `tsc` with both resolution modes; assert exit codes.
- **Test scenarios:** AE2; absence of optional peers does not break imports.

### U5. CI runtime matrix, Bun smoke, workflow hardening

- **Goal:** Supported runtimes are tested, workflows are pinned.
- **Requirements:** R8–R11
- **Dependencies:** U1–U4 (jobs reuse the scripts)
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/fuzz.yml`, `.github/workflows/codeql.yml`, `.github/workflows/scorecard.yml`, `.github/dependabot.yml`
- **Approach:** Matrix as in R8 with `fail-fast: false`; Bun job gated by `oven-sh/setup-bun` (pinned); replace tags with SHAs; add a "required suites not skipped" check.
- **Test scenarios:** AE5 (Windows job); workflow lint via `actionlint` job.

### U6. Recording harness and provider replay tests

- **Goal:** Real wire formats lock adapter behavior in CI.
- **Requirements:** R12–R14, R16
- **Dependencies:** U2
- **Files:** `tests/helpers/recording.ts` (new), `tests/helpers/recording.test.ts` (new), `tests/fixtures/recorded/**` (generated), `tests/providers/recorded/*.test.ts` (new), `scripts/record-fixtures.mjs` (new), `package.json`
- **Approach:** Wrapper around `fetch` with allowlisted headers and secret scanning; replay matcher with canonical JSON compare; streaming bodies stored as chunk arrays and replayed as `ReadableStream`; fixtures reviewed in PR like code.
- **Test scenarios:** AE6, AE7; replay consumed in order and "unused fixture" assertion; repo-wide secret scan test.

### U7. Live provider suite

- **Goal:** Opt-in end-to-end checks used to produce fixtures.
- **Requirements:** R15, R16
- **Dependencies:** U6
- **Files:** `tests/live/*.live.test.ts` (new), `vitest.live.config.ts` (new), `package.json` (`test:live`, `record:fixtures`), `README.md` (contributing note)
- **Approach:** Shared case table per capability; cases check shape and invariants (non-empty content, usage present, valid tool JSON), not exact text; small token budgets and cheapest models; cost note in docs.
- **Test scenarios:** AE8; running with no keys produces a readable skip table.

### U8. README rewrite and doc verification

- **Goal:** README is accurate and mechanically checked.
- **Requirements:** R17–R19
- **Dependencies:** Areas 4–7 merged; U4 (built types)
- **Files:** `README.md`, `scripts/check-readme.mjs` (new), `scripts/gen-capability-table.mjs` (new), `.github/workflows/ci.yml`
- **Approach:** Generate the provider capability table from the registry's real flags into a marked README block; tag runnable snippets; remove claims that cannot be verified; keep sections short with links to subpath exports.
- **Test scenarios:** AE9; generated block up-to-date check (script diff fails CI).

### U9. Publish workflow and first-release runbook

- **Goal:** Safe, repeatable first publish.
- **Requirements:** R20–R22
- **Dependencies:** U1–U5
- **Files:** `.github/workflows/publish.yml`, `package.json` (`release:check`), `CHANGELOG.md`
- **Approach:** Add gates and tag/version verification; `workflow_dispatch` dry-run default; first release executed as dry run, inspect log, then a published release.
- **Test scenarios:** AE10; dry-run execution recorded in the PR; manual checklist: npm org/package ownership, `npm` environment protection rule, provenance badge visible after publish.

---

## Verification Matrix

| Requirement group | Primary checks |
| --- | --- |
| R1–R3 | `scripts/check-pack.mjs`, `publint`, `attw` |
| R4–R5 | `npm run typecheck`, `npm run lint` |
| R6 | `npm run test:coverage` |
| R7 | `scripts/smoke-pack.mjs` |
| R8–R11 | CI matrix, `actionlint`, skipped-suite check |
| R12–R14, R16 | `tests/helpers/recording.test.ts`, `tests/providers/recorded/*` |
| R15 | `npm run test:live` (manual, owner keys) |
| R17–R19 | `scripts/check-readme.mjs`, generated-table diff |
| R20–R22 | publish dry-run + guard logic test |

Run order: U1 → U2 → (U3, U4, U6) → U5 → U7 → (wait for Areas 4–7) U8 → U9. U1–U5 can start immediately and do not depend on other plans.

---

## How This Work Fits Together

- **Model-layer parity (Area 2):** recorded fixtures (U6) are the first real-wire check of its structured output, reasoning, and tool-call parsing.
- **Agent, MCP, storage, observability (Areas 4–7):** each adds tests that this plan's gates (typecheck, coverage, tarball smoke) enforce; README (U8) documents what actually merged.
- **Reliability pass (Area 1):** the replay harness guards the stream-terminator and retry behavior against regressions on real payloads.
