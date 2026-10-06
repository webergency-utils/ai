# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions before 1.0.0 may include breaking changes in minor releases.

## [Unreleased]

## [0.1.0] - Unreleased

First public release.

### Added

- Provider-agnostic `LanguageModel` contract with adapters for OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek and Ollama, built on `fetch` (vendor SDKs are optional peers).
- Structured output, tool calls, reasoning content, multimodal input, prompt-cache controls and capability flags.
- Embedding models and vector stores.
- Agent runtime with streaming, guardrails and parallel tool execution; workflow engine.
- MCP client with HTTP transports, auth and resources.
- Storage adapters (memory, local disk, S3, Redis, Postgres/pgvector).
- Spend calculation with a unit registry and metered models.
- Tracing with opt-in content capture, redaction, W3C `traceparent` propagation and OTLP/HTTP export.

### Notes

- ESM-only. Requires Node.js `>=20.3.0`.
- Release gates: tarball allowlist, packed-artifact smoke test, `publint`, `@arethetypeswrong/cli`, measured coverage thresholds.

[Unreleased]: https://github.com/webergency-utils/ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/webergency-utils/ai/releases/tag/v0.1.0
