# Agent Note: The local LLM service converts official catalogs, carries image output, and states per-model defaults

Status: implemented

English | [中文](2026-10-10-service-lite-official-catalogs-and-image-output.zh.md)

## Problem

`dsh-llm-service-lite` exists to adapt endpoints no installed catalog describes, and it held four gaps a deployment with real providers hits immediately (2026-10-10).

First, an official deployment already publishes one model-configuration file per provider — an API-keyed map of `chat:<id>` entries with the endpoint, capacities, input modalities, and thinking levels. Nothing could read it: adopting an official file meant retyping every model into this adapter's own vocabulary, which is exactly the transcription work the file format exists to avoid.

Second, `imageOutput` and `video` were declared capabilities that resolution refused. The refusal was honest while no transport carried them, but this adapter's own rule — a declaration nothing acts on would read as a capability the route does not have — cuts the other way once a wire can carry the picture: an endpoint that returns images could not say so, and a route that declared nothing could receive one and lose it.

Third, a model's sampling settings had nowhere to live. `extraBody` is provider-level and reserved-key-checked, so two models on one gateway that want different temperatures could not both be described, and a profile could not state what its endpoint wants when the caller says nothing.

Fourth, the text around those capabilities had drifted from the code: the Models page told users this adapter carries text only while it carried images, the README counted two transports while three were served, one documented default named a value the adapter never used, and four documented image-budget fields were absent from the schema that accepts them.

## Decision

**Official files convert into this adapter's own profile.** A profile may carry `catalog` — a path or the parsed content — and `src/official-catalog.ts` converts it: the API becomes `interfaceType` (`openai-completions` to `openai-chat-completions`, `openai-responses`, `anthropic-messages`), `baseUrl` becomes `baseURL`, a header set every model shares becomes the route's headers, and each `chat:` entry becomes a model with its capacities, input modalities, and thinking levels. `samplingParams` become the model's `defaults`. `interfaceType` therefore became optional: the catalog may supply it, and a profile that names neither is refused by name. The profile's own fields win over the conversion, and an absent or empty `models` list keeps the catalog's models — the official rule, where a list replaces the catalog only when it names one. A file that mixes protocols or endpoints, names no chat model, or cannot be read leaves the route with a diagnostic instead of a half-converted route, and every field the conversion cannot carry (`cost`, `compat` flags, `inputLimits`, per-model headers) is reported once per loss with the number of models carrying it, through `ctx.logger.warn`, rather than guessed at.

**Image output is carried; video is carried as a file.** A model that declares `imageOutput` may answer with images: the chat-completions translator reads the inline image parts an endpoint returns (on the delta or on a whole message), the Responses translator reads an `image-generation` item's base64 result, and the adapter — the one place that knows the route — commits the bytes through the attachment provider and republishes a durable `block-end` image block, so the session stores a reference rather than base64. The bytes decide their own media type (`src/image-output.ts` sniffs PNG/JPEG/WebP/GIF) because the attachment provider validates the payload against the type it is saved as. An image from a model that never declared the capability fails by name, and so does one from a deployment with no attachment provider; the declaration itself is refused on `anthropic-messages`, whose assistant turn has no image part. `video` is accepted and carried as a file: a video occurrence reaches the model as the same handle text any file contributes, and `capabilities.imageOutput` is what makes the seam's `outputModalities` say `['text', 'image']` instead of `['text']`.

**Request parameters belong to the model.** A model entry's `defaults` state `temperature`, `topP`, `topK`, and `maxTokens`, each written only where the caller's own request left it unstated — so a default can never override an explicit choice. `topK` is refused on `openai-responses`, which has no top-k field, and `defaults.maxTokens` is what the harness hands a caller that stated no cap, falling back to the model's own `maxTokens`.

**The seam names output modalities.** `LlmModelInfo.outputModalities` joins `inputModalities`, and this adapter always publishes it (`['text']`, or `['text', 'image']` where image output is declared) rather than leaving it unknown, so a route states what its answers may carry.

**The copy follows the code.** The Models page's modality note now says how a declared video input travels instead of claiming text-only, a declared image output gets its own note, the placeholder capacities a blank model field shows are the family's own defaults, and the README, the module docs, and two untranslated or mis-worded strings were corrected.

## Alternatives considered

**Read the installed pi-ai catalog by provider id, as `dsh-llm-pi-ai` does.** Rejected: that adapter's whole reason to exist is that no installed catalog sits in its request path, and a dependency on one would import the module graph this package avoids; the conversion reads the same file format without the package.

**Carry a native video part now.** Rejected for this change: the harness has no video content block, so a native part means a `ContentBlockMap` change, a persistence acknowledgement across a dozen roots, attachment-side video media, and a wire part that only some gateways accept. The declaration is accepted today with the honest meaning — video arrives as a file — and the native part is its own change.

**Give image output its own content block.** Rejected: the harness already admits an `image` block from a stream (`block-end` carries any block, and the session, the attachment discovery, and the client all handle image references on assistant messages), so a second block type would add a persistence change for nothing.

**Put per-model parameters in the seam's call configuration instead.** Rejected: `LlmCallConfig` is a cross-package surface shared by every adapter, and the requirement is one endpoint's own settings; a model-level field keeps the change inside the adapter and inside the profile that describes the endpoint.

**Refuse a catalog conversion with any unmappable field.** Rejected: an official file is mostly fields this adapter does not model (`cost`, per-api compat flags), so refusing would make conversion useless; reporting each loss once keeps the route serving while stating exactly what was left behind.

## Consequences

An official provider file becomes a usable route in three lines of profile, and its unmappable fields are visible in the log rather than silently absent. A route that declares image output can serve a picture-generating model end to end; a route that does not will fail loudly if one appears. Model-level defaults make one gateway's two models describable. `interfaceType` being optional is a relaxation, not a break: a profile that used to fail at the schema for omitting it now fails at resolution naming both remedies.

`video` and `imageOutput` declarations that were previously refused now resolve — a stored profile that declared one and carried a diagnostic becomes serviceable, which is the one externally visible semantic change this change carries (recorded as an upgrade note).

Deferred: a native video part (the seam's video content block), per-thinking-level default parameters (`samplingParamsByThinkingLevel` converts to a diagnostic today), and an editing surface for `defaults` in the Models page — the field is schema-visible and configurable in `cordis.patch.yml` today, and the page's model rows do not yet offer it.

## Testing

`tests/official-catalog.spec.ts` covers the conversion table, every refusal, and the counted diagnostics; `tests/profiles.spec.ts` covers the profile-level `catalog` field (inline, by path, overridden, unreadable) and the accepted `video`/`imageOutput` declarations; `tests/models.spec`-reachable assertions live in `tests/adapter.spec.ts`, which drives image output end to end through a mock endpoint and asserts both refusal paths; `tests/image-output.spec.ts` covers the byte sniffing and inline-URL decoding; `tests/chat-completions.spec.ts` and `tests/responses-stream.spec.ts` cover the two wire translations, including the terminal-event repetition guard.

## Related

- [The local LLM service speaks the Anthropic Messages protocol](../bug-fix/2026-10-08-service-lite-anthropic-messages.md) — the transport this adapter's third protocol arrived with.
