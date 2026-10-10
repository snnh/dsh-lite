// @vitest-environment jsdom
/**
 * The OWC provider family: how a namespace is recognized as one, what its
 * profile card edits, the per-model capability bits, and the connection test.
 * The schema fixture is declared here, as the page's own specs do, rather than
 * imported from the adapter: what the card reads is the serialized schema a
 * settings namespace carries, not the adapter package.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { createModelsOperations } from '../src/client/operations.ts'
import { declaresInterfaceType, interfaceChoices, protocolChoices } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** The interface types the adapter's `Config` declares, in its own order. */
const INTERFACES = ['openai-chat-completions', 'anthropic-messages', 'openai-responses']

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const THINKING_MODES = ['adaptive', 'enabled', 'disabled']
const THINKING_STYLES = ['thinking', 'fixed', 'enable_thinking', 'effort_only']

/** The OWC provider profile shape as the host serializes it. */
const OwcConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    displayName: Schema.string(),
    enabled: Schema.boolean().default(true),
    interfaceType: Schema.union(INTERFACES).required(),
    baseURL: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    promptCaching: Schema.boolean(),
    includeUsage: Schema.boolean(),
    extraBody: Schema.dict(Schema.any()),
    maxConcurrent: Schema.number().step(1).min(1).default(3),
    streamIdleTimeoutMs: Schema.number().min(1).default(300_000),
    models: Schema.array(Schema.object({
      id: Schema.string().required(),
      name: Schema.string(),
      contextWindow: Schema.number().step(1).min(1),
      maxTokens: Schema.number().step(1).min(1),
      capabilities: Schema.object({
        modalities: Schema.array(Schema.union(['text', 'image', 'video'])),
        effort: Schema.array(Schema.union(EFFORT_LEVELS)),
        thinking: Schema.array(Schema.union(THINKING_MODES)),
        thinkingStyle: Schema.union(THINKING_STYLES),
        reasoningContent: Schema.boolean(),
        tools: Schema.boolean(),
        imageOutput: Schema.boolean(),
        responsesEncryptedReplay: Schema.boolean(),
      }),
    })),
    defaultContextWindow: Schema.number().step(1).min(1).default(262_144),
    defaultMaxTokens: Schema.number().step(1).min(1).default(8192),
  })),
})

/** The same family with nothing defaulted: an older or trimmed adapter schema. */
const BareOwcConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    interfaceType: Schema.union(INTERFACES).required(),
    baseURL: Schema.string(),
  })),
})

/** A pi-ai route profile: a protocol per route, and no interface type anywhere. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseURL: Schema.string(),
  })),
})

/** A namespace this page knows nothing about. */
const PlainConfig = Schema.object({ profiles: Schema.dict(Schema.object({ note: Schema.string() })) })

const OWC_SCHEMA = JSON.parse(JSON.stringify(OwcConfig.toJSON())) as JsonValue

/** The profile the default fixture stores: a chat-completions route with a reference. */
const PROFILE: Record<string, JsonValue> = {
  interfaceType: 'openai-chat-completions',
  baseURL: 'https://acme.test/v1',
  apiKeyEnv: 'ACME_API_KEY',
}

interface NamespaceOptions {
  /** Effective section (what the profile resolves to). */
  effective?: Record<string, JsonValue>
  /** User layer this page writes; defaults to the effective profile. */
  user?: Record<string, JsonValue>
  /** Composition layer beneath the user's. */
  base?: Record<string, JsonValue>
  ns?: string
  schema?: JsonValue
}

function owcNamespace(options: NamespaceOptions = {}): SettingsNamespaceView {
  const effective = options.effective ?? { acme: PROFILE }
  return {
    ns: options.ns ?? 'llm-service-lite',
    schema: options.schema ?? OWC_SCHEMA,
    value: { providers: effective },
    base: { providers: options.base ?? {} },
    user: { providers: options.user ?? effective },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 2,
  }
}

function plainNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-plain',
    schema: JSON.parse(JSON.stringify(PlainConfig.toJSON())) as JsonValue,
    value: { profiles: { plain: { note: 'x' } } },
    user: { profiles: { plain: { note: 'x' } } },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function piAiNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers: { openai: { api: 'openai-completions' } } },
    user: { providers: { openai: { api: 'openai-completions' } } },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}
/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

interface WireOptions {
  discover?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
}

/** The Host operations over one scripted face, bound as the plugin body binds them. */
function wireFor(namespace: SettingsNamespaceView, options: WireOptions = {}) {
  const discover = options.discover ?? vi.fn(() => Promise.resolve(ok([])))
  const mutate = options.mutate ?? vi.fn(() => Promise.resolve(remoteOk(namespace)))
  const set = options.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const ctx = Object.assign(new Context(), {
    remote: {
      llm: { discoverModels: discover },
      settings: { mutate },
      credentials: {
        describe: vi.fn((refs: string[]) => Promise.resolve(remoteOk(
          Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
        ))),
        set,
        unset: vi.fn(),
      },
    },
  })
  return { operations: createModelsOperations(ctx), discover, mutate, set }
}

interface EditorOptions extends NamespaceOptions, WireOptions {
  provider?: string
  settingsPath?: readonly string[]
  /** Open the customized fold; the default is to open it. */
  open?: boolean
}

/** Mount one provider card over a scripted wire face, with its fold open. */
function mountEditor(options: EditorOptions = {}) {
  const provider = options.provider ?? 'acme'
  const namespace = options.provider === undefined && options.ns === undefined
    ? owcNamespace(options)
    : owcNamespace({ ...options, effective: options.effective ?? { [provider]: PROFILE } })
  const wire = wireFor(namespace, options)
  const onClose = vi.fn()
  const onBusyChange = vi.fn()
  render(
    <ProviderEditor
      provider={provider}
      displayName="Acme"
      namespace={namespace}
      schema={settingsSchema}
      settingsPath={options.settingsPath ?? ['providers', provider]}
      operations={wire.operations}
      t={t}
      readOnly={false}
      onClose={onClose}
      onBusyChange={onBusyChange}
    />,
  )
  if (options.open ?? true) fireEvent.click(screen.getByText(en.customized))
  return { ...wire, namespace, onClose, onBusyChange }
}

/** Mount the OWC card of one profile. */
function mountOwc(options: EditorOptions = {}) {
  return mountEditor(options)
}

/** The settings write one card produced, as the scripted face recorded it. */
interface MutateCall {
  ns: string
  expectedRevision?: number
  ops: { op: string; path: string[]; value?: unknown }[]
}

/** The first recorded settings write, regrouped from the Remote signature. */
function firstMutate(mutate: ReturnType<typeof vi.fn>): MutateCall {
  const call = mutate.mock.calls[0] as [string, MutateCall['ops'], number | undefined] | undefined
  if (call === undefined) throw new Error('no settings write was recorded')
  const [ns, ops, expectedRevision] = call
  return { ns, ops, ...expectedRevision === undefined ? {} : { expectedRevision } }
}

/** The latest interrogation payload; fails the case when nothing was asked. */
function lastProbe(discover: ReturnType<typeof vi.fn>): unknown {
  const call = (discover.mock.calls as [string, Record<string, unknown>][]).at(-1)
  if (call === undefined) throw new Error('no interrogation was recorded')
  return { settingsNs: call[0], ...call[1] }
}

/** Open one model row's advanced fold, where capacities and capabilities live. */
function expandModel(index: number): void {
  fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} ${String(index)}`))
}

/** The button carrying `label`, typed so its disabled state is readable. */
function buttonNamed(label: string): HTMLButtonElement {
  const found = screen.getByText(label)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`"${label}" is not a button`)
  return found
}

/** One labeled text input. */
function textField(label: string): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label)
}

/** One labeled textarea. */
function areaField(label: string): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>(label)
}

/** One labeled dropdown. */
function selectField(label: string): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>(label)
}

describe('owc family detection', () => {
  it('reads the interface types and the family membership out of the namespace schema', () => {
    const namespace = owcNamespace()
    expect(interfaceChoices(namespace, settingsSchema)).toEqual(INTERFACES)
    expect(declaresInterfaceType(namespace, settingsSchema)).toBe(true)
    // An unwritable namespace has no schema to read, and a namespace that
    // declares no OWC profile is not one, whatever its entry id says.
    expect(interfaceChoices(undefined, settingsSchema)).toEqual([])
    expect(declaresInterfaceType(undefined, settingsSchema)).toBe(false)
    expect(declaresInterfaceType(plainNamespace(), settingsSchema)).toBe(false)
    // A route-protocol schema is a different family: pi-ai names `api`.
    const piAi = piAiNamespace()
    expect(declaresInterfaceType(piAi, settingsSchema)).toBe(false)
    expect(protocolChoices(piAi, settingsSchema)).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
    expect(interfaceChoices(piAi, settingsSchema)).toEqual([])
    expect(protocolChoices(namespace, settingsSchema)).toEqual([])
  })

  it.each(['llm-service-lite', 'team-gateways'])('edits the OWC profile of the entry id %s', (ns) => {
    // The entry id is a deployment's choice, so the family comes from the
    // schema alone.
    mountOwc({ ns })
    expect(selectField(en.owcInterfaceType)).toBeTruthy()
    expect(areaField(en.owcExtraBody)).toBeTruthy()
    expect(buttonNamed(en.owcTestConnection).disabled).toBe(false)
    expect(buttonNamed(en.apply).disabled).toBe(false)
  })

  it('keeps the pi-ai editor for a route protocol and the hint for anything else', () => {
    const piAi = piAiNamespace()
    const wire = wireFor(piAi)
    render(
      <ProviderEditor provider="openai" displayName="openai" declared namespace={piAi} schema={settingsSchema}
        settingsPath={['providers', 'openai']} operations={wire.operations} t={t} readOnly={false} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByText(en.customized))
    expect(selectField(en.customApi)).toBeTruthy()
    expect(screen.queryByLabelText(en.owcInterfaceType)).toBeNull()
    cleanup()

    const plain = plainNamespace()
    render(
      <ProviderEditor provider="plain" displayName="plain" namespace={plain} schema={settingsSchema}
        settingsPath={['profiles', 'plain']} operations={wireFor(plain).operations} t={t} readOnly={false}
        onClose={vi.fn()} />,
    )
    expect(screen.getByText(`${en.advancedHint} (llm-plain)`)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(screen.queryByLabelText(en.owcInterfaceType)).toBeNull()
  })
})

describe('owc profile fields', () => {
  it('writes the name, interface type, and endpoint as path ops', async () => {
    const { mutate } = mountOwc()
    expect(textField(en.baseUrl).value).toBe('https://acme.test/v1')
    expect(selectField(en.owcInterfaceType).value).toBe('openai-chat-completions')
    // The option labels are the product names, not the schema identifiers.
    expect([...selectField(en.owcInterfaceType).options].map(option => option.textContent))
      .toEqual([en.protocolOpenAiChatCompletions, en.protocolAnthropicMessages, en.protocolOpenAiResponses])

    fireEvent.change(textField(en.customDisplayName), { target: { value: 'Acme Gateway' } })
    fireEvent.change(selectField(en.owcInterfaceType), { target: { value: 'anthropic-messages' } })
    fireEvent.change(textField(en.baseUrl), { target: { value: 'https://acme.test/v2' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    const write = firstMutate(mutate)
    expect(write.ns).toBe('llm-service-lite')
    expect(write.expectedRevision).toBe(2)
    expect(write.ops).toHaveLength(3)
    expect(write.ops).toContainEqual({ op: 'set', path: ['providers', 'acme', 'displayName'], value: 'Acme Gateway' })
    expect(write.ops).toContainEqual({
      op: 'set', path: ['providers', 'acme', 'interfaceType'], value: 'anthropic-messages',
    })
    expect(write.ops).toContainEqual({ op: 'set', path: ['providers', 'acme', 'baseURL'], value: 'https://acme.test/v2' })
  })

  it('edits a route the adapter declares and nothing configures yet', () => {
    // The add flow opens the card over a route with no profile anywhere: every
    // field is blank, the route reads as enabled, and nothing is written until
    // the user says so.
    const { mutate } = mountOwc({ effective: {}, user: {} })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcEnabled }).checked).toBe(true)
    expect(selectField(en.owcInterfaceType).value).toBe('')
    expect(textField(en.baseUrl).value).toBe('')
    expect(textField(en.owcMaxConcurrent).value).toBe('')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('offers the composition name and endpoint as what a cleared field restores', () => {
    mountOwc({
      effective: { acme: { displayName: 'Acme (pinned)', baseURL: 'https://pinned.test/v1' } },
      user: {},
      base: { acme: { displayName: 'Acme (pinned)', baseURL: 'https://pinned.test/v1' } },
    })
    const name = textField(en.customDisplayName)
    expect(name.value).toBe('')
    expect(name.placeholder).toBe('Acme (pinned)')
    expect(textField(en.baseUrl).placeholder).toBe('https://pinned.test/v1')
    // Nothing names a protocol yet, so the select shows the unset choice
    // instead of reading as if the first one had been picked.
    const select = selectField(en.owcInterfaceType)
    expect(select.value).toBe('')
    expect([...select.options][0]?.textContent).toBe(en.customApiUnset)
  })

  it.each([
    ['openai-chat-completions', en.owcChatBaseUrlPlaceholder],
    ['anthropic-messages', en.owcAnthropicBaseUrlPlaceholder],
    ['openai-responses', en.owcChatBaseUrlPlaceholder],
  ])('offers the %s protocol its own default endpoint', (interfaceType, placeholder) => {
    mountOwc({ effective: { acme: { interfaceType } } })
    expect(textField(en.baseUrl).placeholder).toBe(placeholder)
  })

  it('unsets the name rather than storing whitespace', async () => {
    const { mutate } = mountOwc({ effective: { acme: { ...PROFILE, displayName: 'Acme Gateway' } } })
    fireEvent.change(textField(en.customDisplayName), { target: { value: '   ' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'displayName'] }])
  })

  it('stores a disabled route, and drops the key once it serves again', async () => {
    const { mutate } = mountOwc()
    // Absent means enabled: the adapter's own default is true.
    const enabled = screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcEnabled })
    expect(enabled.checked).toBe(true)
    fireEvent.click(enabled)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'set', path: ['providers', 'acme', 'enabled'], value: false }])
  })

  it('drops the disabled key rather than storing the default back', async () => {
    const { mutate } = mountOwc({ effective: { acme: { ...PROFILE, enabled: false } } })
    const enabled = screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcEnabled })
    expect(enabled.checked).toBe(false)
    fireEvent.click(enabled)
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'enabled'] }])
  })

  it('reads the flag a composition pinned rather than its own default', () => {
    mountOwc({
      effective: { acme: { interfaceType: 'openai-chat-completions', enabled: false } },
      user: {},
      base: { acme: { enabled: false } },
    })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcEnabled }).checked).toBe(false)
  })

  it('offers only the switches the chosen interface type has', () => {
    mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions' } } })
    expect(screen.getByRole('checkbox', { name: en.owcIncludeUsage })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: en.owcPromptCaching })).toBeNull()
    cleanup()

    mountOwc({ effective: { acme: { interfaceType: 'anthropic-messages' } } })
    expect(screen.getByRole('checkbox', { name: en.owcPromptCaching })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: en.owcIncludeUsage })).toBeNull()
    cleanup()

    mountOwc({ effective: { acme: { interfaceType: 'openai-responses' } } })
    expect(screen.queryByRole('checkbox', { name: en.owcPromptCaching })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: en.owcIncludeUsage })).toBeNull()
  })

  it('stores the caching switch, and clears it when it is unchecked', async () => {
    const stored = mountOwc({ effective: { acme: { interfaceType: 'anthropic-messages', promptCaching: true } } })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcPromptCaching }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.owcPromptCaching }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(stored.mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(stored.mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'promptCaching'] }])
    cleanup()

    const empty = mountOwc({ effective: { acme: { interfaceType: 'anthropic-messages' } } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.owcPromptCaching }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(empty.mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(empty.mutate).ops).toEqual([{ op: 'set', path: ['providers', 'acme', 'promptCaching'], value: true }])
  })

  it('stores and clears the usage switch of a chat-completions route', async () => {
    const stored = mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions', includeUsage: true } } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.owcIncludeUsage }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(stored.mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(stored.mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'includeUsage'] }])
    cleanup()

    const empty = mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions' } } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.owcIncludeUsage }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(empty.mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(empty.mutate).ops).toEqual([{ op: 'set', path: ['providers', 'acme', 'includeUsage'], value: true }])
  })
})

describe('owc extra request body', () => {
  it('shows the stored object as JSON and writes an edit back', async () => {
    const { mutate } = mountOwc({ effective: { acme: { ...PROFILE, extraBody: { temperature: 0.2 } } } })
    const body = areaField(en.owcExtraBody)
    expect(body.value).toBe('{\n  "temperature": 0.2\n}')

    fireEvent.change(body, { target: { value: '{"top_p":0.9}' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set', path: ['providers', 'acme', 'extraBody'], value: { top_p: 0.9 },
    }])
  })

  it('unsets the whole object when the field is emptied', async () => {
    const { mutate } = mountOwc({ effective: { acme: { ...PROFILE, extraBody: { temperature: 0.2 } } } })
    fireEvent.change(areaField(en.owcExtraBody), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'extraBody'] }])
  })

  it.each([
    ['not json at all', 'owcExtraBodyInvalid'],
    ['[]', 'owcExtraBodyInvalid'],
    ['{"tools":[]}', 'owcExtraBodyReserved'],
    ['{"messages":[]}', 'owcExtraBodyReserved'],
  ] as const)('refuses %j with %s and holds the write', (text, copyKey) => {
    const { mutate } = mountOwc()
    fireEvent.change(areaField(en.owcExtraBody), { target: { value: text } })
    expect(screen.getByText(en[copyKey])).toBeTruthy()
    expect(areaField(en.owcExtraBody).getAttribute('aria-invalid')).toBe('true')
    expect(buttonNamed(en.apply).disabled).toBe(true)
    // The refusal is the card's own: nothing is sent to learn it.
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('owc numeric limits', () => {
  it('shows the adapter defaults as inherited placeholders', () => {
    mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions' } }, schema: OWC_SCHEMA })
    expect(textField(en.owcMaxConcurrent).placeholder).toBe('3')
    expect(textField(en.owcStreamIdleTimeout).placeholder).toBe('300000')
    expect(textField(en.owcDefaultContextWindow).placeholder).toBe('262144')
    expect(textField(en.owcDefaultMaxTokens).placeholder).toBe('8192')
  })

  it('shows a composition-pinned default, and nothing when nothing supplies one', () => {
    mountOwc({
      effective: { acme: { interfaceType: 'openai-chat-completions' } },
      user: {},
      base: { acme: { maxConcurrent: 5 } },
    })
    expect(textField(en.owcMaxConcurrent).placeholder).toBe('5')
    cleanup()

    // A schema that defaults none of them leaves the placeholder blank rather
    // than inventing a number the adapter never declared.
    mountOwc({
      effective: { acme: { interfaceType: 'openai-chat-completions' } },
      schema: JSON.parse(JSON.stringify(BareOwcConfig.toJSON())) as JsonValue,
    })
    expect(textField(en.owcMaxConcurrent).placeholder).toBe('')
    expect(textField(en.owcDefaultMaxTokens).placeholder).toBe('')
  })

  it('stores a typed count and unsets an emptied one', async () => {
    const { mutate } = mountOwc({ effective: { acme: { ...PROFILE, maxConcurrent: 8 } } })
    expect(textField(en.owcMaxConcurrent).value).toBe('8')
    fireEvent.change(textField(en.owcMaxConcurrent), { target: { value: ' 2 ' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'set', path: ['providers', 'acme', 'maxConcurrent'], value: 2 }])
    cleanup()

    const cleared = mountOwc({ effective: { acme: { ...PROFILE, maxConcurrent: 8 } } })
    fireEvent.change(textField(en.owcMaxConcurrent), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(cleared.mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(cleared.mutate).ops).toEqual([{ op: 'unset', path: ['providers', 'acme', 'maxConcurrent'] }])
  })

  it.each(['abc', '0', '1.5'])('refuses %j in place and holds the write', (text) => {
    const { mutate } = mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions' } } })
    fireEvent.change(textField(en.owcMaxConcurrent), { target: { value: text } })
    // The text stays on screen; only the write is refused.
    expect(textField(en.owcMaxConcurrent).value).toBe(text)
    expect(screen.getByText(en.owcNumberInvalid)).toBeTruthy()
    expect(buttonNamed(en.apply).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('owc connection test', () => {
  it('reports what the endpoint disclosed, naming the route and the shown endpoint', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'acme-large' }, { id: 'acme-small' }])))
    const { onBusyChange } = mountOwc({ discover })
    fireEvent.click(screen.getByText(en.owcTestConnection))

    await screen.findByText(`${en.owcConnected} · 2 ${en.owcModelsFound}`)
    expect(lastProbe(discover)).toEqual({
      settingsNs: 'llm-service-lite',
      provider: 'acme',
      baseURL: 'https://acme.test/v1',
    })
    // The host holds its own surface still while the answer is outstanding.
    expect(onBusyChange).toHaveBeenCalledWith(true)
  })

  it('asks by route alone when the form names no endpoint', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([])))
    mountOwc({ discover, effective: { acme: { interfaceType: 'openai-chat-completions' } } })
    fireEvent.click(screen.getByText(en.owcTestConnection))
    await screen.findByText(`${en.owcConnected} · 0 ${en.owcModelsFound}`)
    expect(lastProbe(discover)).toEqual({ settingsNs: 'llm-service-lite', provider: 'acme' })
  })

  it('reports a refusal as its own diagnostic', async () => {
    const discover = vi.fn(() => Promise.resolve({
      ok: false as const,
      error: new RemoteError('llm/model-discovery-rejected', 'https://acme.test/v1/models answered 401', {
        settingsNs: 'llm-service-lite',
      }),
    }))
    mountOwc({ discover })
    fireEvent.click(screen.getByText(en.owcTestConnection))
    await screen.findByText(/answered 401/)
    expect(screen.queryByText(content => content.includes(en.owcConnected))).toBeNull()
  })

  it('holds the action while the request is in flight', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: { id: string }[] }>()
    const discover = vi.fn(() => pending.promise)
    mountOwc({ discover })
    fireEvent.click(screen.getByText(en.owcTestConnection))

    expect(buttonNamed(en.owcTesting).disabled).toBe(true)
    expect(screen.queryByText(en.owcTestConnection)).toBeNull()

    pending.resolve(ok([{ id: 'acme-large' }]))
    await screen.findByText(`${en.owcConnected} · 1 ${en.owcModelsFound}`)
    expect(buttonNamed(en.owcTestConnection).disabled).toBe(false)
  })
})

describe('owc model capabilities', () => {
  const declared = (capabilities: JsonValue, id = 'm'): Record<string, JsonValue> => ({
    ...PROFILE,
    models: [{ id, capabilities }],
  })

  it('edits the capability bits of one row, keeping the ones it does not cover', async () => {
    const { mutate } = mountOwc({
      effective: { acme: declared({ modalities: ['text'], thinkingStyle: 'fixed', reasoningContent: true }) },
    })
    expandModel(1)

    const effort = within(screen.getByRole('group', { name: `${en.owcEffort} 1` }))
    expect(effort.getAllByRole<HTMLInputElement>('checkbox').every(box => !box.checked)).toBe(true)
    expect(selectField(`${en.owcThinkingStyle} 1`).value).toBe('fixed')
    const reasoning = screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcReasoningContent })
    expect(reasoning.checked).toBe(true)

    fireEvent.click(effort.getByRole('checkbox', { name: 'high' }))
    fireEvent.click(effort.getByRole('checkbox', { name: 'low' }))
    fireEvent.click(within(screen.getByRole('group', { name: `${en.owcThinking} 1` }))
      .getByRole('checkbox', { name: en.owcThinkingAdaptive }))
    fireEvent.change(selectField(`${en.owcThinkingStyle} 1`), { target: { value: 'enable_thinking' } })
    fireEvent.click(reasoning)
    fireEvent.click(reasoning)
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
      .getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // The adapter's own order, not the click order, and the capability keys
    // this page does not edit survive beside the ones it does.
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme', 'models'],
      value: [{
        id: 'm',
        capabilities: {
          modalities: ['text', 'image'],
          thinkingStyle: 'enable_thinking',
          reasoningContent: true,
          effort: ['low', 'high'],
          thinking: ['adaptive'],
        },
      }],
    }])
  })

  it('writes an explicit reasoning-replay answer', async () => {
    const { mutate } = mountOwc({ effective: { acme: declared({ reasoningContent: true }) } })
    expandModel(1)
    fireEvent.change(selectField(`${en.owcReasoningReplay} 1`), { target: { value: 'off' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    const written = firstMutate(mutate).ops[0] as unknown as { value: Array<{ capabilities: Record<string, unknown> }> }
    expect(written.value[0]?.capabilities).toMatchObject({ reasoningContent: true, replayReasoning: false })
  })

  it('drops the replay answer for the model family to decide', async () => {
    const { mutate } = mountOwc({ effective: { acme: declared({ replayReasoning: true }) } })
    expandModel(1)
    fireEvent.change(selectField(`${en.owcReasoningReplay} 1`), { target: { value: '' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    const cleared = firstMutate(mutate).ops[0] as unknown as { value: Array<Record<string, unknown>> }
    // The model keeps no empty capabilities object either: the family's answer
    // is what the absence of the key means.
    expect(cleared.value[0]).not.toHaveProperty('capabilities.replayReasoning')
    expect(cleared.value[0]?.['capabilities'] ?? {}).not.toHaveProperty('replayReasoning')
  })

  it('shows the whole capability vocabulary the adapter declares', () => {
    mountOwc({ effective: { acme: declared({}) } })
    expandModel(1)
    // Thinking modes are named by what they do, as OWC labels them.
    const thinking = within(screen.getByRole('group', { name: `${en.owcThinking} 1` }))
    for (const label of [en.owcThinkingAdaptive, en.owcThinkingEnabled, en.owcThinkingDisabled]) {
      expect(thinking.getByRole('checkbox', { name: label })).toBeTruthy()
    }
    // The switch an endpoint accepts, with the adapter's own default first.
    expect([...selectField(`${en.owcThinkingStyle} 1`).options].map(option => option.textContent))
      .toEqual([en.owcThinkingStyleUnset, en.owcStyleThinking, en.owcStyleEnableThinking, en.owcStyleEffortOnly, en.owcStyleFixed])
    // Effort levels stay as the wire spells them: a gateway with its own
    // vocabulary declares that vocabulary.
    const effort = within(screen.getByRole('group', { name: `${en.owcEffort} 1` }))
    for (const level of EFFORT_LEVELS) expect(effort.getByRole('checkbox', { name: level })).toBeTruthy()
    // Input types come from the shared editor this family hands a wider
    // vocabulary to, and the boxes beyond it say what the adapter refuses.
    const inputs = within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
    for (const label of [en.modelInputText, en.modelInputImage, en.modelInputVideo]) {
      expect(inputs.getByRole('checkbox', { name: label })).toBeTruthy()
    }
    for (const label of [en.owcImageOutput, en.owcTools, en.owcReasoningContent, en.owcEncryptedReplay]) {
      expect(screen.getByRole('checkbox', { name: label })).toBeTruthy()
    }
    // Reasoning replay is a three-state answer: the family decides by default,
    // and either explicit answer is available.
    expect([...selectField(`${en.owcReasoningReplay} 1`).options].map(option => option.textContent))
      .toEqual([en.owcReplayFamily, en.owcReplayOn, en.owcReplayOff])
    // Tools are sent unless the model turns them off, so that box opens set.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcTools }).checked).toBe(true)
  })

  it('says how a declared video input travels, where the declaration is made', async () => {
    mountOwc({ effective: { acme: declared({}) } })
    expandModel(1)
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
      .getByRole('checkbox', { name: en.modelInputVideo }))
    expect(screen.getByText(en.owcVideoAsFile)).toBeTruthy()
  })

  it('turns tool declarations off explicitly, and back to the adapter default', async () => {
    const { mutate } = mountOwc({ effective: { acme: declared({}) } })
    expandModel(1)
    const tools = screen.getByRole<HTMLInputElement>('checkbox', { name: en.owcTools })
    fireEvent.click(tools)
    expect(tools.checked).toBe(false)
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // `tools` defaults to true, so turning it off is what the key records.
    expect((firstMutate(mutate).ops[0]?.value as { capabilities?: { tools?: boolean } }[])[0]?.capabilities?.tools)
      .toBe(false)
  })

  it('drops a capability key, and its container, when the last member goes', async () => {
    const { mutate } = mountOwc({ effective: { acme: declared({ effort: ['high'] }) } })
    expandModel(1)
    fireEvent.click(within(screen.getByRole('group', { name: `${en.owcEffort} 1` }))
      .getByRole('checkbox', { name: 'high' }))
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // An empty array would claim the capability exists with nothing to choose.
    expect(firstMutate(mutate).ops[0]?.value).toEqual([{ id: 'm' }])
  })

  it('unsets the thinking switch and rewrites the modalities a row stops declaring', async () => {
    const { mutate } = mountOwc({ effective: { acme: declared({ thinkingStyle: 'fixed', modalities: ['text', 'image'] }) } })
    expandModel(1)
    fireEvent.change(selectField(`${en.owcThinkingStyle} 1`), { target: { value: '' } })
    fireEvent.click(within(screen.getByRole('group', { name: `${en.modelInputTypes} 1` }))
      .getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([{
      id: 'm',
      capabilities: { modalities: ['text'] },
    }])
  })

  it('adds, edits, and adopts OWC models through the same list', async () => {
    const discover = vi.fn(() => Promise.resolve(ok([{ id: 'acme-large', contextWindow: 65_536 }])))
    const { mutate } = mountOwc({ discover, effective: { acme: { interfaceType: 'openai-chat-completions', baseURL: 'https://acme.test/v1' } } })
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(textField(`${en.modelId} 1`), { target: { value: 'manual' } })
    expandModel(1)
    fireEvent.change(textField(`${en.contextWindow} 1`), { target: { value: '4096' } })
    fireEvent.change(textField(`${en.modelName} 1`), { target: { value: 'Manual' } })

    fireEvent.click(screen.getByText(en.fetchModels))
    await screen.findByText(en.fetchTitle)
    fireEvent.click(screen.getByText(en.fetchAdopt))
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops[0]?.value).toEqual([
      { id: 'manual', name: 'Manual', contextWindow: 4096 },
      { id: 'acme-large', contextWindow: 65_536 },
    ])
    // The route names itself, and the endpoint the form shows travels with it.
    expect(lastProbe(discover)).toEqual({
      settingsNs: 'llm-service-lite',
      provider: 'acme',
      baseURL: 'https://acme.test/v1',
    })
  })
})

describe('owc credentials', () => {
  it('derives the reference for a route that names none when a key is stored', async () => {
    const { mutate, set } = mountOwc({ effective: { acme: { interfaceType: 'openai-chat-completions' } } })
    fireEvent.change(textField(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(set).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toContainEqual({
      op: 'set', path: ['providers', 'acme', 'apiKeyEnv'], value: 'ACME_API_KEY',
    })
    expect(set).toHaveBeenCalledWith('ACME_API_KEY', 'gw-key')
  })

  it('keeps the profile as it stands when a key is left blank', async () => {
    const { mutate, set } = mountOwc()
    fireEvent.change(textField(en.baseUrl), { target: { value: 'https://acme.test/v2' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(firstMutate(mutate).ops).toEqual([{ op: 'set', path: ['providers', 'acme', 'baseURL'], value: 'https://acme.test/v2' }])
    expect(set).not.toHaveBeenCalled()
  })
})
