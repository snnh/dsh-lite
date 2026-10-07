---
description: "A lighter LLM service: self-contained provider profiles, a declared model catalog, and a native chat-completions transport on the harness LLM seam, referencing OpenWebCode's implementation."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-service-lite

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-service-lite` adapts third-party model endpoints: it registers one route per configured provider profile and answers all of them over its own chat-completions transport, so no provider SDK and no installed catalog sits in the request path. A profile is self-contained — wire protocol, endpoint, credential reference, request-body extras, concurrency, image input, and the models served — so a gateway, a national API, and a corporate proxy reach one code path. The shape ports OpenWebCode's model-provider layer onto the harness seam: one document describes every provider, the route set follows it live, and a request carries exactly the declared fields.

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
| `interfaceType` | required | `openai-chat-completions`, `anthropic-messages`, or `openai-responses` |
| `baseURL` | protocol default | Endpoint of every model on the route |
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

A model entry's `capabilities` are declarations about the endpoint, never guesses: a capability left out is one this adapter does not claim, and one it declares is honoured or refused by name — never accepted with nothing behind it. `effort` lists the selectable reasoning levels and its values are the wire spellings, so a gateway with its own vocabulary declares that vocabulary. `thinking` lists the accepted thinking modes (`enabled`, `disabled`, `adaptive`). `thinkingStyle` says how the endpoint spells the switch: `thinking: { type: … }`, a top-level `enable_thinking` boolean, `fixed` for a model that always thinks, or `effort_only` — the explicit spelling of an endpoint that takes an effort level and has no switch, which is the same request an omitted style sends. `reasoningContent` declares that the endpoint returns reasoning in `reasoning_content`, which is what lets a later request replay prior thinking. `tools` declares whether tool declarations may be sent at all: a model that turns them off receives none rather than a list its endpoint would reject. `modalities` names what the endpoint accepts — `text`, `image`, `video`. `image` is carried: a retained occurrence is read from the attachment provider at the model's pixel budget (or its source dimensions), re-encoded to the model's byte target, and sent as an inline base64 `image_url` part, while an occurrence the session already offloaded contributes its placeholder text instead. A route's accumulated request is bounded by `imageRequestMaxBytes`, `imageRequestMaxImages`, `imageOffloadByteQuantum`, and `imageOffloadCountQuantum`; a request over budget fails with `IMAGE_OFFLOAD_REQUIRED` naming how many oldest occurrences to offload rather than dropping an image silently. `video` input, `imageOutput`, and `responsesEncryptedReplay` are still refused where they are declared until a transport carries them, because a declaration nothing acts on would read as a capability the route does not have.

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
| `src/sse.ts` | Server-sent-event framing with a data-only idle pulse |
| `src/errors.ts` | Provider-failure classification |
| `src/limiter.ts` | Per-route FIFO admission control |
| `src/discovery.ts` | Endpoint interrogation for configuration surfaces |

### Registration and directory

A mount with no profiles registers nothing: the plugin holds no route until its settings section supplies one, which is why the base bundle can mount it dormant. Every configured route appears in the configurable-provider directory, including one that is disabled or currently unserviceable, so a settings surface can address and repair it by name.

### Wire translation

The chat-completions translation owns three things the provider does not: block identity and ordering, tool-call assembly across streamed fragments, and the difference between a stream that ended and one that was cut off. Tool results are paired with their calls as the protocol requires, an unanswered call gets a placeholder rather than a request the endpoint rejects, and an orphaned result is dropped. Reasoning is replayed through `reasoning_content` only for a route that declares it and only for history this same provider produced.

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

The request carries no adapter-authored prompt text. `max_tokens` is present only when the caller configured one, so an endpoint that defaults its own ceiling keeps it; a route that declares none sends no cap at all.

#### KV Cache effect

Nothing in the translation is per-request random: the same history produces the same request bytes, so provider-side prefix caching keeps working across turns. A route marked `promptCaching` uses the protocol's own cache marking; this adapter adds no cache breakpoints of its own.

### Provider response

#### What the model sees

Content deltas become text blocks, `reasoning_content` becomes reasoning blocks, and streamed tool-call fragments become one call each. The model's own stop reason is mapped onto the harness vocabulary, and a stream that ends without one is a transport failure rather than a completed turn.

#### Token effect

Usage is reported when the endpoint sends it, with cached prompt tokens separated out of the input count exactly as the harness contracts: `inputTokens` excludes what the provider served from cache, which is reported as `cacheReadTokens`.

#### KV Cache effect

Replayed reasoning is byte-identical to what the provider returned, so a route that echoes reasoning back keeps its cache prefix stable; a route that does not declare `reasoningContent` sends no reasoning at all rather than a paraphrase.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One protocol implemented.** `openai-chat-completions` is fully served; `anthropic-messages` and `openai-responses` are part of the vocabulary and are refused by name at resolution, because serving a declared protocol with different wire behaviour would be worse than saying so. They are the next milestone.
- **No video input or image output.** A profile declaring `video` input or `imageOutput` is refused rather than served with the difference dropped. `image` input is carried, but without per-image token accounting: `imageRequestPricing` is not implemented, so a surface pricing a request prices its images as it prices the text that replaces them, and prompt-cache accounting sees the encoded payload rather than the model's visual-token count.
- **No adapter-side retries.** One call is one provider attempt, so the provider's retry policy is executed by `dsh-llm-retry` at the durable step boundary, and a retry re-derives the whole request.
- **No replay envelope.** A successful response carries no adapter-private replay state, so history is re-sent as durable messages, and a profile declaring `responsesEncryptedReplay` is refused by name until the responses transport lands.
- **No streaming usage in the absence of a report.** An endpoint that never sends a usage chunk leaves token accounting to the harness's estimator.

<a id="dev-note"></a>
### Dev Note

The two coexist deliberately: the catalog route is the shortest path to a known provider, this one the honest path to any endpoint that is not.
