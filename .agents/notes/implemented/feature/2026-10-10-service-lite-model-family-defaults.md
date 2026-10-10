# Agent Note: Model defaults come from the model's family

Status: implemented

English | [中文](2026-10-10-service-lite-model-family-defaults.zh.md)

## Problem

A hand-written model entry had to restate everything it did not declare, and `dsh-llm-service-lite`'s answer for the rest was the most conservative one available (2026-10-10).

A deployment writing `models: [{ id: deepseek-v4-flash }]` got a text-only model with no thinking switch and no effort ladder, even though the vendor's own documentation says that id takes images, spells its switch as `thinking: { type }`, publishes `low`/`high`/`max`, and applies `high` when the request names nothing. Worse, three of those facts are not preferences a user would guess: whether prior reasoning must travel back (DeepSeek V4 and MiMo reject a follow-up that omits it with a 400, Kimi K3 and K2.7 always keep it, glm-5.3 cannot disable thinking at all), which level the vendor applies by default, and which models accept images at all. A user could only discover them by reading eight vendor platforms and then transcribing the answers by hand.

The Anthropic transport had a related gap. Its protocol requires `max_tokens` on every request, so the adapter filled it from the model's own `maxTokens` — a capacity, not a decision about what this request should ask for. The result was that a route's declared capacity silently became every request's output cap, and a model whose capacity no one declared got the route-level fallback.

## Decision

**A reviewed family table fills what a profile leaves open.** `src/model-defaults.ts` holds one rule per family — match patterns, then the facts that family's own platform documents: accepted modalities, `thinkingStyle`, the effort ladder, the level the vendor applies by default, whether the reasoning returns and whether it travels back, and the Anthropic output cap. Rules are matched top-down against the lowercased model id, so a specific rule must precede its family's general one.

**Four rules govern every entry, and the file states them as its contract.** A profile always wins: the table fills gaps and never overrules, so an existing route keeps exactly what it declared. Nothing is invented: each entry records the vendor documentation it was read from, and a family whose wire spelling is unconfirmed carries no entry rather than a guess. Only the model owner's own deployment counts: what a reseller, gateway, or aggregator requires of the same model id is never a source — which is why the hosted copies of DeepSeek, GLM, Kimi, and MiniMax inside other vendors' catalogs were read but never cited. Sampling is never defaulted: `temperature`, `top_p`, and `top_k` stay unset, because vendors disagree about their reachable ranges under thinking and the endpoint's own default beats an invented value.

**Reasoning replay is a declaration with a mandatory floor.** `capabilities.replayReasoning` says whether prior reasoning is sent back. Absent defers to the model's family; `true` turns it on where the family declines it; `false` is refused by name on a family whose follow-up turns are rejected without it — the same treatment a declaration the transport cannot honour already gets, because an endpoint that answers 400 is not a preference. A profile that only says `reasoningContent: true` keeps replaying, which is the reading profiles written before the switch already relied on.

**The default effort level reaches the seam.** `LlmModelReasoningInfo.defaultEffort` already meant "the level to materialize when callers name none"; the family table now feeds it, so a caller that picked nothing gets the level the vendor's own platform applies (`xhigh` for qwen3.8-max, `max` for glm-5.3 and Kimi K3, `medium` for GPT-5 and Claude Opus 5.5, `high` for DeepSeek V4 and Hunyuan) instead of an undocumented endpoint default.

**A model's `maxTokens` is a capacity again.** The OpenAI-compatible wires send no cap the caller did not ask for, and the Messages wire — which requires the field — takes the caller's value, then `extraBody.max_tokens`, then `defaults.maxTokens`, then the model's family cap, then 64K for a model no family speaks for. The two behaviour changes are recorded as an upgrade note rather than absorbed silently.

**The capability editor groups thinking and asks the replay question honestly.** The editor's thinking controls now sit in one "Thinking format" block, one question per row, and the remaining declarations share one line instead of four single-checkbox fieldsets. Replay is a three-state answer — the family decides, send it back, do not — because a cleared box means neither of the other two.

## Alternatives considered

**Generate the table from the installed official catalog at runtime.** Rejected: a bare profile would then depend on another package's data, and the catalog's entries for a model are the *hosting* provider's — exactly the source the third rule excludes. The table is read by a human once and cited thereafter.

**Put the defaults in the profile schema so each deployment states them.** Rejected as the primary mechanism: it is the transcription work this change removes, and eleven vendors' worth of defaults would be restated per deployment. The profile keeps the last word, which is what actually needs to be configurable.

**Make replay a plain boolean with `false` as the default.** Rejected: it would have to lie for the families whose endpoint rejects a follow-up without the reasoning, and the refusal is the only honest place to say so.

**Send the family's default effort on every request, including ones where the caller named a level.** Rejected: a caller's own level is the more specific instruction, and the vendor default only exists to fill the silence.

**Give the table its own spoken format (YAML or JSON data file).** Rejected for now: the lite package ships a bundled `lib/index.js` with no asset pipeline, so a separate data file would need packaging and runtime path work for no reading benefit; the module is a flat table with a per-rule provenance line, and it is type-checked.

**Keep a family whose only source was the official catalog.** Partially rejected: the ant-ling (`Ring-*`) family was dropped for lack of its own platform documentation, and LongCat was restored once its own API docs were read. The catalog-only entries that remain are labelled as such in their provenance line.

## Consequences

A bare `models: [{ id: … }]` route is now usually enough: image input, thinking format, effort ladder with the vendor's default level, and replay behaviour arrive from the table, and a model the table does not know behaves exactly as it did before.

Three externally visible changes follow. A model's `maxTokens` no longer becomes a request cap on the OpenAI wires. The Messages wire takes its cap from the configured default, the family, then 64K. Turning off the reasoning replay where the family requires it is now refused by name. All three are in the upgrade guide.

The table is data, not logic: adding a model family means one rule with its provenance, and the test file pins the family each representative id resolves to, so a rule inserted in the wrong order fails rather than silently shadowing another.

Deferred: a per-thinking-level default table (`samplingParamsByThinkingLevel`-style), a settings-page surface for editing the table's values, and the effort ladder for families whose platform documents a level set without publishing a default.

## Testing

`tests/model-defaults.spec.ts` pins the table itself — 46 representative model ids resolving to their families, case-insensitive matching, the Anthropic cap for matched and unmatched ids, and the invariants that every rule is sourced, matchable, free of sampling fields, and that a default level is one the family publishes. `tests/model-defaults-wiring.spec.ts` proves what resolution and the wires do with it: a bare profile filled, a profile overruling field by field, a mandatory replay refusing to be turned off, an id the route never enumerated getting the same facts, the family default effort written where the caller named none, no `max_tokens` on an open chat request, and the Messages cap chain including the 64K fallback. The existing adapter, wire, and client suites were updated where their fixtures encoded the old cap behaviour, and `packages/client/ui-settings-models/tests/owc-profiles.client.spec.tsx` covers the new editor group and both explicit replay answers.

Verified locally: 713 tests across the adapter and the settings client, `tsc` for both the host and client projects, `oxlint` clean, `test:docs` 21/21 gates, and `verify-config-catalog` up to date for the new declaration.

## Related

- [The local LLM service converts official catalogs, carries image output, and states per-model defaults](2026-10-10-service-lite-official-catalogs-and-image-output.md) — the per-model `defaults` this change corrected the `maxTokens` fallback of.
