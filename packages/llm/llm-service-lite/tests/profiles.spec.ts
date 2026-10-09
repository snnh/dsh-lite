import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { assertServiceable, modelOf, registrationFacts, resolveProfiles, serviceableRoutes } from '../src/profiles.ts'
import type { Options } from '../src/config.ts'

/** One route declaration through the real schema, with the caller's fields layered on. */
const configured = (profile: Record<string, unknown>): Options['providers'] =>
  Config({
    providers: {
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test/v1',
        ...profile,
      },
    },
  }).providers.get() as unknown as Options['providers']

/** Resolve one route declaration and return it, failing the test when it is refused. */
const resolved = (profile: Record<string, unknown>) => {
  const profiles = resolveProfiles(configured(profile))
  const entry = profiles.get('gateway')
  if (entry === undefined) throw new Error('the route did not resolve')
  return entry
}

describe('profile resolution', () => {
  it('materializes route and model defaults', () => {
    const profile = resolved({ models: [{ id: 'm' }] })
    expect(profile).toMatchObject({
      provider: 'gateway',
      displayName: 'gateway',
      enabled: true,
      baseURL: 'https://gateway.test/v1',
      maxConcurrent: 3,
      includeUsage: false,
      promptCaching: false,
      diagnostic: undefined,
    })
    expect(profile.models[0]).toMatchObject({
      id: 'm',
      name: 'm',
      contextWindow: 256_000,
      maxTokens: 8_192,
      modalities: ['text'],
      effort: [],
      thinking: [],
      reasoningContent: false,
    })
  })

  it('applies the protocol endpoint default and the profile display name', () => {
    const profile = resolved({ displayName: 'Acme', baseURL: undefined })
    expect(profile.baseURL).toBe('https://api.openai.com/v1')
    expect(profile.displayName).toBe('Acme')
  })

  it('keeps a disabled route addressable without registering it', () => {
    const profiles = resolveProfiles(configured({ enabled: false, models: [{ id: 'm' }] }))
    expect(serviceableRoutes(profiles)).toEqual([])
    expect(registrationFacts(profiles)).toEqual([])
    expect(profiles.get('gateway')?.enabled).toBe(false)
  })

  it('resolves an unlisted model from the route defaults', () => {
    const profile = resolved({ defaultContextWindow: 4096, defaultMaxTokens: 512, models: [{ id: 'known', contextWindow: 8192 }] })
    // A declared model keeps its own capacity; the route default fills only
    // the models that declare none, including ids the profile never lists.
    expect(modelOf(profile, 'known').contextWindow).toBe(8192)
    expect(modelOf(profile, 'known').maxTokens).toBe(512)
    expect(modelOf(profile, 'unknown')).toMatchObject({ contextWindow: 4096, maxTokens: 512, modalities: ['text'] })
  })

  it('reports route facts that compare by value and ignore configuration order', () => {
    const first = registrationFacts(resolveProfiles({
      b: { interfaceType: 'openai-chat-completions', baseURL: 'https://b.test' },
      a: { interfaceType: 'openai-chat-completions', baseURL: 'https://a.test' },
    }))
    const reordered = registrationFacts(resolveProfiles({
      a: { interfaceType: 'openai-chat-completions', baseURL: 'https://a.test' },
      b: { interfaceType: 'openai-chat-completions', baseURL: 'https://b.test' },
    }))
    expect(first).toEqual(reordered)
  })
})

describe('profile validation', () => {
  const refused = (profile: Record<string, unknown>): string => {
    try {
      resolveProfiles(configured(profile))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('the profile was accepted')
  }

  it('refuses a profile that names no protocol', () => {
    expect(() => resolveProfiles({ gateway: {} as never })).toThrow(/interfaceType/)
  })

  it('refuses an array-shaped providers section', () => {
    expect(() => resolveProfiles([] as never)).toThrow(/dict keyed by provider route/)
  })

  it('refuses an empty or malformed endpoint', () => {
    expect(refused({ baseURL: '' })).toMatch(/empty baseURL/)
    expect(refused({ baseURL: 'ftp://gateway.test' })).toMatch(/http or https/)
  })

  it('refuses a credential named twice', () => {
    expect(refused({ apiKeyEnv: 'KEY', apiKey: 'sk-live' })).toMatch(/both apiKeyEnv and apiKey/)
  })

  it('refuses a capability the named protocol cannot carry', () => {
    expect(refused({ promptCaching: true })).toMatch(/promptCaching on interfaceType/)
    expect(refused({ interfaceType: 'anthropic-messages', includeUsage: true })).toMatch(/includeUsage on interfaceType/)
  })

  it('serves every protocol the vocabulary declares', () => {
    // A vocabulary entry without a transport would be a protocol a deployment
    // could declare and no request could carry; the transport table is typed
    // over these names, so each one resolves and reaches a wire.
    for (const interfaceType of ['openai-chat-completions', 'anthropic-messages', 'openai-responses'] as const) {
      const profile = resolveProfiles({
        gateway: { interfaceType, baseURL: 'https://gateway.test', models: [{ id: 'm' }] },
      }).get('gateway')
      expect(profile?.interfaceType).toBe(interfaceType)
      expect(profile?.diagnostic).toBeUndefined()
    }
  })

  it('refuses a reserved or non-JSON extra body field', () => {
    expect(refused({ extraBody: { messages: [] } })).toMatch(/reserved field "messages"/)
    // The schema refuses a function before resolution ever sees it; the
    // resolution-time rule covers a profile built by other means (an import,
    // or a test double), so it is exercised directly.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test',
        extraBody: { temperature: () => 0 },
      } as never,
    })).toThrow(/not a JSON value/)
    expect(() => resolveProfiles({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test', extraBody: { tools: [] } },
    })).toThrow(/reserved field "tools"/)
  })

  it('refuses a header Fetch cannot send', () => {
    expect(refused({ headers: { 'bad header': 'value' } })).toMatch(/not valid for Fetch/)
  })

  it('refuses duplicate and invalid model entries', () => {
    expect(refused({ models: [{ id: 'm' }, { id: 'm' }] })).toMatch(/declares model "m" twice/)
    expect(refused({ models: [{ id: '' }] })).toMatch(/empty id/)
    expect(refused({ models: [{ id: 'm', name: '' }] })).toMatch(/empty name/)
    // The schema owns the modality vocabulary; resolution re-checks it for a
    // profile that reached it another way.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test',
        models: [{ id: 'm', capabilities: { modalities: ['audio'] } }],
      } as never,
    })).toThrow(/unknown modality/)
  })

  it('carries image input with the model pixel budget it declares', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { modalities: ['text', 'image'] }, imagePixelBudget: 'low' }] })
    const model = modelOf(profile, 'm')
    expect(model.modalities).toEqual(['text', 'image'])
    expect(model.imagePixelBudget).toBe(512 * 512)
    expect(model.imageMaxBytes).toBeUndefined()
  })

  it('carries a numeric pixel budget and an explicit byte target unchanged', () => {
    const profile = resolved({
      models: [{ id: 'm', capabilities: { modalities: ['image'] }, imagePixelBudget: 1024 * 1024, imageMaxBytes: 1024 }],
    })
    const model = modelOf(profile, 'm')
    expect(model.imagePixelBudget).toBe(1024 * 1024)
    expect(model.imageMaxBytes).toBe(1024)
  })

  it('resolves the route image request budget with its published defaults', () => {
    const profile = resolved({})
    expect(profile.imageRequestBudget).toEqual({
      representation: 'base64',
      maxBytes: 20 * 1024 * 1024,
      maxImages: 600,
      byteQuantum: 10 * 1024 * 1024,
      countQuantum: 20,
    })
  })

  it('takes the route image request budget from the profile', () => {
    const profile = resolved({
      imageRequestMaxBytes: 4096, imageRequestMaxImages: 2, imageOffloadByteQuantum: 512, imageOffloadCountQuantum: 1,
    })
    expect(profile.imageRequestBudget).toMatchObject({ maxBytes: 4096, maxImages: 2, byteQuantum: 512, countQuantum: 1 })
  })

  it('refuses an image knob on a model that declares no image input', () => {
    expect(refused({ models: [{ id: 'm', imagePixelBudget: 512 * 512 }] })).toMatch(/without declaring image input/)
    expect(refused({ models: [{ id: 'm', imageMaxBytes: 1024 }] })).toMatch(/without declaring image input/)
  })

  it('refuses the other declared modalities the transport does not carry', () => {
    // OWC's vocabulary names video as well; this wire has no video part, so the
    // declaration is refused rather than accepted with nothing acting on it.
    expect(refused({ models: [{ id: 'm', capabilities: { modalities: ['video'] } }] })).toMatch(/declares video input/)
  })

  it('refuses an image-output declaration the transports cannot serve', () => {
    expect(refused({ models: [{ id: 'm', capabilities: { imageOutput: true } }] })).toMatch(/declares image output/)
  })

  it('carries a signed-replay declaration, which the responses transport honours', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { responsesEncryptedReplay: true } }] })
    expect(profile.models[0]?.encryptedReplay).toBe(true)
    expect(resolved({ models: [{ id: 'm' }] }).models[0]?.encryptedReplay).toBe(false)
  })

  it('defaults tool declarations on, and carries a model that turns them off', () => {
    const profile = resolved({ models: [{ id: 'plain', capabilities: { tools: false } }, { id: 'full' }] })
    expect(profile.models.map(model => model.tools)).toEqual([false, true])
  })

  it('accepts effort_only as the explicit spelling of a switchless endpoint', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { thinkingStyle: 'effort_only' } }] })
    expect(profile.models[0]?.thinkingStyle).toBe('effort_only')
  })

  it('keeps an unserviceable stored route with a diagnostic instead of throwing', () => {
    const profiles = resolveProfiles({ gateway: { interfaceType: 'openai-chat-completions', baseURL: 'not a url' } }, 'deferred')
    const profile = profiles.get('gateway')
    expect(profile?.diagnostic).toMatch(/not a URL/)
    expect(serviceableRoutes(profiles)).toEqual([])
    expect(registrationFacts(profiles)).toEqual([])
  })

  it('re-validates only the profiles a write touches', () => {
    const previous: Options = { providers: { stored: { interfaceType: 'openai-chat-completions', baseURL: 'not a url' } } }
    expect(() => { assertServiceable({ providers: { ...previous.providers } }, previous) }).not.toThrow()
    expect(() => { assertServiceable({ providers: { ...previous.providers, added: { interfaceType: 'openai-chat-completions', baseURL: 'https://ok.test' } } }, previous) }).not.toThrow()
    expect(() => { assertServiceable({ providers: { ...previous.providers, changed: { interfaceType: 'openai-chat-completions', baseURL: '' } } }, previous) }).toThrow(/empty baseURL/)
  })
})
