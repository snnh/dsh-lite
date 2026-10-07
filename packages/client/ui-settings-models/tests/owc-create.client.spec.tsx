// @vitest-environment jsdom
/**
 * The OWC create path: how the page finds the namespace a provider is declared
 * in, what the create form asks for, and what it writes. The schema fixture is
 * declared here, as the page's own specs do, rather than imported from the
 * adapter: what the page reads is the serialized schema a settings namespace
 * carries, not the adapter package.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { OwcProviderCard } from '../src/client/OwcProviderCard.tsx'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore, deriveKeyRef, providerRoutes } from '../src/client/store.ts'
import { OWC_PRESETS, presetById } from '../src/client/owcPresets.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

/** The interface types the adapter's `Config` declares, in its own order. */
const INTERFACES = ['openai-chat-completions', 'anthropic-messages', 'openai-responses']

/** The route the fixture's OWC namespace already declares. */
const EXISTING = 'acme-gateway'

/** The OWC provider profile shape as the host serializes it. */
const OwcConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    displayName: Schema.string(),
    enabled: Schema.boolean().default(true),
    interfaceType: Schema.union(INTERFACES).required(),
    baseURL: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
  })),
})

/** The pi-ai profile shape, so both create modes are offered side by side. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseURL: Schema.string(),
  })),
})

/** A namespace this page knows nothing about. */
const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
})

function serialized(schema: { toJSON(): unknown }): JsonValue {
  return JSON.parse(JSON.stringify(schema.toJSON())) as JsonValue
}

/**
 * The OWC namespace under the entry id a deployment chose for it. The declared
 * interface types are the fixture's to narrow, so a schema that refuses a
 * preset's protocol can be mounted as-is.
 */
function owcNamespace(
  providers: Record<string, JsonValue> = { [EXISTING]: { interfaceType: 'openai-chat-completions' } },
  interfaces: readonly string[] = INTERFACES,
): SettingsNamespaceView {
  const config = interfaces === INTERFACES ? OwcConfig : Schema.object({
    providers: Schema.dict(Schema.object({
      displayName: Schema.string(),
      enabled: Schema.boolean().default(true),
      interfaceType: Schema.union([...interfaces]).required(),
      baseURL: Schema.string(),
      apiKeyEnv: Schema.string().role('credential-ref'),
      models: Schema.array(Schema.object({ id: Schema.string().required() })),
    })),
  })
  return {
    ns: 'llm-service-lite',
    schema: serialized(config),
    value: { providers },
    user: { providers },
    autoGenerate: true, applies: 'live',
    secrets: [],
    revision: 5,
  }
}

/** The mounted namespaces, with or without the OWC one. */
function wireNamespaces(
  options: { owc?: boolean; owcInterfaces?: readonly string[]; piAiRoutes?: boolean } = {},
): SettingsNamespaceView[] {
  const views: SettingsNamespaceView[] = [
    {
      ns: 'llm-deepseek',
      schema: serialized(DeepSeekConfig),
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      user: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 0,
    },
    {
      ns: 'llm-pi-ai',
      schema: serialized(PiAiConfig),
      value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-completions' } } },
      user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', api: 'openai-completions' } } },
      autoGenerate: true, applies: 'live',
      secrets: [],
      revision: 3,
    },
  ]
  if (options.owc ?? true) views.push(owcNamespace(undefined, options.owcInterfaces ?? INTERFACES))
  if (options.piAiRoutes === false) {
    // A fresh deployment: pi-ai is mounted but declares nothing, which is what
    // keeps its directory and its hand-declared form out of the card.
    const piAi = views.find(view => view.ns === 'llm-pi-ai')
    if (piAi !== undefined) views[views.indexOf(piAi)] = { ...piAi, value: { providers: {} }, user: { providers: {} } }
  }
  return views
}

/** Credentials answers over the Remote carrier, which has no envelope. */
function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

/** The codes this page's scripted Host answers refuse with. */
type RefusalCode = 'credential/rejected' | 'settings/conflict' | 'settings/rejected'

/** One refusal per code, each carrying the details its own code declares. */
const REFUSALS: { [Code in RefusalCode]: (message: string) => RemoteError<Code> } = {
  'credential/rejected': message => new RemoteError('credential/rejected', message, { ref: 'ACME_RELAY_API_KEY' }),
  'settings/conflict': message =>
    new RemoteError('settings/conflict', message, { ns: 'llm-service-lite', expected: 5, actual: 6 }),
  'settings/rejected': message => new RemoteError('settings/rejected', message, { ns: 'llm-service-lite' }),
}
function remoteFail(message: string, code: RefusalCode = 'settings/rejected') {
  return { ok: false as const, error: REFUSALS[code](message) }
}

interface WireOptions {
  mutate?: ReturnType<typeof vi.fn>
  set?: ReturnType<typeof vi.fn>
  /** Answer for the next `llm/discoverModels` call; the default discloses nothing. */
  discover?: ReturnType<typeof vi.fn>
}

/** The page's Host face over one namespace set, scripted down to what it reads. */
function scriptedFace(views: SettingsNamespaceView[], options: WireOptions = {}) {
  const mutate = options.mutate ?? vi.fn(() => Promise.resolve(remoteOk(owcNamespace())))
  const set = options.set ?? vi.fn(() => Promise.resolve(remoteOk(undefined)))
  const discover = options.discover ?? vi.fn(() => Promise.resolve(remoteOk([])))
  const face = {
    llm: {
      listProviders: vi.fn(() => Promise.resolve(remoteOk([
        { id: 'acme-gateway', name: 'Acme Gateway' },
        { id: 'openai', name: 'openai' },
      ]))),
      listConfigurableProviders: vi.fn(() => Promise.resolve(remoteOk([
        { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
        { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
        { provider: EXISTING, displayName: 'Acme Gateway', settingsNs: 'llm-service-lite', settingsPath: ['providers', EXISTING] },
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ]))),
      discoverModels: discover,
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: views }))),
      mutate,
    },
    credentials: {
      describe: vi.fn((refs: string[]) => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
      ))),
      set,
      unset: vi.fn(),
    },
  }
  return { face, mutate, set, discover }
}

type PageContext = ConstructorParameters<typeof ModelsSettingsStore>[0]

/**
 * The page plugin's context, scripted down to the namespaces the page reaches.
 * One context per face, as in production: an editor effect keyed by the context
 * would otherwise re-probe on every render.
 */
const contexts = new WeakMap<object, PageContext>()
function ctxWith(face: object): PageContext {
  const existing = contexts.get(face)
  if (existing !== undefined) return existing
  const ctx = Object.assign(new Context(), { remote: { ...face,
    session: { initializeDefaultModel: async () => ({ ok: true, value: undefined }) },
  } })
  contexts.set(face, ctx)
  return ctx
}

/** The cards' injected Host operations, bound once per face as the plugin body binds them. */
const operations = new WeakMap<object, ModelsOperations>()
function operationsWith(face: object): ModelsOperations {
  const existing = operations.get(face)
  if (existing !== undefined) return existing
  const bound = createModelsOperations(ctxWith(face))
  operations.set(face, bound)
  return bound
}

/** Mount the section over one scripted face. */
async function mountSection(
  options: { owc?: boolean; owcInterfaces?: readonly string[]; piAiRoutes?: boolean } & WireOptions = {},
) {
  const views = wireNamespaces(options)
  const scripted = scriptedFace(views, options)
  const ctx = ctxWith(scripted.face)
  const mirror = new SettingsDescribeMirror(ctx)
  const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await controller.load()
  const injected: ModelsSectionProps = {
    controller,
    useSnapshot: bindSnapshotSelector(controller.store),
    operations: operationsWith(scripted.face),
    schema: settingsSchema,
    t,
    renderSlot: () => null,
  }
  render(<ModelsSection {...injected} />)
  return { ...scripted, controller, mirror, views }
}

/** Open the add card and switch it to the OWC mode. */
function openOwcMode(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: en.add }))
  fireEvent.click(screen.getByRole('tab', { name: en.addOwc }))
  return screen.getByRole('tabpanel', { name: en.addOwc })
}

/** One labeled text input inside a scope. */
function input(scope: HTMLElement, label: string): HTMLInputElement {
  return within(scope).getByLabelText(label) as HTMLInputElement
}

/** One labeled select inside a scope. */
function select(scope: HTMLElement, label: string): HTMLSelectElement {
  return within(scope).getByLabelText(label) as HTMLSelectElement
}

/** The button carrying `label` inside a scope. */
function buttonNamed(scope: HTMLElement, label: string): HTMLButtonElement {
  return within(scope).getByRole<HTMLButtonElement>('button', { name: label })
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

describe('providerRoutes', () => {
  it('reads the route keys a namespace section declares', () => {
    const namespace = owcNamespace()
    expect(providerRoutes(namespace, settingsSchema)).toEqual([EXISTING])
    expect(providerRoutes(undefined, settingsSchema)).toEqual([])
    // A section whose `providers` is not a dict declares no route to shadow.
    expect(providerRoutes({ ...namespace, value: {} }, settingsSchema)).toEqual([])
    expect(providerRoutes({ ...namespace, value: { providers: [] } }, settingsSchema)).toEqual([])
  })
})

describe('owc create mode', () => {
  it('offers the mode while a mounted namespace declares an interface type', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    // The family is the schema's own declaration, not an entry id: nothing
    // names `llm-service-lite` on this page.
    const modes = screen.getByRole('tablist', { name: en.addMode })
    // The harness-managed way leads; the pi-ai ways follow it, because this
    // fixture already declares a pi-ai route.
    expect([...within(modes).getAllByRole('tab')].map(tab => tab.textContent))
      .toEqual([en.addOwc, en.addCatalog, en.addCustom])
    fireEvent.click(within(modes).getByRole('tab', { name: en.addOwc }))
    expect(screen.getByText(en.addOwcHint)).toBeTruthy()
    expect(screen.queryByText(en.addCustomHint)).toBeNull()
    expect(buttonNamed(screen.getByRole('tabpanel', { name: en.addOwc }), en.create).disabled).toBe(true)
  })

  it('offers the harness-managed way alone until a third-party route exists', async () => {
    // pi-ai is mounted but declares nothing: a deployment that never had a
    // third-party provider is offered this harness's own management alone, so
    // the card carries that mode as its title with no switch above it.
    await mountSection({ piAiRoutes: false })
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText(en.addCatalogHint)).toBeNull()
    expect(screen.getByText(en.addOwc)).toBeTruthy()
    expect(screen.getByText(en.addOwcHint)).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(en.owcInterfaceType)).toBeTruthy()
  })

  it('keeps the third-party ways once a pi-ai route is declared', async () => {
    await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const modes = screen.getByRole('tablist', { name: en.addMode })
    expect(within(modes).getByRole('tab', { name: en.addCatalog })).toBeTruthy()
    expect(within(modes).getByRole('tab', { name: en.addCustom })).toBeTruthy()
  })

  it('offers no OWC entry when no mounted namespace declares one', async () => {
    await mountSection({ owc: false })
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    const modes = screen.getByRole('tablist', { name: en.addMode })
    expect([...within(modes).getAllByRole('tab')].map(tab => tab.textContent))
      .toEqual([en.addCatalog, en.addCustom])
    expect(within(modes).queryByRole('tab', { name: en.addOwc })).toBeNull()
    expect(screen.queryByLabelText(en.owcInterfaceType)).toBeNull()
    expect(screen.queryByText(en.addOwcHint)).toBeNull()
  })

  it('shows the OWC form alone, titled by its mode, when it is the only way in', async () => {
    // Neither directory row is adoptable and pi-ai is not mounted at all, so
    // the OWC namespace is the one mode left: nothing switches, and the card
    // carries the mode as its title.
    const views = wireNamespaces().filter(view => view.ns !== 'llm-pi-ai')
    const scripted = scriptedFace(views)
    // No directory row is adoptable either, so the OWC namespace is the one
    // mode the card can offer.
    scripted.face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([]))
    const controller = new ModelsSettingsStore(ctxWith(scripted.face), settingsSchema, new SettingsDescribeMirror(ctxWith(scripted.face)))
    await controller.load()
    render(<ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      operations={operationsWith(scripted.face)}
      schema={settingsSchema}
      t={t}
      renderSlot={() => null}
    />)
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByText(en.addOwc)).toBeTruthy()
    expect(screen.getByText(en.addOwcHint)).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(en.owcInterfaceType)).toBeTruthy()
  })

  it('holds the add card open, with nothing to declare in, when a refresh takes every mode away', async () => {
    const { face, controller, mirror } = await mountSection()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    expect(screen.getByRole('tablist', { name: en.addMode })).toBeTruthy()
    // No OWC namespace, no pi-ai namespace, and no directory row left to adopt.
    face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces({ owc: false }).filter(view => view.ns !== 'llm-pi-ai'),
    }))
    face.llm.listConfigurableProviders.mockResolvedValue(remoteOk([]))
    await act(async () => {
      await mirror.load()
      await controller.load()
    })
    // The card falls back to the mode it started on rather than opening a
    // draft nothing can take, and mounts no panel for it.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByText(en.addCatalogHint)).toBeTruthy()
  })

  it('declares the provider under the route it names, with the key under the derived reference', async () => {
    const { face, mutate, set } = await mountSection()
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(select(panel, en.owcInterfaceType), { target: { value: 'anthropic-messages' } })
    fireEvent.change(input(panel, en.baseUrl), { target: { value: '  https://relay.acme.example  ' } })
    fireEvent.change(input(panel, en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(buttonNamed(panel, en.create))

    await waitFor(() => { expect(set).toHaveBeenCalledTimes(1) })
    // One write sets the whole profile at `providers.<route>`; the key travels
    // separately, under the reference the profile now records.
    expect(firstMutate(mutate)).toEqual({
      ns: 'llm-service-lite',
      ops: [{
        op: 'set',
        path: ['providers', 'acme-relay'],
        value: {
          interfaceType: 'anthropic-messages',
          baseURL: 'https://relay.acme.example',
          apiKeyEnv: 'ACME_RELAY_API_KEY',
        },
      }],
      // The revision of the section this draft was opened over.
      expectedRevision: 5,
    })
    expect(set).toHaveBeenCalledWith('ACME_RELAY_API_KEY', 'gw-key')
    // The card closes on success and the refreshed directory follows.
    await waitFor(() => { expect(screen.queryByRole('tablist')).toBeNull() })
    expect(face.llm.listProviders.mock.calls.length).toBeGreaterThan(1)
  })

  it('leaves the endpoint and the credential out of a profile that names neither', async () => {
    const { mutate, set } = await mountSection()
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.click(buttonNamed(panel, en.create))

    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    // The blank endpoint means the interface type's own default host, and the
    // blank key leaves the route its provider-native credential path.
    expect(firstMutate(mutate).ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-relay'],
      value: { interfaceType: 'openai-chat-completions' },
    }])
    expect(set).not.toHaveBeenCalled()
  })
})

describe('owc create form', () => {
  it('refuses a route id it cannot turn into a credential reference', async () => {
    await mountSection()
    const panel = openOwcMode()
    const route = input(panel, en.customRoute)
    expect(buttonNamed(panel, en.create).disabled).toBe(true)
    expect(screen.getByText(en.owcRouteHint)).toBeTruthy()

    fireEvent.change(route, { target: { value: '1acme' } })
    expect(screen.getByText(en.owcRouteInvalid)).toBeTruthy()
    expect(route.getAttribute('aria-invalid')).toBe('true')
    expect(buttonNamed(panel, en.create).disabled).toBe(true)

    // Every id the card admits derives a reference the credential seam takes.
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
    for (const id of ['acme', 'acme-relay', 'Acme.Gateway-1', 'a_b']) {
      fireEvent.change(route, { target: { value: id } })
      expect(screen.queryByText(en.owcRouteInvalid)).toBeNull()
      expect(buttonNamed(panel, en.create).disabled).toBe(false)
      expect(CREDENTIAL_REF.test(deriveKeyRef(id))).toBe(true)
    }
  })

  it.each([
    ['acme gateway', 'owcRouteInvalid'],
    ['acme/gateway', 'owcRouteInvalid'],
    [EXISTING, 'customRouteTaken'],
  ] as const)('refuses the route id %j with %s', async (id, copyKey) => {
    await mountSection()
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: id } })
    expect(screen.getByText(en[copyKey])).toBeTruthy()
    expect(buttonNamed(panel, en.create).disabled).toBe(true)
  })

  it('offers each interface type its own default endpoint, and refuses a non-HTTP one', async () => {
    await mountSection()
    const panel = openOwcMode()
    const endpoint = input(panel, en.baseUrl)
    expect(endpoint.placeholder).toBe(en.owcChatBaseUrlPlaceholder)
    expect([...select(panel, en.owcInterfaceType).options].map(option => option.textContent))
      .toEqual([en.protocolOpenAiChatCompletions, en.protocolAnthropicMessages, en.protocolOpenAiResponses])

    fireEvent.change(select(panel, en.owcInterfaceType), { target: { value: 'anthropic-messages' } })
    expect(endpoint.placeholder).toBe(en.owcAnthropicBaseUrlPlaceholder)

    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(endpoint, { target: { value: 'relay.acme.example' } })
    expect(screen.getByText(en.customBaseUrlInvalid)).toBeTruthy()
    expect(endpoint.getAttribute('aria-invalid')).toBe('true')
    expect(buttonNamed(panel, en.create).disabled).toBe(true)
  })

  it('judges the key field before the write, as every other create does', async () => {
    const { mutate } = await mountSection()
    const panel = openOwcMode()
    const key = input(panel, en.keyInput)
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    expect(key.placeholder).toBe(en.keyPlaceholder)

    fireEvent.change(key, { target: { value: '   ' } })
    expect(screen.getByText(en.keyBlankNew)).toBeTruthy()
    expect(buttonNamed(panel, en.create).disabled).toBe(true)

    fireEvent.change(key, { target: { value: 'sk-abc def' } })
    expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
    expect(buttonNamed(panel, en.create).disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('disables the form on a read-only deployment without hiding it', () => {
    // The section offers no add action when the settings document cannot take
    // a write; the card itself still renders what it cannot commit.
    const onClose = vi.fn()
    render(<OwcProviderCard
      namespace={owcNamespace()}
      taken={[EXISTING]}
      interfaces={INTERFACES}
      operations={operationsWith(scriptedFace(wireNamespaces()).face)}
      t={t}
      readOnly
      onClose={onClose}
    />)
    expect(screen.getByLabelText<HTMLInputElement>(en.customRoute).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLSelectElement>(en.owcInterfaceType).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.create }).disabled).toBe(true)
    // Cancel stays live: a card the deployment cannot write to is dismissable.
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('refuses to create an interface-type-less profile', () => {
    // A namespace whose schema declares the family without naming a member is
    // not one this page offers the mode for; the card refuses the write rather
    // than sending the empty string the adapter would reject.
    const onClose = vi.fn()
    render(<OwcProviderCard
      namespace={owcNamespace()}
      taken={[]}
      interfaces={[]}
      operations={operationsWith(scriptedFace(wireNamespaces()).face)}
      t={t}
      readOnly={false}
      onClose={onClose}
    />)
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-relay' } })
    expect(screen.getByLabelText<HTMLSelectElement>(en.owcInterfaceType).value).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.create }).disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reports a created provider when the card is dismissed after its profile landed', async () => {
    const onClose = vi.fn()
    // The profile write lands; the credential write is what fails, so the
    // fields are settled and the retry path is the credential alone.
    const set = vi.fn()
      .mockResolvedValueOnce(remoteFail('credential store unavailable'))
      .mockResolvedValueOnce(remoteOk(undefined))
    const scripted = scriptedFace(wireNamespaces(), { set })
    const mutate = vi.fn(() => Promise.resolve(remoteOk(owcNamespace())))
    const face = { ...scripted.face, settings: { ...scripted.face.settings, mutate } }
    render(<OwcProviderCard
      namespace={owcNamespace()}
      taken={[EXISTING]}
      interfaces={INTERFACES}
      operations={operationsWith(face)}
      t={t}
      readOnly={false}
      onClose={onClose}
    />)
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(screen.getByRole('button', { name: en.create }))

    await screen.findByText('credential store unavailable')
    expect(mutate).toHaveBeenCalledTimes(1)
    // The route exists now, so its id and endpoint are settled — retrying must
    // not re-run the write the Host would answer with a conflict.
    expect(screen.getByLabelText<HTMLInputElement>(en.baseUrl).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.create }))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(2) })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(true)
  })
})

describe('owc create failures', () => {
  it('names a write refused by a newer namespace revision', async () => {
    const mutate = vi.fn(() => Promise.resolve(remoteFail('changed since it was read', 'settings/conflict')))
    const { set } = await mountSection({ mutate })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(input(panel, en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(buttonNamed(panel, en.create))

    await screen.findByText(en.conflict)
    expect(set).not.toHaveBeenCalled()
    // The card stays open with the draft, so the user can act on the message.
    expect(screen.getByRole('tablist', { name: en.addMode })).toBeTruthy()
  })

  it('surfaces a refused write as the Host diagnostic', async () => {
    const mutate = vi.fn(() => Promise.resolve(remoteFail('llm-service-lite: unknown interface type')))
    const { set } = await mountSection({ mutate })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(input(panel, en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.click(buttonNamed(panel, en.create))

    await screen.findByText(/unknown interface type/)
    expect(set).not.toHaveBeenCalled()
  })

  it('holds the mode switch still while the create is in flight', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: SettingsNamespaceView }>()
    const mutate = vi.fn(() => pending.promise)
    await mountSection({ mutate })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.click(buttonNamed(panel, en.create))

    const tabs = screen.getByRole('tablist', { name: en.addMode })
    expect(within(tabs).getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(true)
    expect(within(tabs).getByRole<HTMLButtonElement>('tab', { name: en.addCustom }).disabled).toBe(true)

    await act(async () => {
      pending.resolve(remoteOk(owcNamespace()))
      await pending.promise
    })
    await waitFor(() => { expect(screen.queryByRole('tablist')).toBeNull() })
  })

  it('closes the add card on cancel without writing or reporting a change', async () => {
    const { face, mutate, set } = await mountSection()
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    const loads = face.llm.listProviders.mock.calls.length
    fireEvent.click(buttonNamed(panel, en.cancel))

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: en.add })).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    // Nothing was created, so nothing reloads the directory.
    expect(face.llm.listProviders.mock.calls.length).toBe(loads)
  })

  it('drops the OWC panel when its namespace disappears mid-card', async () => {
    const { face, controller, mirror } = await mountSection()
    openOwcMode()
    expect(screen.getByLabelText(en.owcInterfaceType)).toBeTruthy()
    face.settings.describe.mockResolvedValue(remoteOk({
      writable: true, hasDocument: false,
      namespaces: wireNamespaces({ owc: false }),
    }))
    // A namespace change reaches the page through the mirror's own refresh.
    await act(async () => {
      await mirror.load()
      await controller.load()
    })
    // Nothing can be declared any more, so the form is gone rather than left to
    // create a profile in a namespace that is not mounted.
    expect(screen.queryByRole('tabpanel', { name: en.addOwc })).toBeNull()
    expect(screen.queryByLabelText(en.owcInterfaceType)).toBeNull()
    expect(screen.queryByRole('tab', { name: en.addOwc })).toBeNull()
  })
})

describe('owcPresets', () => {
  /** The route rule the create form applies, so a preset id is created as-is. */
  const ROUTE = /^[A-Za-z][A-Za-z0-9._-]*$/

  it('offers only providers a create can declare as they stand', () => {
    expect(OWC_PRESETS.length).toBeGreaterThan(0)
    // Two presets sharing an id would collapse into one picker option.
    expect(new Set(OWC_PRESETS.map(preset => preset.id)).size).toBe(OWC_PRESETS.length)
    for (const preset of OWC_PRESETS) {
      expect(preset.id).toMatch(ROUTE)
      expect(preset.label.length).toBeGreaterThan(0)
      // A protocol the adapter does not declare would be refused on the write.
      expect(INTERFACES).toContain(preset.interfaceType)
      expect(['http:', 'https:']).toContain(new URL(preset.baseURL).protocol)
    }
    // The subscription endpoints are marked; the ordinary ones are not.
    expect(OWC_PRESETS.filter(preset => preset.codingPlan === true).length).toBeGreaterThan(0)
    expect(OWC_PRESETS.filter(preset => preset.codingPlan !== true).length).toBeGreaterThan(0)
  })

  it('finds a preset by its option value, and nothing for the empty choice', () => {
    expect(presetById('openrouter')?.label).toBe('OpenRouter')
    expect(presetById('')).toBeUndefined()
    expect(presetById('nonexistent')).toBeUndefined()
  })
})

describe('owc create presets', () => {
  it('fills the route, the protocol, and the endpoint from one choice', async () => {
    await mountSection()
    const panel = openOwcMode()
    const picker = select(panel, en.owcPreset)
    expect([...picker.options].map(option => option.textContent)).toEqual([
      en.owcPresetPick,
      ...OWC_PRESETS.map(preset => preset.codingPlan === true
        ? `${preset.label} · ${en.owcCodingPlan}`
        : preset.label),
    ])

    fireEvent.change(picker, { target: { value: 'openrouter' } })
    expect(input(panel, en.customRoute).value).toBe('openrouter')
    expect(select(panel, en.owcInterfaceType).value).toBe('openai-chat-completions')
    expect(input(panel, en.baseUrl).value).toBe('https://openrouter.ai/api/v1')
    // Everything the create cannot default is now answered but the key.
    expect(buttonNamed(panel, en.create).disabled).toBe(false)
  })

  it('leaves the declared protocol alone when the schema does not offer the preset one', async () => {
    await mountSection({ owcInterfaces: ['anthropic-messages'] })
    const panel = openOwcMode()
    expect([...select(panel, en.owcInterfaceType).options].map(option => option.value))
      .toEqual(['anthropic-messages'])

    fireEvent.change(select(panel, en.owcPreset), { target: { value: 'openrouter' } })
    // The endpoint is what the preset knows regardless; the protocol stays the
    // one this deployment declares rather than becoming an unofferable value.
    expect(input(panel, en.customRoute).value).toBe('openrouter')
    expect(input(panel, en.baseUrl).value).toBe('https://openrouter.ai/api/v1')
    expect(select(panel, en.owcInterfaceType).value).toBe('anthropic-messages')
  })

  it('returns to no choice without erasing the draft it filled', async () => {
    await mountSection()
    const panel = openOwcMode()
    const picker = select(panel, en.owcPreset)
    fireEvent.change(picker, { target: { value: 'anthropic' } })
    fireEvent.change(picker, { target: { value: '' } })

    expect(input(panel, en.customRoute).value).toBe('anthropic')
    expect(input(panel, en.baseUrl).value).toBe('https://api.anthropic.com')
  })
})

describe('owc create connection test', () => {
  it('asks the drafted endpoint and reports what it answered', async () => {
    const discover = vi.fn(() => Promise.resolve(remoteOk([{ id: 'gpt-a' }, { id: 'gpt-b' }])))
    await mountSection({ discover })
    const panel = openOwcMode()
    const probe = buttonNamed(panel, en.owcTestConnection)
    // An endpoint is what the question is about, so the button waits for one.
    expect(probe.disabled).toBe(true)
    expect(screen.getByText(en.owcProbeHint)).toBeTruthy()

    fireEvent.change(input(panel, en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(input(panel, en.baseUrl), { target: { value: 'https://relay.acme.example/v1' } })
    fireEvent.change(input(panel, en.keyInput), { target: { value: 'gw-key' } })
    expect(probe.disabled).toBe(false)
    fireEvent.click(probe)

    await screen.findByText(`${en.owcConnected} · 2 ${en.owcModelsFound}`)
    // The draft travels as a draft: the endpoint, the protocol, and a one-shot
    // key the harness never stores.
    expect(discover).toHaveBeenCalledWith('llm-service-lite', {
      baseURL: 'https://relay.acme.example/v1',
      api: 'openai-chat-completions',
      apiKey: 'gw-key',
    })
    expect(screen.getByText(new RegExp(`^${en.owcLatency} \\d+ ${en.owcMillis}$`))).toBeTruthy()
  })

  it('asks without credentials when the key field is blank', async () => {
    const discover = vi.fn(() => Promise.resolve(remoteOk([])))
    await mountSection({ discover })
    const panel = openOwcMode()
    fireEvent.change(select(panel, en.owcPreset), { target: { value: 'ollama' } })
    fireEvent.click(buttonNamed(panel, en.owcTestConnection))

    // A local server that publishes no catalog still answered the question.
    await screen.findByText(`${en.owcConnected} · 0 ${en.owcModelsFound}`)
    expect(discover).toHaveBeenCalledWith('llm-service-lite', {
      baseURL: 'http://localhost:11434/v1',
      api: 'openai-chat-completions',
    })
  })

  it('shows the Host diagnostic when the endpoint refuses the question', async () => {
    const discover = vi.fn(() => Promise.resolve(
      remoteFail('llm-service-lite: model listing failed (401): invalid key'),
    ))
    await mountSection({ discover })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.baseUrl), { target: { value: 'https://relay.acme.example/v1' } })
    fireEvent.click(buttonNamed(panel, en.owcTestConnection))

    await within(panel).findByText(/model listing failed \(401\)/)
    expect(screen.queryByText(`${en.owcConnected} · 0 ${en.owcModelsFound}`)).toBeNull()
    // Nothing was stored either way: the question is about the draft.
    expect(screen.getByRole('tabpanel', { name: en.addOwc })).toBeTruthy()
  })

  it('retires a report the moment the endpoint it describes is edited', async () => {
    const discover = vi.fn(() => Promise.resolve(remoteOk([{ id: 'gpt-a' }])))
    await mountSection({ discover })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.baseUrl), { target: { value: 'https://relay.acme.example/v1' } })
    fireEvent.click(buttonNamed(panel, en.owcTestConnection))
    await screen.findByText(`${en.owcConnected} · 1 ${en.owcModelsFound}`)

    // The report vouched for one address, so it cannot outlive it.
    fireEvent.change(input(panel, en.baseUrl), { target: { value: 'https://other.example/v1' } })
    expect(screen.queryByText(`${en.owcConnected} · 1 ${en.owcModelsFound}`)).toBeNull()
    expect(screen.getByText(en.owcProbeHint)).toBeTruthy()
  })

  it('holds the mode switch still while the question is in flight', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: { id: string }[] }>()
    const discover = vi.fn(() => pending.promise)
    await mountSection({ discover })
    const panel = openOwcMode()
    fireEvent.change(input(panel, en.baseUrl), { target: { value: 'https://relay.acme.example/v1' } })
    fireEvent.click(buttonNamed(panel, en.owcTestConnection))

    expect(buttonNamed(panel, en.owcTesting).disabled).toBe(true)
    const tabs = screen.getByRole('tablist', { name: en.addMode })
    expect(within(tabs).getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(true)

    await act(async () => {
      pending.resolve(remoteOk([{ id: 'gpt-a' }]))
      await pending.promise
    })
    expect(within(tabs).getByRole<HTMLButtonElement>('tab', { name: en.addCatalog }).disabled).toBe(false)
  })

  it('stops offering the question once the profile it described exists', async () => {
    const set = vi.fn().mockResolvedValue(remoteFail('credential store unavailable', 'credential/rejected'))
    const scripted = scriptedFace(wireNamespaces(), { set })
    render(<OwcProviderCard
      namespace={owcNamespace()}
      taken={[EXISTING]}
      interfaces={INTERFACES}
      operations={operationsWith(scripted.face)}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'acme-relay' } })
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'gw-key' } })
    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://relay.acme.example/v1' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.owcTestConnection }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.create }))

    await screen.findByText('credential store unavailable')
    // The route exists now, so the saved card's own test is the one to use.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.owcTestConnection }).disabled).toBe(true)
  })
})
