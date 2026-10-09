# Agent Note: The local LLM service speaks the Anthropic Messages protocol

Status: implemented

English | [中文](2026-10-08-service-lite-anthropic-messages.zh.md)

## Problem

An Anthropic Messages request that answers one `tool_use` id twice is rejected outright — `each tool_use must have a single result. Found multiple tool_result blocks with id: …` (2026-10-08). The validator that produced that error belongs to the Messages protocol, and the protocol is what this branch's own provider plugin, `dsh-llm-service-lite`, could not reach: probing it turned up three defects at the protocol boundary.

First, `interfaceType: 'anthropic-messages'` and `'openai-responses'` resolved and were then served over the chat-completions wire, so a profile aimed at an Anthropic endpoint produced `POST https://api.anthropic.com/chat/completions` with an OpenAI-shaped body, even though the plugin's README had always claimed those protocols are refused by name. Second, the chat-completions translation declared a call id twice when one assistant turn carried it twice, emitting two `tool_calls` entries and two `tool` messages for one id — the shape a strict endpoint rejects. Third, and decisively, the plugin had no Messages transport at all: even the correct pairing of a well-formed history could not be sent, and the pairing rules the validator enforces (one result per `tool_use` id, ids unique within a message, results in the turn that follows their call) were enforced nowhere in the plugin.

OpenWebCode — the provider layer this plugin ports — had already met the same failure and fixed it inside its own Messages serializer. Its repair is the reference this change follows: a durable history is corrected on the way out, not rejected; the first result per call id wins, an orphan result is dropped, a repeated call id collapses to its first occurrence, a call nothing answered is answered with a placeholder, and the results of one parallel batch merge into the single user turn the protocol requires. It also replays signed thinking blocks, because this endpoint rejects a thinking block returned without its signature.

## Decision

The plugin serves `anthropic-messages` with its own transport, and unbuilt protocols stay refused by name.

**Request assembly** (`src/anthropic-messages.ts`) builds the wire body: the prompt from `options.system` or a leading system message, `tools` with an `input_schema` per declaration, `max_tokens` always present because the protocol requires the cap, `stream: true`, `stop_sequences`, and the reasoning spelling the selected level implies — an effort level becomes `output_config.effort`, a declared thinking mode becomes the `thinking` block, and an extended budget leaves the answer room instead of consuming the whole cap. A later system or developer message folds into a user turn where it stands, because this protocol has no mid-conversation system slot; hoisting it to the top would silently move an instruction. `x-api-key` and `authorization: Bearer` both travel, so the official API and an Anthropic-compatible gateway resolve the same credential, and `anthropic-version` is always sent.

**Pairing repair** happens in that assembly, per the reference: one result per call id (first wins), orphan results dropped, a repeated call id declared once, an unanswered call answered with a placeholder, and one batch of results emitted as one user turn. The durable log is never rewritten to make this true — a repaired request is a projection, not an edit — so a session remains exactly as it was recorded.

**Thinking replay** rides the harness's adapter-private replay metadata: the stream writes one entry per block (signature or redacted payload for reasoning), and the request path returns those blocks only for the provider and model that produced them. Any mismatch — another adapter's kind, another version, another model, an envelope that no longer aligns with the content — degrades that one turn to its plain text instead of failing the request.

**Stream translation** (`src/anthropic-stream.ts`) turns the Messages event protocol into the harness chunk vocabulary: block identity and ordering, tool-call assembly from `input_json_delta` fragments, signed and redacted thinking, cache-aware usage from the two usage reports, this protocol's stop reasons mapped onto the harness reasons, and a stream cut off inside a block reported as a transport failure rather than a finished turn.

`SERVED_INTERFACE_TYPES` now names both built transports, so the refusal narrows to `openai-responses`: a profile declaring it fails resolution with a diagnostic naming the route instead of being served over a wire it cannot read. The refusal still runs after the profile's own contradiction checks, because those say what to change while this says why the route cannot serve at all.

## Alternatives considered

**Fix the cause in the harness: reject a response whose tool-call ids repeat, before it is executed.** Rejected: that is `packages/core/agent-loop`, official dsh mainline, which this branch does not patch. The server-side consequence is recorded below.

**Patch the Anthropic-facing mainline adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`).** Rejected for the same reason: both are mainline packages, and the DeepSeek one is the package this branch explicitly leaves at its upstream revision.

**Ship only the refusal and no transport.** Rejected: the deployment's Anthropic-compatible endpoints stay unreachable, and a refusal that no later change lifts is not a fix. The refusal was the correct interim state (it stopped sending requests the endpoint could not read); the transport is what makes the protocol usable.

**Keep serving any declared protocol over the chat-completions wire.** Rejected: the endpoint receives a body it cannot read, and the failure surfaces as a confusing provider error far from the misconfiguration.

**Port OpenWebCode's OpenAI-compatible fallback heuristic as well** — a call with no result of its own adopting an unconsumed result. Rejected: this plugin's chat-completions translation declares every call and answers it with its own result or a placeholder, which keeps the one-result-per-call invariant without pairing unrelated ids, and the Messages repair applies the same rule for the same reason.

## Consequences

A profile declaring `anthropic-messages` now registers and serves. Its endpoint default is `https://api.anthropic.com/v1` (the version segment belongs to the profile endpoint, as it does for the chat-completions default): nothing deployed could have used the previous value, since no transport existed to send it. `promptCaching` now has an effect on this transport — it marks the system prompt and the last tool declaration — where a chat-completions route still refuses the declaration by name. `includeUsage` remains chat-only, and `openai-responses` remains unbuilt.

Thinking text survives a later request only for history this provider and model produced; the metadata is not portable, and a gap degrades the turn to text rather than sending a block the endpoint would reject. The earlier duplicate-call-id fix in the chat-completions translation remains in place, because a strict OpenAI-compatible endpoint rejects that shape too. On this branch the harness's mainline LLM path is still unchanged: a provider response that repeats a tool-call id is executed by the loop, and the transports are what keep the resulting history from reaching an endpoint as a duplicate declaration.

## Testing

`packages/llm/llm-service-lite/tests/anthropic-messages.spec.ts` pins the request fields (endpoint, headers, required cap, system prompt, cache breakpoints, tools, reasoning spelling) and every pairing case: an orphan result dropped, a repeated result dropped with the first kept, a repeated call id collapsed, an unanswered call answered with a placeholder at the batch boundary and at the end of the history, one batch merged into one user turn, media inlined into a tool result, and replay metadata accepted only for the provider and model that wrote it. `packages/llm/llm-service-lite/tests/anthropic-stream.spec.ts` pins the translation: text, signed and redacted thinking, tool-call assembly, usage merging, every stop reason the harness knows, a malformed event, a stream cut off inside a block, a stream cut off between blocks, and an empty response. `packages/llm/llm-service-lite/tests/adapter.spec.ts` drives a Messages route end to end over HTTP — its path, headers, and body, plus the repaired history of a call whose result never landed — and `tests/profiles.spec.ts` pins the remaining refusal and that both built protocols resolve.
