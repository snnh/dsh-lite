/**
 * Session idle eviction: a resident Session instance carrying no observer
 * (nothing subscribed to its snapshot or its event window), no work in flight
 * (turn, local echo, page load, opening), and no activity inside the configured
 * TTL is released through the ordinary `drop` path, and the next `get` rebuilds
 * it from the retained list row. The unit half drives residency alone (a
 * manager whose Remote is never reached, with fake timers); the assembled half
 * proves the shipping wiring — the generation is withdrawn, the Remote stream
 * is torn down, the reference that generation handed out is disposed rather
 * than left stale, and a later `retain` re-reads history from the Host.
 */

import { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionReferenceSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { SessionManager, type SessionManagerOptions } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { FOLLOW, followScript } from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    idleEvictionView: unknown
  }
}

const ID = 'idle-session' as SessionId
const OTHER = 'idle-neighbour' as SessionId
/** Ten-second threshold: any sweep boundary below is an exact multiple of it. */
const TTL_MS = 10_000

function manager(options: SessionManagerOptions = {}): SessionManager {
  return new SessionManager({} as unknown as SessionRemotes, { sessionIdleTtlMs: TTL_MS, ...options })
}

function row(id: SessionId, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { agentAvailable: true, sessionId: id, updatedAt: 1, running: false, blank: false, ...overrides }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('SessionManager idle eviction', () => {
  test('releases an unobserved instance at the threshold and rebuilds it from the retained row', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    m.handleSessionAdded(row(ID, { updatedAt: 7 }))
    const first = m.get(ID)
    expect(first.getSnapshot()).toMatchObject({ blank: false, openState: 'cold' })
    expect(m.get(ID)).toBe(first)

    await vi.advanceTimersByTimeAsync(TTL_MS)

    // The instance is gone; the row it belonged to is not — the sidebar keeps
    // the session, only the client-side window is released.
    const rebuilt = m.get(ID)
    expect(rebuilt).not.toBe(first)
    expect(rebuilt.getSnapshot()).toMatchObject({
      blank: false, running: false, openState: 'cold', promptAttempted: false,
    })
    expect(m.getListSnapshot().items.map(item => item.sessionId)).toEqual([ID])
    expect(m.getListSnapshot().items[0]?.updatedAt).toBe(7)
  })

  test('never releases a Session with a turn in flight, and re-times from the turn end', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    const session = m.get(ID)
    m.handleSessionStatus(ID, true)

    // Six sweeps past a threshold the turn alone would have crossed twice over.
    await vi.advanceTimersByTimeAsync(6 * TTL_MS)
    expect(m.get(ID)).toBe(session)
    expect(session.getSnapshot().running).toBe(true)

    // The end of the turn restarts the clock: the first sweep inside the next
    // threshold keeps it, the one at the threshold releases it.
    m.handleSessionStatus(ID, false)
    await vi.advanceTimersByTimeAsync(TTL_MS - 1)
    expect(m.get(ID)).toBe(session)
    await vi.advanceTimersByTimeAsync(1)
    expect(m.get(ID)).not.toBe(session)
  })

  test('never releases a Session holding an unsettled local echo', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    const session = m.get(ID)
    const echo = session.beginSubmission({ text: 'queued locally', attachments: [] })

    await vi.advanceTimersByTimeAsync(4 * TTL_MS)
    expect(m.get(ID)).toBe(session)

    // Abandoning the echo leaves the instance eligible again; its own clock
    // reading is older than the threshold, so the next sweep releases it.
    echo.abandon()
    await vi.advanceTimersByTimeAsync(TTL_MS)
    expect(m.get(ID)).not.toBe(session)
  })

  test('never releases an observed Session, and re-times from the last observer leaving', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    const session = m.get(ID)
    // Both observation channels count: the snapshot every UI hook reads and the
    // event window the conversation assembly reads.
    const stopSnapshot = session.subscribe(() => {})
    const stopEvents = session.eventSource.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(4 * TTL_MS)
    expect(m.get(ID)).toBe(session)

    stopSnapshot()
    stopEvents()
    await vi.advanceTimersByTimeAsync(TTL_MS - 1)
    expect(m.get(ID)).toBe(session)
    await vi.advanceTimersByTimeAsync(1)
    expect(m.get(ID)).not.toBe(session)
  })

  test('keeps every instance resident, and arms no sweep, when the threshold is disabled', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager({ sessionIdleTtlMs: 0 })
    const session = m.get(ID)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(m.get(ID)).toBe(session)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('treats a negative threshold as disabled', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager({ sessionIdleTtlMs: -1 })
    const session = m.get(ID)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(m.get(ID)).toBe(session)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('re-times from a durable user message another Client sent', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    const session = m.get(ID)

    // The clock starts at admission. Half a threshold later the Host reports a
    // durable user message — one this Client never typed itself.
    await vi.advanceTimersByTimeAsync(TTL_MS / 2)
    m.handleSessionActivity(ID, 1_234)

    // Past the original threshold, with the sweep at it already taken: had the
    // relay not re-timed the instance, that sweep would have released it.
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1)
    expect(m.get(ID)).toBe(session)

    await vi.advanceTimersByTimeAsync(TTL_MS)
    expect(m.get(ID)).not.toBe(session)
  })

  test('releases only the idle instance and tells the generation owner', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const evicted: string[] = []
    const m = manager({ onSessionEvicted: (sessionId) => { evicted.push(sessionId) } })
    const idle = m.get(ID)
    const watched = m.get(OTHER)
    const stop = watched.subscribe(() => {})

    await vi.advanceTimersByTimeAsync(TTL_MS)

    expect(evicted).toEqual([ID])
    expect(m.get(ID)).not.toBe(idle)
    expect(m.get(OTHER)).toBe(watched)
    stop()
  })

  test('stops sweeping once the last instance is released or the manager is disposed', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const m = manager()
    const session = m.get(ID)
    expect(vi.getTimerCount()).toBe(1)

    await m.drop(ID, session)
    expect(vi.getTimerCount()).toBe(0)

    m.get(OTHER)
    expect(vi.getTimerCount()).toBe(1)
    await m.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

const VIEW_SOURCE: SessionReferenceSource = 'idleEvictionView'
const EMPTY_HISTORY = ok({ records: [], hasMore: false })
const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
/** Short enough for real timers to cross it inside one case, long enough to stay unambiguous. */
const IDLE_TTL_MS = 40

async function bench(mock: RemoteMock, start: () => Promise<TestClient>, ttlMs: number) {
  const client = await start()
  const ctx = new Context()
  const svc = new ClientSessions(ctx, client.ctx.remote, { sessionIdleTtlMs: ttlMs })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  mock.stream(FOLLOW, followScript(EMPTY_HISTORY))
  mock.remote.session.list.mockResolvedValue(ok({
    items: [{ sessionId: ID, updatedAt: 1, running: false, blank: false, agentAvailable: true }],
  }))
  await svc.refresh()
  return { svc, ctx, mock }
}

describe('Client idle eviction', () => {
  it('releases an unobserved generation, disposes its reference, and rebuilds on the next retain', async ({ mock, start }) => {
    const b = await bench(mock, start, IDLE_TTL_MS)
    using reference = b.svc.retain(ID, { source: VIEW_SOURCE })
    await reference.ready
    const released = reference.binding.session
    expect(released.getSnapshot().openState).toBe('open')
    expect(mock.log.streams(FOLLOW).map(stream => stream.state)).toEqual(['open'])

    await vi.waitFor(() => { expect(b.svc.binding(ID)).toBeUndefined() })

    // Released, not left stale: the Remote stream is torn down with the
    // instance, the generation is withdrawn, and the reference it handed out
    // reports the documented disposal instead of a dead Session.
    expect(mock.log.streams(FOLLOW).map(stream => stream.state)).toEqual(['cancelled'])
    expect(() => reference.binding).toThrow('is released')
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })

    // Recovery: a fresh generation, opened by re-reading history from the Host.
    using rebuilt = b.svc.retain(ID, { source: VIEW_SOURCE })
    await rebuilt.ready
    expect(rebuilt.binding.session).not.toBe(released)
    expect(rebuilt.binding.session.getSnapshot().openState).toBe('open')
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)
    expect(b.svc.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { idleEvictionView: 1 } })
  })

  it('keeps a running Session resident past the threshold in the assembled client', async ({ mock, start }) => {
    const b = await bench(mock, start, IDLE_TTL_MS)
    using reference = b.svc.retain(ID, { source: VIEW_SOURCE })
    await reference.ready
    const session = reference.binding.session

    b.svc.handleSessionStatus(ID, true)
    await sleep(4 * IDLE_TTL_MS)
    expect(b.svc.binding(ID)).toBeDefined()
    expect(session.getSnapshot().running).toBe(true)

    b.svc.handleSessionStatus(ID, false)
    await vi.waitFor(() => { expect(b.svc.binding(ID)).toBeUndefined() })
  })
})
