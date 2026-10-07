/**
 * The well-known providers OWC's own configuration surface offers as presets.
 *
 * A preset is an answer to the three questions a create asks that have a
 * published answer — which protocol the provider speaks and where — so that
 * picking one leaves only the API key to type. The list is data rather than
 * markup: it names no field, and a card reads it to fill its own draft.
 *
 * Two entries are the same provider under a coding-plan endpoint; the flag
 * only decides whether the picker marks the choice, because the endpoint
 * itself already carries the difference and the profile stores no plan.
 *
 * Labels are brand names and stay untranslated for the same reason the
 * protocol picker shows product names: a user looking for OpenRouter is
 * looking for that word.
 *
 * @module dsh-client-ui-settings-models/client/owcPresets
 */

/** One provider a create can start from. */
export interface OwcPreset {
  /**
   * Route id the preset suggests, and the picker's option value. It is a
   * legal route id — a letter first, then letters, digits, dots, dashes, and
   * underscores — because it is written into the route field verbatim and the
   * card judges that field with the same rule.
   */
  readonly id: string
  /** Brand name the option shows. */
  readonly label: string
  /** Protocol the provider speaks, as the adapter's schema spells it. */
  readonly interfaceType: string
  /** Endpoint the provider answers at. */
  readonly baseURL: string
  /** Whether the endpoint is the provider's subscription ("coding plan") one. */
  readonly codingPlan?: boolean
}

/** The presets, in the order the picker offers them: alphabetical by brand. */
export const OWC_PRESETS: readonly OwcPreset[] = [
  {
    id: 'dashscope',
    label: 'Alibaba DashScope',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    interfaceType: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
  },
  {
    id: 'qianfan',
    label: 'Baidu Qianfan',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://qianfan.baidubce.com/v2',
  },
  {
    // DeepSeek's own OpenAI-compatible API: the chat-completions protocol at
    // the `/v1` root it publishes, not the Responses API it does not serve.
    id: 'deepseek',
    label: 'DeepSeek',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://api.deepseek.com/v1',
  },
  {
    id: 'glm-coding',
    label: 'GLM',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    codingPlan: true,
  },
  {
    id: 'zhipu',
    label: 'GLM Standard',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: 'kimi-coding',
    label: 'Kimi',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://api.kimi.com/coding/v1',
    codingPlan: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    interfaceType: 'openai-chat-completions',
    baseURL: 'http://localhost:11434/v1',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    interfaceType: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'tencent',
    label: 'Tencent Cloud',
    interfaceType: 'openai-chat-completions',
    baseURL: 'https://tokenhub.tencentmaas.com/v1',
  },
]

/**
 * The preset one picker option stands for.
 * @param id - option value, which is the preset's route id.
 * @returns the preset, or undefined for the picker's own empty choice.
 */
export function presetById(id: string): OwcPreset | undefined {
  return OWC_PRESETS.find(preset => preset.id === id)
}
