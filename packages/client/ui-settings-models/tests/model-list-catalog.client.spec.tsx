// @vitest-environment jsdom
/** Catalog reads preserve draft ownership and discard responses for a previous provider. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDiscoveryOutcome, ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function operations(discoverModels: ModelsOperations['discoverModels']): ModelsOperations {
  return {
    discoverModels,
    modelDefaults: vi.fn(() => Promise.resolve({ kind: 'described', models: [] } as const)),
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
  }
}

it('ignores a late catalog response after the provider changes', async () => {
  const oldCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const newCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const actions = operations(vi.fn()
    .mockReturnValueOnce(oldCatalog.promise)
    .mockReturnValueOnce(newCatalog.promise))
  const onChange = vi.fn()
  const props = {
    models: [{ id: 'm' }], onChange, operations: actions,
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
  }
  const { rerender } = render(<ModelListEditor {...props} catalogProvider="old" probe={{ settingsNs: 'llm-pi-ai', provider: 'old' }} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).disabled).toBe(true)
  rerender(<ModelListEditor {...props} catalogProvider="new" probe={{ settingsNs: 'llm-pi-ai', provider: 'new' }} />)
  await act(async () => { newCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text', 'image'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  await act(async () => { oldCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

it('uses provider input defaults for a model absent from the installed catalog', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'custom' }]} onChange={onChange} defaultInput={['image']} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const text = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText })
  await waitFor(() => { expect(text.disabled).toBe(false) })
  expect(text.checked).toBe(false)
  fireEvent.click(text)
  expect(onChange).toHaveBeenCalledWith([{ id: 'custom', input: ['text', 'image'] }])
})

it('inherits catalog inputs once an incomplete draft has a model id', async () => {
  const onChange = vi.fn()
  const props = {
    onChange, catalogProvider: 'openai',
    probe: { settingsNs: 'llm-pi-ai', provider: 'openai' },
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
    operations: operations(() => Promise.resolve({
      kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
    })),
  }
  const { rerender } = render(<ModelListEditor {...props} models={[{}]} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  await waitFor(() => { expect(image.disabled).toBe(false) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText }).checked).toBe(true)
  expect(image.checked).toBe(false)
  expect(onChange).not.toHaveBeenCalled()

  const id = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
  expect(id.value).toBe('')
  fireEvent.change(id, { target: { value: 'vision' } })
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{ id: 'vision' }])
  rerender(<ModelListEditor {...props} models={[{ id: 'vision' }]} />)
  expect(image.checked).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('restores inherited image input after a failed catalog read is retried manually', async () => {
  const discover = vi.fn<ModelsOperations['discoverModels']>()
    .mockResolvedValueOnce({ kind: 'refused', message: 'Catalog unavailable' })
    .mockResolvedValueOnce({ kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }] })
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'vision' }]} onChange={onChange} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(discover)}
  />)
  await screen.findByText('Catalog unavailable')
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  expect(image.checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
  expect(image.checked).toBe(true)
  expect(screen.queryByText('Catalog unavailable')).toBeNull()
  expect(discover).toHaveBeenCalledTimes(2)
  expect(onChange).not.toHaveBeenCalled()
})

it('writes what the adapter declares about the drafted ids into their rows', async () => {
  const onChange = vi.fn()
  const modelDefaults: ModelsOperations['modelDefaults'] = vi.fn(() => Promise.resolve({
    kind: 'described' as const,
    models: [{
      id: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      capabilities: { modalities: ['text', 'image'], effort: ['low', 'high', 'max'], replayReasoning: true },
      defaults: { maxTokens: 1024 },
    }],
  }))
  render(<ModelListEditor
    models={[{ id: 'deepseek-v4-flash', name: 'Flash', capabilities: { tools: false } }, { id: 'acme-7b' }]}
    onChange={onChange}
    probe={{ settingsNs: 'llm-service-lite' }}
    disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={{ ...operations(() => Promise.resolve({ kind: 'found', models: [] })), modelDefaults }}
  />)
  expect(modelDefaults).toHaveBeenCalledTimes(0)
  fireEvent.click(screen.getByRole('button', { name: en.writeDeclaredDefaults }))
  await waitFor(() => { expect(onChange).toHaveBeenCalledTimes(1) })
  expect(modelDefaults).toHaveBeenCalledWith('llm-service-lite', {
    models: ['deepseek-v4-flash', 'acme-7b'],
  })
  // The capacities and declared fields land in the row, the row's own fields
  // survive, and an id the adapter could not describe is left exactly as it was.
  expect(onChange).toHaveBeenCalledWith([
    {
      id: 'deepseek-v4-flash',
      name: 'Flash',
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      capabilities: { tools: false, modalities: ['text', 'image'], effort: ['low', 'high', 'max'], replayReasoning: true },
      defaults: { maxTokens: 1024 },
    },
    { id: 'acme-7b' },
  ])
  expect(screen.getByText(en.declaredDefaultsWritten)).toBeTruthy()
})

it('says so when no family describes any of the drafted ids', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'acme-7b' }]}
    onChange={onChange}
    probe={{ settingsNs: 'llm-service-lite' }}
    disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={{ ...operations(() => Promise.resolve({ kind: 'found', models: [] })), modelDefaults: vi.fn(() => Promise.resolve({ kind: 'described' as const, models: [] })) }}
  />)
  fireEvent.click(screen.getByRole('button', { name: en.writeDeclaredDefaults }))
  await waitFor(() => { expect(screen.getByText(en.declaredDefaultsNone)).toBeTruthy() })
  expect(onChange).not.toHaveBeenCalled()
})
