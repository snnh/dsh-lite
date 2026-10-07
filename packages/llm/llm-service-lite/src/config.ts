/**
 * Configuration schema and provider-profile vocabulary for the OWC-style
 * adapter.
 *
 * The shape follows OpenWebCode's model-provider layer rather than pi-ai's
 * catalog: a profile is a self-contained endpoint declaration — protocol,
 * endpoint, credential, and the models it serves — and the `providers` dict
 * key is the route a request selects. Nothing here assumes an installed
 * catalog knows the provider, so a gateway reaches the same code path as a
 * first-party endpoint.
 *
 * One deliberate departure: a credential may be named as a harness reference
 * (`apiKeyEnv`) instead of being written into the configuration, which is how
 * a deployment keeps secrets out of a file that may be committed. An inline
 * `apiKey` remains available for a profile imported verbatim from OWC.
 *
 * @module dsh-llm-service-lite/config
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/**
 * Wire protocols a provider profile may name, spelled the way OWC spells
 * them. `openai-chat-completions` is the broadest by far: DeepSeek, Qwen,
 * GLM, Kimi, and every self-hosted vLLM or SGLang server speak it, which is
 * why it is the default a configuration surface should offer first.
 */
export const INTERFACE_TYPES = ['openai-chat-completions', 'anthropic-messages', 'openai-responses'] as const

/** One wire protocol name from {@link INTERFACE_TYPES}. */
export type InterfaceType = (typeof INTERFACE_TYPES)[number]

/**
 * Reasoning-effort levels a model may offer, ordered least to most expensive.
 * The level id is also its wire spelling for `openai-chat-completions`: OWC
 * sends exactly the level the user picked, so a gateway with its own
 * vocabulary declares that vocabulary as its levels.
 */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** One selectable reasoning-effort level from {@link EFFORT_LEVELS}. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Thinking modes a model may accept. `disabled` is a capability that means
 * the endpoint can be told to stop thinking; a model offering only that mode
 * publishes no selectable reasoning levels.
 */
export const THINKING_MODES = ['adaptive', 'enabled', 'disabled'] as const

/** One thinking mode from {@link THINKING_MODES}. */
export type ThinkingMode = (typeof THINKING_MODES)[number]

/**
 * How a chat-completions endpoint spells the thinking switch, mirroring OWC's
 * `thinkingStyle`: `thinking` and `fixed` send `thinking: { type }`,
 * `enable_thinking` sends a top-level boolean, and `effort_only` — like an
 * unset style — sends only the effort level. The explicit spelling of "no
 * switch" exists so an OWC-format document carries over without editing: it
 * declares the same behaviour the omitted style already gives.
 */
export const THINKING_STYLES = ['thinking', 'fixed', 'enable_thinking', 'effort_only'] as const

/** One thinking wire style from {@link THINKING_STYLES}. */
export type ThinkingStyle = (typeof THINKING_STYLES)[number]

declare module '@deepseek-ai/dsh-llm' {
  interface ModelModalityMap {
    /**
     * Video input, which OWC's catalog names and every other adapter leaves
     * out. Declaring it is refused by name at resolution until the transport
     * carries moving pictures, so nothing downstream ever reads it as a served
     * capability — the vocabulary is the port's, and the refusal is where the
     * harness stops short.
     */
    video: 'video'
  }
}

/**
 * Input modalities a model accepts; text is the assumption when none is
 * declared. The vocabulary mirrors OWC's; `image` is carried as an inline
 * base64 `image_url` part, and `video` is refused by name until the wire
 * carries one.
 */
export const MODALITIES = ['text', 'image', 'video'] as const

/** One input modality from {@link MODALITIES}. */
export type Modality = (typeof MODALITIES)[number]

/**
 * Concurrent requests one route serves before further calls queue. OWC fixes
 * this at three per provider: enough to let a swarm overlap, few enough that a
 * rate-limited endpoint sees a plateau instead of a spike.
 */
export const DEFAULT_MAX_CONCURRENT = 3

/**
 * Default maximum idle interval between two stream events, in milliseconds.
 * A gateway that stalls mid-response without closing the socket would
 * otherwise hold a turn open forever.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Context capacity assumed for a model the profile does not size. The guess
 * is deliberately generous rather than conservative: an oversized window costs
 * a compaction that would have been unnecessary, while an undersized one
 * refuses a request the endpoint would have accepted.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000

/** Output capability assumed for a model the profile does not size. */
export const DEFAULT_MAX_TOKENS = 8_192

/**
 * Accumulated base64 image payload one request may carry. The default matches
 * the official adapter's inline ceiling: beyond it a gateway that accepts the
 * request at all tends to answer slowly or truncate, and the caller can do
 * better by offloading the oldest occurrence.
 */
export const DEFAULT_IMAGE_REQUEST_MAX_BYTES = 20 * 1024 * 1024

/** Image occurrences one request may carry. */
export const DEFAULT_IMAGE_REQUEST_MAX_IMAGES = 600

/** Payload removed as one deterministic offload step. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024

/** Occurrences removed as one deterministic offload step. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20

/**
 * What one model on a route can do. Every field is a declaration about the
 * endpoint, not a guess: a capability left out is one this adapter does not
 * claim, and the request path omits rather than invents.
 */
export interface OwcModelCapabilities {
  /** Accepted input modalities; omission means text only. */
  modalities?: Modality[]
  /** Accepted reasoning-effort levels; empty or absent publishes no effort selector. */
  effort?: EffortLevel[]
  /** Accepted thinking modes; `disabled` alone means the switch exists but thinking is off. */
  thinking?: ThinkingMode[]
  /** How this model's endpoint spells the thinking switch; omission sends only the effort level. */
  thinkingStyle?: ThinkingStyle
  /**
   * Whether the endpoint returns its reasoning in `reasoning_content`, so a
   * later request may replay prior thinking the way DeepSeek's own API does.
   */
  reasoningContent?: boolean
  /**
   * Whether tool declarations may be sent to this model; omission means they
   * may. A model declaring `false` is one whose endpoint rejects or mishandles
   * a `tools` array, so the request carries none and the model answers as plain
   * chat — the same declaration OWC's catalog makes.
   */
  tools?: boolean
  /**
   * Whether the model returns images. Declaring it is refused at resolution:
   * this adapter carries text and tool output, and an accepted declaration
   * nothing acts on would read as a capability the route does not have.
   */
  imageOutput?: boolean
  /**
   * Whether the endpoint replays signed reasoning items. Advertised by OWC's
   * catalog for the official OpenAI Responses API, which this adapter does not
   * serve yet; declaring it is refused by name at resolution.
   */
  responsesEncryptedReplay?: boolean
}

/** One model a route serves, with the endpoint facts a request needs. */
export interface OwcModelProfile {
  /** Exact model id sent on the wire and named by `GenerateOptions.model`. */
  id: string
  /** Display name for selection surfaces; defaults to the id. */
  name?: string
  /** Context capacity in tokens; defaults to the route's `defaultContextWindow`. */
  contextWindow?: number
  /** Per-request output cap in tokens; defaults to the route's `defaultMaxTokens`. */
  maxTokens?: number
  /** Declared endpoint capabilities. */
  capabilities?: OwcModelCapabilities
  /**
   * Pixel budget every request image of this model is projected into, capping
   * `width * height`; `low` selects the published low-detail grid. Omission
   * keeps the source dimensions, still capped on the long edge.
   */
  imagePixelBudget?: number | 'low'
  /**
   * Encoded-byte target for one request image of this model. The encoder keeps
   * the smallest output of its quality ladder when no step fits.
   */
  imageMaxBytes?: number
}

/**
 * One provider endpoint. The `providers` dict key is the route name a request
 * selects with `GenerateOptions.provider`, and it is also what every
 * configuration surface shows unless `displayName` overrides the label.
 */
export interface OwcProviderProfile {
  /** Label shown by selection surfaces; defaults to the route key. */
  displayName?: string
  /** Whether the route registers at all; a disabled profile keeps its configuration but serves nothing. */
  enabled?: boolean
  /** Wire protocol every model on this route speaks. */
  interfaceType: InterfaceType
  /** Endpoint of every model on the route; the protocol's usual host applies when omitted. */
  baseURL?: string
  /** Credential reference resolved per request through the harness credential seam. */
  apiKeyEnv?: string
  /** Inline credential, for a profile imported verbatim from OWC; prefer `apiKeyEnv` on a managed deployment. */
  apiKey?: string
  /** Static request headers, for a gateway that routes by header. */
  headers?: Record<string, string>
  /** Whether the route may use prompt caching, where the protocol supports it. */
  promptCaching?: boolean
  /** Whether a chat-completions request asks the endpoint to report usage in the stream. */
  includeUsage?: boolean
  /** Extra top-level request-body fields, for endpoint-specific knobs. */
  extraBody?: Record<string, unknown>
  /** Concurrent requests this route serves before calls queue. */
  maxConcurrent?: number
  /** Maximum idle interval between two stream events for this route, in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Provider-owned retry policy executed by an agent-recovery plugin such as `dsh-llm-retry`. */
  retryPolicy?: RetryPolicyConfig
  /** Models this route serves; an empty list advertises nothing and serves only explicitly named ids. */
  models?: OwcModelProfile[]
  /** Context capacity for a route model that declares none. */
  defaultContextWindow?: number
  /** Output capability for a route model that declares none. */
  defaultMaxTokens?: number
  /**
   * Accumulated base64 image payload one request on this route carries before
   * the oldest occurrences must be offloaded. Default 20 MiB.
   */
  imageRequestMaxBytes?: number
  /** Image occurrences one request on this route carries. Default 600. */
  imageRequestMaxImages?: number
  /** Payload removed as one deterministic offload step. Default 10 MiB. */
  imageOffloadByteQuantum?: number
  /** Occurrences removed as one deterministic offload step. Default 20. */
  imageOffloadCountQuantum?: number
}

/**
 * Plugin configuration: the provider routes this instance owns. One document
 * describes every third-party endpoint this deployment reaches — which is the
 * whole of what the plugin does.
 */
export interface Config {
  /**
   * Provider profiles keyed by the route name a request selects. An empty or
   * omitted dict is the dormant posture: the adapter mounts with no routes and
   * registers them the moment a profile appears.
   */
  providers: Volatile<Record<string, OwcProviderProfile>>
}

/** Plain options accepted by the profile resolver. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

const capabilities: z<OwcModelCapabilities> = z.object({
  /** Accepted input modalities; omission means text only. */
  modalities: z.array(z.union(MODALITIES)),
  /** Accepted reasoning-effort levels. */
  effort: z.array(z.union(EFFORT_LEVELS)),
  /** Accepted thinking modes. */
  thinking: z.array(z.union(THINKING_MODES)),
  /** How this model's endpoint spells the thinking switch. */
  thinkingStyle: z.union(THINKING_STYLES),
  /** Whether prior reasoning may be replayed through `reasoning_content`. */
  reasoningContent: z.boolean(),
  /** Whether tool declarations may be sent to this model. */
  tools: z.boolean(),
  /** Whether the model returns images; refused until an image-output transport exists. */
  imageOutput: z.boolean(),
  /** Whether the endpoint replays signed reasoning; refused until the responses transport exists. */
  responsesEncryptedReplay: z.boolean(),
})

const modelProfile: z<OwcModelProfile> = z.object({
  /** Exact model id sent on the wire. */
  id: z.string().required(),
  /** Display name for selection surfaces; defaults to the id. */
  name: z.string(),
  /** Context capacity in tokens; defaults to the route's `defaultContextWindow`. */
  contextWindow: z.number().step(1).min(1),
  /** Per-request output cap in tokens; defaults to the route's `defaultMaxTokens`. */
  maxTokens: z.number().step(1).min(1),
  /** Declared endpoint capabilities. */
  capabilities,
  /** Pixel budget request images are projected into; `low` selects the low-detail grid. */
  imagePixelBudget: z.union([z.number().step(1).min(1), z.const('low')]),
  /** Encoded-byte target for one request image. */
  imageMaxBytes: z.number().step(1).min(1),
})

const providerProfile: z<OwcProviderProfile> = z.object({
  /** Label shown by selection surfaces; defaults to the route key. */
  displayName: z.string(),
  /** Whether the route registers at all. */
  enabled: z.boolean().default(true),
  /** Wire protocol every model on this route speaks. */
  interfaceType: z.union(INTERFACE_TYPES).required(),
  /** Endpoint of every model on the route. */
  baseURL: z.string(),
  /** Credential reference resolved per request through the harness credential seam. */
  apiKeyEnv: z.string().role('credential-ref'),
  /** Inline credential; prefer `apiKeyEnv` on a managed deployment. */
  apiKey: z.string().role('secret'),
  /** Static request headers. */
  headers: z.dict(z.string()),
  /** Whether the route may use prompt caching. */
  promptCaching: z.boolean(),
  /** Whether a chat-completions request asks the endpoint to report usage in the stream. */
  includeUsage: z.boolean(),
  /** Extra top-level request-body fields. */
  extraBody: z.dict(z.any()),
  /** Concurrent requests this route serves before calls queue. */
  maxConcurrent: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT),
  /** Maximum idle interval between two stream events for this route, in milliseconds. */
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Provider-owned retry policy executed by the agent's recovery layer. */
  retryPolicy: RetryPolicySchema,
  /** Models this route serves. */
  models: z.array(modelProfile),
  /** Context capacity for a route model that declares none. */
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  /** Output capability for a route model that declares none. */
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
})

/**
 * Runtime schema for {@link Options}. The DeepSeek channel's fields sit beside
 * the profiles because the built-in entry mounts this plugin under its own id:
 * one deployment may fill either, and the entry decides which channel answers.
 */
export const Config = z.object({
  /** Provider profiles keyed by the route name a request selects. */
  providers: z.dict(providerProfile).default({}).volatile(),
})
