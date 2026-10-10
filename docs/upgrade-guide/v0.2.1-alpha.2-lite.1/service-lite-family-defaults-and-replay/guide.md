---
kind: upgrade-guide
description: "llm-service-lite resolves a model's family defaults — modalities, thinking format, effort ladder and default, and whether reasoning is replayed — and sizes the Anthropic output cap from the configured default, the family, then 64K instead of a model's own maxTokens."
---

# Model defaults come from the model's family

English | [中文](guide.zh.md)

## Change

In this release, `@deepseek-ai/dsh-llm-service-lite` fills what a hand-written model entry leaves open from a reviewed table of what the mainstream model families document (`packages/llm/llm-service-lite/src/model-defaults.ts`).

A profile still wins: the table only fills what the profile did not state, so an existing route that declares modalities, a thinking style, or an effort ladder keeps exactly what it declared. A model no family speaks for keeps the adapter's previous conservative answer. For example, a bare `models: [{ id: deepseek-v4-flash }]` now resolves with image input, the `thinking` switch, the effort ladder `low`/`high`/`max` with its vendor's default level `high`, and replay on; `claude-opus-5-5` resolves with the default effort `medium` its own documentation names.

Two declarations change behaviour:

- `capabilities.replayReasoning` is new. It decides whether prior reasoning travels back with the next request; absent defers to the model's family, and a family whose follow-up turns are rejected without its reasoning (DeepSeek V4, Kimi K3 and K2.7, glm-5.3, qwen3.8-max, MiniMax M2.x, MiMo) resolves to mandatory replay and refuses `replayReasoning: false` by name. A profile that already declared `reasoningContent: true` keeps replaying, as it did.
- A model's `maxTokens` is now a capacity rather than a request default. The two OpenAI-compatible wires no longer receive a `max_tokens` the caller did not ask for, and the Messages wire — which requires the field — takes the caller's own value, then `extraBody.max_tokens`, then `defaults.maxTokens`, then the model's family cap, then 64K for a model no family speaks for.

The audience is any deployment whose llm-service-lite route relied on `maxTokens` to size requests, or that wants the researched family defaults.

## Migration

1. A route that expects a specific output cap should state it as `defaults.maxTokens` on the model entry. `maxTokens` still describes what the model can answer, and is no longer written into requests on its own.
2. An `interfaceType: anthropic-messages` route whose model states no `defaults.maxTokens` now sends the family cap (128K for Claude 5 and Opus 4.6–4.8, 64K for Opus 4.5 / Sonnet 4.5 / Haiku 4.5, and so on) or 64K for a model the table does not know. Set `defaults.maxTokens` where a smaller cap is intended.
3. A route that wants to stop replaying prior reasoning on a family that only declares it may set `capabilities.replayReasoning: false`. On a family that requires it the write is refused with a message naming the family; leave it undeclared there.
4. Nothing else needs rewriting: undefined family-derived fields keep the adapter's previous behaviour, and sampling parameters are never defaulted by the table.
