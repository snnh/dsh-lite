// @vitest-environment jsdom
/**
 * The bind-address row: the two addresses it keeps apart, the candidates it
 * offers, the read-only reasons it reports, the outcome the shell overlay
 * announces, and the seats the plugin fills for both.
 */
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { NetworkNoticeState } from '../src/client/network-host.ts'
import { NetworkHostController, type WebHostStatus } from '../src/client/network-host.ts'
import {
  NetworkRow, NetworkToast, type NetworkRowInjected, type NetworkToastInjected,
} from '../src/client/NetworkRow.tsx'
import { enNetwork, zhNetwork } from '../src/client/locales.ts'

/** The row's own dictionary namespace, as the plugin registers it. */
const NETWORK_NS = 'settings.network'
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000

const it = createClientTest({ roster: webApp })

afterEach(cleanup)

/** One posture with both machine facts stated, unless the case overrides them. */
function posture(overrides: Partial<WebHostStatus> = {}): WebHostStatus {
  return { rowFound: true, writable: true, ...overrides }
}

/** A controller over a scripted `webHost` namespace: no assembly, one read/write at a time. */
function controllerOf(
  status: () => Promise<unknown>,
  save: (host: string) => Promise<unknown> = async () => ok(posture()),
): NetworkHostController {
  return new NetworkHostController({ remote: { webHost: { status, save } } } as never)
}

/** Row props over one posture source. */
function rowProps(controller: NetworkHostController, onHost = true): ComponentProps<typeof NetworkRow> {
  return {
    onHost,
    controller,
    useHost: bindSnapshotSelector(controller.store),
    t: makeTranslate(zhNetwork),
  } as unknown as ComponentProps<typeof NetworkRow>
}

/** Overlay props over one notice source and its dismissal. */
function toastProps(
  notice: ObservableSnapshot<NetworkNoticeState>,
  dismiss: () => void,
): ComponentProps<typeof NetworkToast> {
  return {
    useNotice: bindSnapshotSelector(notice),
    dismiss,
    t: makeTranslate(zhNetwork),
  } as unknown as ComponentProps<typeof NetworkToast>
}

/** This plugin's registration in one seat, found by the namespace it declares. */
function entryOf(c: TestClient, name: 'settings.general.item' | 'shell.overlay') {
  const entry = c.ctx.slots.entries(name).find(candidate => candidate.locale === NETWORK_NS)
  if (entry === undefined) throw new Error(`no ${name} registration in ${NETWORK_NS}`)
  return entry
}

/** One registered entry's injected face, called the way the renderer calls it. */
function faceOf(entry: { inject?: unknown }): unknown {
  return (entry.inject as () => unknown)()
}

/** The page authority the `connection` plugin classifies at apply, reconfigured through the jsdom instance vitest exposes. */
function setPageUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure(settings: { url: string }): void } }).jsdom.reconfigure({ url })
}

describe('bind-address row', () => {
  it('keeps the effective and saved lines apart, offers the candidates, and saves through the overlay', async ({ mock, start }) => {
    let view = posture({ bound: '127.0.0.1', persisted: '0.0.0.0', pinned: '0.0.0.0', detected: '192.168.1.5' })
    let release: (() => void) | undefined
    mock.unary('webHost/status', () => ok(view))
    // The write is held open so the in-flight state is observable.
    mock.unary('webHost/save', (host: string) => new Promise((resolve) => {
      release = () => {
        view = posture({ bound: '127.0.0.1', persisted: host, detected: '192.168.1.5' })
        resolve(ok(view))
      }
    }))
    const c = await start()
    const entry = entryOf(c, 'settings.general.item')
    expect(entry.options).toMatchObject({ id: 'network-host', order: 20 })
    const face = faceOf(entry) as NetworkRowInjected
    expect(face.onHost).toBe(true)
    const rendered = render(<NetworkRow {...rowProps(face.controller)} />)
    const text = (): string => rendered.container.textContent ?? ''
    // The read is in flight: the row owns the title and says what it is doing.
    expect(text()).toContain(zhNetwork['network.loading'])
    await waitFor(() => { expect(text()).toContain(zhNetwork['network.bound']) })
    expect(text()).toContain('0.0.0.0')
    expect(text()).toContain(zhNetwork['network.restart'])
    // The saved line is what the next start resolves, so the warnings and the
    // pin describe it rather than the running bind.
    expect(text()).toContain(zhNetwork['network.wildcardWarning'])
    expect(text()).toContain(zhNetwork['network.nonLoopbackWarning'])
    expect(text()).toContain(zhNetwork['network.pinned'].replace('{host}', '0.0.0.0'))
    expect(screen.getAllByRole('button').map(button => button.textContent))
      .toEqual(['127.0.0.1', '0.0.0.0', '192.168.1.5', zhNetwork['network.save']])
    const save = (): HTMLButtonElement =>
      screen.getByRole('button', { name: zhNetwork['network.save'] }) as HTMLButtonElement
    const input = screen.getByPlaceholderText(zhNetwork['network.customPlaceholder']) as HTMLInputElement
    expect(save().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '192.168.1.5' }))
    expect(input.value).toBe('192.168.1.5')
    fireEvent.change(input, { target: { value: '127.0.0.1' } })
    fireEvent.click(save())
    // One write in flight disables the control until it settles.
    expect(save().disabled).toBe(true)
    expect(mock.log.requests('webHost/save')).toEqual(['127.0.0.1'])
    release?.()
    await waitFor(() => { expect(text()).toContain(zhNetwork['network.active']) })
    expect(text()).not.toContain(zhNetwork['network.wildcardWarning'])
    expect(text()).not.toContain(zhNetwork['network.pinned'].replace('{host}', '0.0.0.0'))
    expect(save().disabled).toBe(false)

    // The overlay seat announces the same outcome after Settings closes.
    const overlay = faceOf(entryOf(c, 'shell.overlay')) as NetworkToastInjected
    render(<NetworkToast {...toastProps(overlay.hooks.notice, () => { overlay.dismiss() })} />)
    await waitFor(() => { expect(screen.getByText(zhNetwork['network.saved'])).toBeTruthy() })
    act(() => { overlay.dismiss() })
    await waitFor(() => { expect(screen.queryByText(zhNetwork['network.saved'])).toBeNull() })
  }, COLD_BOOT_TIMEOUT_MS)

  it('keeps the address read-only off the machine that runs the harness', async ({ mock, start }) => {
    const loopbackUrl = location.href
    setPageUrl('http://198.51.100.7:3000/')
    onTestFinished(() => { setPageUrl(loopbackUrl) })
    // The namespace is mounted (the assembly provides every endpoint a rule
    // names), and this page never reads it.
    mock.unary('webHost/status', () => ok(posture()))
    const c = await start()
    const face = faceOf(entryOf(c, 'settings.general.item')) as NetworkRowInjected
    expect(face.onHost).toBe(false)
    const rendered = render(<NetworkRow {...rowProps(face.controller, face.onHost)} t={makeTranslate(enNetwork)} />)
    expect(rendered.container.textContent).toContain(enNetwork['network.readOnly.remoteHost'])
    expect(screen.queryByRole('button')).toBeNull()
    // A page that cannot write the line never reads it either.
    expect(mock.log.calls('webHost/status')).toEqual([])
    // The overlay seat is filled on this page too, owning the same notice.
    const overlay = faceOf(entryOf(c, 'shell.overlay')) as NetworkToastInjected
    overlay.dismiss()
  }, COLD_BOOT_TIMEOUT_MS)

  it('marks an equal saved line as in effect and drops the candidate this machine does not detect', async () => {
    const controller = controllerOf(async () => ok(posture({ bound: 'localhost', persisted: 'localhost' })))
    const rendered = render(<NetworkRow {...rowProps(controller)} />)
    expect(rendered.container.textContent).toContain(zhNetwork['network.loading'])
    await waitFor(() => { expect(rendered.container.textContent).toContain(zhNetwork['network.active']) })
    expect(rendered.container.textContent).toContain('localhost')
    expect(rendered.container.textContent).not.toContain(zhNetwork['network.nonLoopbackWarning'])
    expect(screen.getAllByRole('button').map(button => button.textContent))
      .toEqual(['127.0.0.1', '0.0.0.0', zhNetwork['network.save']])
  })

  it('states an address no layer names without warning about one', async () => {
    const controller = controllerOf(async () => ok(posture()))
    const rendered = render(<NetworkRow {...rowProps(controller)} />)
    await waitFor(() => { expect(rendered.container.textContent).toContain(zhNetwork['network.active']) })
    expect(rendered.container.textContent)
      .toContain(`${zhNetwork['network.bound']}${zhNetwork['network.notSet']}`)
    expect(rendered.container.textContent)
      .toContain(`${zhNetwork['network.persisted']}${zhNetwork['network.notSet']}`)
    expect(rendered.container.textContent).not.toContain(zhNetwork['network.nonLoopbackWarning'])
  })

  it('reports a missing row, an unwritable profile, and a failed read in turn', async () => {
    // No lan-access row in this composition: the address cannot be stated here.
    const noRow = controllerOf(async () => ok(posture({ rowFound: false })))
    const first = render(<NetworkRow {...rowProps(noRow)} />)
    await waitFor(() => { expect(first.container.textContent).toContain(zhNetwork['network.readOnly.noRow']) })
    expect(screen.queryByRole('button')).toBeNull()
    first.unmount()

    // A row exists but this deployment has nowhere to persist into.
    const unwritable = controllerOf(async () => ok(posture({ writable: false })))
    const second = render(<NetworkRow {...rowProps(unwritable)} />)
    await waitFor(() => { expect(second.container.textContent).toContain(zhNetwork['network.readOnly.noProfile']) })
    expect(screen.queryByRole('button')).toBeNull()
    second.unmount()

    // A refused read and an unreachable namespace leave the same state: the
    // row says it could not read the posture rather than showing a stale one.
    const refused = controllerOf(async () => ({ ok: false }))
    const third = render(<NetworkRow {...rowProps(refused)} />)
    await waitFor(() => { expect(third.container.textContent).toContain(zhNetwork['network.loadFailed']) })
    third.unmount()
    const fourth = render(<NetworkRow {...rowProps(new NetworkHostController({ remote: {} } as never))} />)
    await waitFor(() => { expect(fourth.container.textContent).toContain(zhNetwork['network.loadFailed']) })
  })

  it('collapses concurrent reads and writes into one call each', async () => {
    const reads = Promise.withResolvers<unknown>()
    const writes = Promise.withResolvers<unknown>()
    const status = vi.fn(() => reads.promise)
    const save = vi.fn(() => writes.promise)
    const controller = new NetworkHostController({ remote: { webHost: { status, save } } } as never)

    const read = [controller.load(), controller.load()]
    expect(status).toHaveBeenCalledTimes(1)
    const first = posture({ bound: '127.0.0.1', persisted: '127.0.0.1' })
    reads.resolve(ok(first))
    await Promise.all(read)
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', view: first, busy: false })

    const written = [controller.save('127.0.0.1'), controller.save('0.0.0.0')]
    expect(save).toHaveBeenCalledExactlyOnceWith('127.0.0.1')
    expect(controller.store.getSnapshot().busy).toBe(true)
    const second = posture({ bound: '127.0.0.1', persisted: '0.0.0.0' })
    writes.resolve(ok(second))
    await Promise.all(written)
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', view: second, busy: false })
    expect(controller.notice.getSnapshot()).toEqual({ notice: 'network.saved', sequence: 1 })
  })

  it('announces a refused or unreachable save and clears the notice once shown', async () => {
    const refused = controllerOf(async () => ok(posture()), async () => ({ ok: false }))
    await refused.save('127.0.0.1')
    expect(refused.notice.getSnapshot()).toEqual({ notice: 'network.saveFailed', sequence: 1 })
    expect(refused.store.getSnapshot().busy).toBe(false)

    const unreachable = new NetworkHostController({ remote: {} } as never)
    await unreachable.save('0.0.0.0')
    expect(unreachable.notice.getSnapshot().notice).toBe('network.saveFailed')

    render(<NetworkToast {...toastProps(refused.notice, () => { refused.dismiss() })} />)
    expect(screen.getByText(zhNetwork['network.saveFailed'])).toBeTruthy()
    act(() => { refused.dismiss() })
    await waitFor(() => { expect(screen.queryByText(zhNetwork['network.saveFailed'])).toBeNull() })
  })
})
