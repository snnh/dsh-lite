# Agent Note: The local LLM service speaks the OpenAI Responses API

Status: implemented

English | [中文](2026-10-09-service-lite-responses-transport.zh.md)

## Problem

The previous note left `openai-responses` refused by name: the plugin could say what a deployment had configured, and could not serve it. That was the honest interim state — sending a chat-completions body to a `/responses` endpoint is worse than a named refusal — but it is not a fix, and the feature it blocks is the one OpenAI and several gateways now expose: a flat item list instead of a conversation of roles, `function_call`/`function_call_output` pairs instead of `tool_calls`, reasoning items that must precede the message they belong to, `instructions` instead of a system role, and per-item identities (`msg_`/`rs_`/`fc_`) a stateless request is expected to hand back.

OpenWebCode — whose provider layer this plugin ports — already had this transport, and it records two failure modes a naive port reproduces. First, an input list that pairs a call with the wrong number of outputs is rejected; their mapping keeps one output per call and drops the rest. Second, a `function_call` with no output is rejected outright, and a fabricated one is rejected by strict gateways — which is why their Responses path drops an unanswered call instead of answering it with a placeholder, the opposite of what the Messages path must do.

## Decision

The plugin serves `openai-responses` with its own transport, ported from OpenWebCode's and adapted to this adapter's declaration rule.

**Request assembly and input mapping** (`src/openai-responses.ts`). The prompt becomes `instructions` (the request's own, else a leading system message); a later system or developer message folds into a user item where it stands. Tools are sent in this protocol's flat `{ type: 'function', name, description, parameters }` shape. `max_output_tokens` is always sent and raised to the API's floor of 16. Reasoning is spelled as `reasoning.effort` with `summary: 'auto'` **only when the caller selected an effort** — this protocol has no switch for turning thinking on, so a mode-only selection sends nothing and the endpoint's own default applies — while disabling thinking is expressible through `effort: 'none'` for a model whose profile declares a spellable switch. Sampling is sent only without a reasoning effort, because this API rejects temperature beside reasoning. `include: ['reasoning.encrypted_content']` is requested exactly when the model declares `responsesEncryptedReplay` and reasoning was requested.

**The repair.** The item list is corrected on the way out, as the other transports correct theirs: the first result per call id wins, an orphan result is dropped, a call id declared twice collapses to its first occurrence, and a turn's parallel calls are grouped — every `function_call`, then every `function_call_output` — because the API folds consecutive items into the assistant turn they belong to and interleaved pairs would split one batch into several turns. One rule differs and is deliberate: a call nothing answered is **dropped**, not answered with a placeholder, because this API validates that a call has an output and strict gateways reject a fabricated one. The result's media cannot live in a `function_call_output`, so it follows the batch as one synthesized user item.

**Reasoning replay.** Two forms, each gated on a declaration: `reasoningContent` replays the thinking text as `reasoning_text` parts (no metadata needed — this protocol accepts plain text), and `responsesEncryptedReplay` replays the provider's own reasoning item verbatim, id and encrypted payload included. Item identities (`msg_`/`rs_`/`fc_`) ride the same adapter-private envelope and are handed back with the item they belong to. An envelope this build cannot use — another adapter's, another version, one that no longer aligns with the content — degrades the turn to plain text and costs the identities, never the content.

**Stream translation** (`src/responses-stream.ts`). Deltas open blocks, the authoritative item that closes each one supplies anything the deltas missed, and an endpoint that streams nothing but its terminal event is served from that event's output instead. Usage is split as this API reports it: the prompt total carries cached and cache-written tokens inside it, so they are subtracted out for the harness's disjoint input count. Statuses map onto the harness's finish reasons; a stream cut off before a terminal event, or one that ends without stating an outcome, is a transport failure rather than a finished turn.

**Every declared protocol now has a transport.** `SERVED_INTERFACE_TYPES` names the same set as the vocabulary, the runtime refusal is gone, and the transport table is typed over those names: adding a protocol to the vocabulary without adding its transport stops compiling instead of reaching a deployment as a refusal.

## Alternatives considered

**Keep refusing `openai-responses`.** Rejected: the vocabulary entry exists, the reference implementation exists, and a refusal no later change lifts leaves the endpoint unreachable.

**Serve Responses profiles over the chat-completions or Messages wire.** Rejected: those bodies carry a conversation of roles and tool results shaped for their own protocol; the endpoint would read neither.

**Answer an unanswered call with a placeholder output, as the Messages and chat-completions paths do.** Rejected for this protocol: the API checks that every call has an output and the reference implementation records strict gateways rejecting fabricated ones. Dropping the call keeps the request valid; the durable log keeps the call and its missing result either way.

**Port the reference's tail placeholder reasoning item** (a fabricated `reasoning` item when an input ends on an assistant turn with no reasoning). Not ported: it writes model-visible content the session never had, to satisfy an endpoint-specific requirement, and this adapter sends only what the profile declares. The endpoint's own error is the honest answer, and the profile can declare `reasoningContent` to have the real reasoning replayed.

**Carry the protocol's server-side tools and stored responses.** Not carried: this seam has no vocabulary for a server-side tool call, and a stateless session keeps its state in the durable log, so no `store` field is sent and `web_search_call` items are ignored rather than translated into a block the harness cannot replay.

## Consequences

A profile declaring `openai-responses` registers and serves; `responsesEncryptedReplay` is honoured instead of refused; `video` input and `imageOutput` remain refused. On this route a caller's `stop` sequences are omitted, because the protocol has none. Reasoning survives a later request only for the provider and model that produced it and only under the declared form; a foreign envelope costs the identities and keeps the text. A route that never declares `reasoningContent` or `responsesEncryptedReplay` replays no reasoning at all, which is what the declaration means.

The three transports now share one shape — assembly, repair, translation, envelope — so the next protocol is a transport plus its own repair, not a new architecture. Nothing changed in the official dsh mainline: this branch's plugin owns the whole surface.

## Testing

`packages/llm/llm-service-lite/tests/openai-responses.spec.ts` pins the request (endpoint, bearer auth, the always-streamed flag, the cap floor, sampling beside reasoning, `instructions`, flat tools, the reasoning spellings, the encrypted `include`, extra body layering) and the mapping (user items, folded system and developer messages, images and offloaded occurrences, orphan results dropped, unanswered calls dropped, repeated call ids collapsed, grouped parallel calls, media synthesis, and every replay degradation). `packages/llm/llm-service-lite/tests/responses-stream.spec.ts` pins the translation: streamed text with an authoritative suffix, disagreeing closing items, signed and plain reasoning, tool-call assembly, items written from the terminal event of an endpoint that never streamed, sentinel ends, every status mapping, the accounting split, malformed usage, cut streams, empty responses and outcome-less ends. `packages/llm/llm-service-lite/tests/adapter.spec.ts` drives a Responses route end to end over HTTP — path, headers, body, the repaired history of an unanswered call, and the replay envelope the runtime stores — and `tests/profiles.spec.ts` pins that every vocabulary entry resolves.
