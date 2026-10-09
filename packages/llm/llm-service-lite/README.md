---
description: "A lighter LLM service: self-contained provider profiles, a declared model catalog, and the chat-completions, Anthropic Messages, and OpenAI Responses wires on the harness LLM seam, referencing OpenWebCode's implementation."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-service-lite

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-service-lite` adapts third-party model endpoints: one route per configured provider profile, all answered over its transports — the OpenAI-compatible chat-completions wire, the Anthropic Messages protocol, and the OpenAI Responses API — so no provider SDK and no installed catalog sits in the request path. A profile is self-contained — wire protocol, endpoint, credential reference, request-body extras, concurrency, image input, and the models served — so a gateway, a national API, and a corporate proxy reach one code path. The shape ports OpenWebCode's model-provider layer onto the harness seam: one document describes every provider, and the route set follows it live.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a deployment wants to describe its model providers itself instead of naming providers an installed catalog already knows. The `providers` dictionary is the whole configuration surface: each key is the provider route a request selects with `GenerateOptions.provider`, and the value is everything that endpoint needs.

### When to choose it

This plugin adapts third-party endpoints and nothing else: every route it registers comes from a profile a deployment wrote, and the first-party DeepSeek channel keeps its own adapter. Choose this adapter when the same composition serves several endpoints — a national model API, a self-hosted vLLM or SGLang gateway, and a proxy on the corporate network — and each must be described completely rather than derived from a catalog. Choose `dsh-llm-pi-ai` when a pi-ai catalog entry already supplies the protocols and model capabilities. Both adapters can be mounted together because their route names do not collide; registering a route another adapter already owns fails plugin loading.

### Configure provider profiles

```yaml
- id: llm-service-lite
  name: '@deepseek-ai/dsh-llm-service-lite'
  config:
    providers:
      # A provider reached at its published API, with the key from the seam.
      deepseek:
        displayName: DeepSeek
        interfaceType: openai-chat-completions
        baseURL: https://api.deepseek.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        includeUsage: true
        models:
          - id: deepseek-chat
            contextWindow: 131072
            maxTokens: 8192
          - id: deepseek-reasoner
            contextWindow: 131072
            maxTokens: 65536
            capabilities:
              effort: [low, medium, high]
              thinking: [enabled, disabled]
              reasoningContent: true
      # A self-hosted gateway: body fields only this server understands.
      vllm:
        interfaceType: openai-chat-completions
        baseURL: http://127.0.0.1:8000/v1
        extraBody:
          top_k: 40
        maxConcurrent: 1
        models:
          - id: Qwen3-32B
            contextWindow: 32768
            maxTokens: 8192
            capabilities:
              effort: [low, high]
              thinkingStyle: enable_thinking
      # An endpoint reached over the Responses API, with encrypted reasoning
      # replay declared.
      openai:
        interfaceType: openai-responses
        baseURL: https://api.openai.com/v1
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-5
            contextWindow: 400000
            maxTokens: 128000
            capabilities:
              effort: [minimal, low, medium, high]
              thinking: [disabled]
              responsesEncryptedReplay: true
      # An endpoint reached over the Anthropic Messages protocol, with prompt
      # caching and its thinking modes declared.
      claude:
        interfaceType: anthropic-messages
        baseURL: https://api.anthropic.com/v1
        apiKeyEnv: ANTHROPIC_API_KEY
        promptCaching: true
        models:
          - id: claude-sonnet-4-5-20250929
            contextWindow: 200000
            maxTokens: 64000
            capabilities:
              thinking: [enabled, disabled]
              # This endpoint reads a later system message as the effective
              # prompt and activates tools inside the conversation.
              systemPromptUpdate: in-history
              toolUpdate: in-history
      # A gateway that routes by header and needs no credential of its own.
      proxy:
        interfaceType: openai-chat-completions
        baseURL: https://proxy.example.com/v1
        headers:
          x-tenant: acme
        streamIdleTimeoutMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the route registers at all |
| `interfaceType` | required | `openai-chat-completions`, `anthropic-messages`, or `openai-responses`; each selects its own transport |
| `baseURL` | protocol default | Endpoint of every model on the route; the protocol's usual host and version segment apply when omitted |
| `apiKeyEnv` | absent | Credential reference resolved per request through the credential seam |
| `apiKey` | absent | Inline credential, for a profile imported from another tool |
| `headers` | none | Static request headers; a named credential still wins over `authorization` |
| `promptCaching` | `false` | Whether the route may mark cache breakpoints (anthropic-messages only) |
| `includeUsage` | `false` | Whether the request asks for a streamed usage report (chat-completions only) |
| `extraBody` | none | Extra top-level request-body fields the endpoint understands |
| `maxConcurrent` | `3` | Concurrent requests before further calls queue |
| `streamIdleTimeoutMs` | `300000` | Maximum idle interval between two stream events |
| `retryPolicy` | normal, 5 retries | Provider-owned policy executed by `dsh-llm-retry` |
| `models` | `[]` | The models this route advertises, with their capacities and capabilities |
| `defaultContextWindow` | `262144` | Context capacity for a model that declares none |
| `defaultMaxTokens` | `8192` | Output capability for a model that declares none |
| `imageRequestMaxBytes` | `20971520` | Accumulated base64 image payload one request carries |
| `imageRequestMaxImages` | `600` | Image occurrences one request carries |
| `imageOffloadByteQuantum` | `10485760` | Payload removed as one deterministic offload step |
| `imageOffloadCountQuantum` | `20` | Occurrences removed as one deterministic offload step |

### Declare what a model can do

A model entry's `capabilities` are declarations about the endpoint, never guesses: a capability left out is one this adapter does not claim, and one it declares is honoured or refused by name — never accepted with nothing behind it. `effort` lists the selectable reasoning levels and its values are the wire spellings, so a gateway with its own vocabulary declares that vocabulary. `thinking` lists the accepted thinking modes (`enabled`, `disabled`, `adaptive`). `thinkingStyle` says how the endpoint spells the switch: `thinking: { type: … }`, a top-level `enable_thinking` boolean, `fixed` for a model that always thinks, or `effort_only` — the explicit spelling of an endpoint that takes an effort level and has no switch, which is the same request an omitted style sends. `reasoningContent` declares that the endpoint returns reasoning in `reasoning_content`, which is what lets a later request replay prior thinking. `tools` declares whether tool declarations may be sent at all: a model that turns them off receives none rather than a list its endpoint would reject. `modalities` names what the endpoint accepts — `text`, `image`, `video`. `image` is carried: a retained occurrence is read from the attachment provider at the model's pixel budget (or its source dimensions), re-encoded to the model's byte target, and sent as an inline base64 `image_url` part, while an occurrence the session already offloaded contributes its placeholder text instead. A route's accumulated request is bounded by `imageRequestMaxBytes`, `imageRequestMaxImages`, `imageOffloadByteQuantum`, and `imageOffloadCountQuantum`; a request over budget fails with `IMAGE_OFFLOAD_REQUIRED` naming how many oldest occurrences to offload rather than dropping an image silently. `video` input and `imageOutput` are still refused where they are declared until a transport carries them, because a declaration nothing acts on would read as a capability the route does not have. `responsesEncryptedReplay` is honoured by the Responses transport: the request asks for `reasoning.encrypted_content` and hands each reasoning item back verbatim on the next turn. `systemPromptUpdate` and `toolUpdate` declare the two mid-conversation reads a Messages endpoint can be asked for: the latest system message as the complete effective prompt, and a tool change as an activation or deactivation of a tool the declaration list already names. Declaring either is what makes the harness hand this route `tool-addition` and `tool-removal` blocks instead of restating the prompt and the tool list on every turn, and the declarations of the tools it defers then carry `defer_loading`. Both are refused on the two OpenAI wires, which have no mid-history part to read. `imageTokens` declares the endpoint's own visual-token accounting — `{ kind: area, per: 750 }` for a flat pixel grid, or `{ kind: tiles, tile: 512, base: 85, perTile: 170 }` for a base price plus a price per square tile — which is what the token meter reads to price an image-bearing context; a route that declares none keeps the meter's own structural heuristic rather than a number this adapter guessed.

An image request needs the attachment provider mounted (`attachments`); a deployment serving text-only routes never mounts one, and a route that declares `image` without it fails the request before the endpoint sees a partial call.

### Change configuration at runtime

Each operation captures the current provider set. A changed route set — or a route's display name, concurrency, or retry policy, which the registry captures at registration — re-registers the same adapter instance in place, so an in-flight request keeps the endpoint it started with and the next request sees the new one. A profile that cannot be served is refused where it is written and, when already stored, kept addressable with its diagnostic instead of taking the other routes down with it.

### Discover models from endpoints

The plugin answers "which models can this endpoint serve?" for a route a configuration surface is editing or drafting. A configured route supplies its stored endpoint and credential inside the Host; a draft supplies its own. The listing is read from `GET {baseURL}/models` with bearer auth, and both published shapes are accepted: the standard `data` array and the enriched `models` map. The reply is candidate metadata a surface may offer for adoption — nothing is stored, and the profile a user saves decides what a route serves.

### Failures and recovery

Failures carry stable codes: a named credential that resolves to nothing fails with `MISSING_CREDENTIAL`, a rejected request with `INVALID_REQUEST`, an exhausted quota with `QUOTA` rather than a rate limit, and a request that exceeds the model context with `CONTEXT_WINDOW_EXCEEDED`, which is what lets the agent compact instead of retrying. A stream that ends without a terminal event fails with `TRANSPORT` rather than looking like a finished turn, and a completion that carries no content fails with `EMPTY_RESPONSE`. A provider-requested delay is read from `Retry-After` and handed to the retry layer.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

Three rules shape the package. A profile is the whole truth: nothing is inferred from an installed catalog, so an endpoint that is not OpenAI, Anthropic, or DeepSeek is configured, not special-cased. A declared capability is a promise: the request path sends only what the profile declares and never invents a knob. And a failure is classified where it happens: the transport turns each HTTP status and error body into one stable code, because that is the only point that sees the whole provider answer.

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin: profile resolution, route registration, directory, discovery |
| `src/config.ts` | Configuration schema and the profile vocabulary |
| `src/profiles.ts` | Validation and materialization of profiles into route facts |
| `src/models.ts` | Projection of model facts onto the seam's model vocabulary |
| `src/adapter.ts` | The adapter: per-route snapshot, admission, idle watchdog, dispatch |
| `src/chat-completions.ts` | Request assembly and stream translation for the chat-completions wire |
| `src/anthropic-messages.ts` | Request assembly, pairing repair, and thinking-signature replay for the Messages wire |
| `src/anthropic-stream.ts` | Messages event-stream translation into the harness chunk vocabulary |
| `src/openai-responses.ts` | Request assembly, input mapping, and reasoning replay for the Responses wire |
| `src/responses-stream.ts` | Responses event-stream translation into the harness chunk vocabulary |
| `src/sse.ts` | Server-sent-event framing with a data-only idle pulse |
| `src/errors.ts` | Provider-failure classification |
| `src/limiter.ts` | Per-route FIFO admission control |
| `src/discovery.ts` | Endpoint interrogation for configuration surfaces |

### Registration and directory

A mount with no profiles registers nothing: the plugin holds no route until its settings section supplies one, which is why the base bundle can mount it dormant. Every configured route appears in the configurable-provider directory, including one that is disabled or currently unserviceable, so a settings surface can address and repair it by name.

### Wire translation

Two transports answer one seam. `openai-chat-completions` speaks the OpenAI-compatible wire and `anthropic-messages` the Messages protocol, and both own the three things a provider stream does not: block identity and ordering, tool-call assembly across streamed fragments, and the difference between a stream that ended and one that was cut off.

Both also repair their protocol's pairing rules on the way out, because a durable history can hold shapes no endpoint accepts. A result whose call is gone is dropped; a call id one assistant turn declares twice, or that a later turn declares again, collapses to its first occurrence; a repeat result for one call is dropped and its first occurrence kept; a call nothing ever answered is answered with a placeholder rather than left to a 400; and the results of one parallel batch merge into the single user turn both protocols require. The repair happens in the wire projection, so the durable log is never rewritten to make a request acceptable.

Reasoning is replayed only for a route that declares it and only for history this same provider and model produced. `openai-chat-completions` replays it through `reasoning_content`. `anthropic-messages` replays signed and redacted thinking blocks through adapter-private replay metadata on the assistant message, because that protocol rejects a thinking block returned without its signature; metadata another provider, another model, or another adapter wrote degrades that one turn to plain text instead of failing the request.

The Responses transport maps the conversation onto the API's flat item list — an assistant `message`, a `function_call` per call, and a `function_call_output` carrying the same id — and repairs that list the same way, with one difference the protocol forces: a call nothing answered is dropped rather than answered with a placeholder, because strict gateways reject a fabricated output, and a turn's parallel calls are grouped so the API folds them into one assistant turn. Its reasoning follows the model's declaration: `reasoningContent` replays the thinking text as `reasoning_text`, and `responsesEncryptedReplay` hands the provider's own item back verbatim. The protocol carries no stop sequences, so a caller's `stop` is omitted rather than approximated.

The Messages transport reads its prompt from `system`, else from a leading system message. A later system or developer message folds into a user turn where it stands and a mid-conversation instruction keeps its position — unless the model declared `systemPromptUpdate` or `toolUpdate`, in which case that message travels as the `system`-role history message this protocol reserves for mid-history changes, with tool additions and removals spelled as references to the declared tools. Such a message is held back until the turn it follows is a user turn, because the protocol reads it as an instruction between turns, and a change that would land earlier is refused by name rather than moved. Tool results carry their media inline as image blocks beside their text, `max_tokens` is always sent because the protocol requires the cap, and `promptCaching` marks this protocol's own breakpoints: the system prompt and the last tool declaration.

<a id="further-exploration"></a>
## Further Exploration

- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the message and block types, the assembled request, and the adapter contract this package implements.
- [Providers guide](../../../docs/user/guide/providers.md) — how a deployment configures providers on the shipped profiles.
- [OpenWebCode](https://github.com/snnh/openwebcode) — the provider-profile model this adapter follows.

<a id="model-experience"></a>
## Model Experience

### Provider request through the adapter

#### What the model sees

The conversation exactly as the harness assembled it: the system prompt as a leading system message, user and assistant turns in order, tool declarations as function schemas, and each tool result attached to the call it answers. A request adds the endpoint's own `extraBody` fields and, when the model declares how it spells them, the effort level and thinking switch the caller selected.

#### Token effect

The request carries no adapter-authored prompt text. `max_tokens` is present on a chat-completions request only when the caller configured one, so an endpoint that defaults its own ceiling keeps it; the Messages protocol requires the cap, so it is always sent there, from the request, the profile's override, or the model's declared cap.

#### KV Cache effect

Nothing in the translation is per-request random: the same history produces the same request bytes, so provider-side prefix caching keeps working across turns. A route marked `promptCaching` uses the protocol's own cache marking — the Messages transport marks the system prompt and the last tool declaration — and otherwise the adapter adds no cache breakpoints of its own.

### Provider response

#### What the model sees

Content deltas become text blocks, `reasoning_content` becomes reasoning blocks, signed thinking becomes a reasoning block whose signature is kept as replay metadata, and streamed tool-call fragments become one call each. The model's own stop reason is mapped onto the harness vocabulary, and a stream that ends without one is a transport failure rather than a completed turn.

#### Token effect

Usage is reported when the endpoint sends it, with cached prompt tokens separated out of the input count exactly as the harness contracts: `inputTokens` excludes what the provider served from cache, which is reported as `cacheReadTokens`.

#### KV Cache effect

Replayed reasoning is byte-identical to what the provider returned, so a route that echoes reasoning back keeps its cache prefix stable; a route that does not declare `reasoningContent` sends no reasoning at all rather than a paraphrase.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Three protocols, three shapes.** Every declared protocol has a transport, and each carries that protocol's own features: the Responses API's server-side tools (`web_search_call` items) are not carried, and no `store` field is sent, so a deployment keeps provider-side state out of the request path.
- **No video input or image output.** A profile declaring `video` input or `imageOutput` is refused rather than served with the difference dropped. `image` input is carried, and so is the token accounting a profile declares through `imageTokens`; a route that declares none keeps the meter's structural heuristic, and no adapter-authored handle text travels beside the bytes, so a priced occurrence counts the visual tokens the endpoint charges and nothing this adapter invented.
- **No adapter-side retries.** One call is one provider attempt, so the provider's retry policy is executed by `dsh-llm-retry` at the durable step boundary, and a retry re-derives the whole request.
- **Replay metadata is protocol-specific.** The Messages transport writes and reads its own envelope for thinking signatures, and the Responses transport keeps each reasoning item (id and encrypted payload) for the model that asked for encrypted replay; neither envelope is portable across providers.
- **Mid-history changes are the endpoint's own contract.** A route that declared `systemPromptUpdate` or `toolUpdate` receives them as `system`-role history messages, so an endpoint that gates that part behind a beta header is configured with that header in `headers`: nothing is injected on the endpoint's behalf, and a change that arrives with no user turn to follow fails the request with `UNSUPPORTED_CONTENT` instead of being silently moved or dropped.
- **No streaming usage in the absence of a report.** An endpoint that never sends a usage chunk leaves token accounting to the harness's estimator.

<a id="dev-note"></a>
### Dev Note

The two coexist deliberately: the catalog route is the shortest path to a known provider, this one the honest path to any endpoint that is not.
