# Agent Note: The local LLM service declares what the first-party channel declares

Status: implemented

English | [中文](2026-10-09-service-lite-declared-parity.zh.md)

## Problem

The note that placed this plugin in the base bundle said the first-party channel stays first-party and this adapter serves endpoints a deployment describes itself. That was true of the request path it owned, and it was not true of the seam metadata the harness reads. The first-party DeepSeek catalog declares two capabilities this adapter's vocabulary had no words for — `systemPromptUpdate: 'in-history'` and `toolUpdate: 'addition-only' | 'in-history'` — so a deployment that reached DeepSeek or a compatible gateway through a profile got a different shape of conversation than the same model on the first-party channel: `projectToolUpdates` had no declared mode to read, every turn restated the complete prompt and the complete tool list, and a mid-conversation system snapshot or a deferred tool had nowhere to go.

The same gap had a second cost. `LlmAdapter.imageRequestPricing` was unimplemented, so the token meter fell back to its structural heuristic for every image: a session surface holding one photo was priced as the JSON of the reference that stands for it — a few dozen tokens — while the endpoint charges hundreds to thousands of visual tokens. Context pressure under-reported for exactly the sessions that fill a window fastest, and the difference was invisible until a turn failed on an over-long request.

## Decision

Three declarations, each honoured by the code that reads it, and each refused where it cannot be read.

**`systemPromptUpdate: 'in-history'` and `toolUpdate: 'addition-only' | 'in-history'`** join the model capability vocabulary with the harness's own spellings, and are carried onto `LlmResolvedModelInfo` only when a profile declares them. Declaring `toolUpdate` is what makes the loop hand this route `tool-addition` and `tool-removal` blocks instead of restating the declaration list; the declarations of deferred tools then carry `defer_loading`, which the Messages transport sends as this protocol spells it. Both declarations are refused on `openai-chat-completions` and `openai-responses`: those wires restate prompt and tools on every request and have no mid-history part to read, so accepting the declaration would put a capability in the document that no request acts on — the same rule `promptCaching` and `includeUsage` already follow.

**The Messages transport now has the wire form for those changes.** A developer or system message on a route that declared either capability becomes a `system`-role history message carrying the prompt snapshot and the tool references, instead of folding into a user turn. It is held back until the turn it follows is a user turn and placed between that turn and the assistant answer, because this protocol reads a `system` message as an instruction between turns; a change that would land earlier fails the request with `UNSUPPORTED_CONTENT` naming the reason rather than being moved or dropped. A route that declared neither keeps the folding rule it had, and still skips unknown blocks on other roles.

**`imageTokens` declares the endpoint's own visual-token accounting**, in the two published spellings: `{ kind: 'area', per: 750 }` for a flat pixel grid, and `{ kind: 'tiles', tile, base, perTile }` for a base price plus a price per square tile. `LlmAdapter.imageRequestPricing` prices each surface occurrence at the dimensions `requestImageTarget` will ask the attachment provider for — the one number that decides the endpoint's charge — prices an offloaded occurrence as the placeholder the request carries, and prices a text-only route as the substitution the runtime performs. A route that declares no accounting answers `undefined`, which leaves the meter's own labelled heuristic in place: a price this adapter guessed would read as a measurement.

**The names that channel owns are refused here.** DeepSeek keeps its official modules, so `deepseek-official` and `deepseek-account` — registered by `@deepseek-ai/dsh-llm-deepseek-api-key` and `@deepseek-ai/dsh-llm-deepseek-account` — are refused by name where a profile claims one, with the owner in the diagnostic. A stored profile that claims one keeps its route addressable and unserviceable rather than taking the other routes down, and registering it for real would have failed plugin loading anyway: the point is to name the mistake where it is written instead of letting it read as a bug in this plugin. Only the names are reserved, not the provider — a deployment that reaches a DeepSeek-compatible endpoint through this adapter names its own route and declares that endpoint's own capabilities.

Three things are deliberately **not** copied from the first-party channel, and the README names each: the DeepSeek beta header for mid-conversation tool changes is not injected (a profile that needs one states it in `headers`, because the header is the endpoint's contract, not this adapter's knowledge), no handle text is written beside an image's bytes (the priced occurrence therefore counts exactly what the endpoint charges), and the DeepSeek-platform features — the Files API image channel, the account-grant route, the `ctx.deepseekLlmApiExtensions` request-field registry, the `x-deepseek-harness-*` identity headers — stay out of a plugin whose whole premise is that a profile is the truth.

## Alternatives considered

**Keep restating the prompt and the tool list.** Rejected: it is the behaviour this change exists to remove. A long session on a declared-capable endpoint pays a cache miss on every turn for a list that did not change, and the harness already knows how to express the change.

**Inject the mid-conversation tool-change beta automatically.** Rejected: the beta name is the endpoint's, and this adapter speaks to arbitrary endpoints. Writing one provider's private header into every request would be first-party knowledge in a third-party path, and a deployment that needs it can name it.

**Guess an image accounting when a profile declares none.** Rejected: the number would be indistinguishable from a measured one downstream. An undeclared accounting keeps a heuristic the meter itself labels as heuristic.

**Carry the DeepSeek-platform features so the plugin can stand in for the first-party channel entirely.** Rejected: session-log upload, the account-grant route, and request-field extensions are DeepSeek-platform contracts, not LLM-seam capabilities. Implementing them would not make this adapter more portable; it would make it a second copy of the first-party stack with a different name.

## Consequences

A profile that declares `toolUpdate` now receives developer messages and deferred declarations, so mid-conversation changes travel as changes instead of rewritten prefixes, and the same is true for a mid-conversation system snapshot on a route that declared `systemPromptUpdate`. A deployment that declares neither sees byte-identical requests to before.

`imageTokens` makes context pressure and image pricing visible for the routes that declare it; the harness's own usage report remains the authority once a call completes, so the declaration affects estimates only.

The cost is a second wire form in the Messages transport and two more refusable declarations, and the risk that a profile declares a mid-history capability against an endpoint that does not read one. That failure is loud — the endpoint rejects the `system` message or the beta is missing — and it is a configuration error the diagnostic names, which is why the declarations are opt-in per model rather than assumed from the protocol.

Verified for this change: 230 in-package tests, per-file coverage with no new gaps against the pre-change baseline (`anthropic-messages.ts`, `config.ts`, `images.ts` at 100%, `profiles.ts` unchanged at its pre-existing 14 uncovered locations), `tsc -b tsconfig.host.json`, oxlint, doc-quick, and the golden replay suites.
