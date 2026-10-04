/** The prepared-observation cache budgets: byte account, idle window, and lease priority. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision, SessionReadOnlyError } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadResult,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

afterEach(() => {
  vi.useRealTimers()
})

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

function messageEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

interface StoredEntry {
  header: SessionHeader
  events: SessionEvent[]
  revision: string
}

interface StubCounters {
  stat: number
  open: number
  read: number
}

/** Object-stub persistence: only the members the observation reader touches. */
function stubPersistence(
  store: Map<SessionIdType, StoredEntry>,
  counters: StubCounters,
): SessionPersistence {
  const stat = (id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> => {
    counters.stat += 1
    const entry = store.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.header),
      revision: SessionPersistenceRevision(entry.revision),
    })
  }
  const open = (id: SessionIdType, access: SessionAccess): Promise<SessionHandle> => {
    counters.open += 1
    const entry = store.get(id)
    const handle: SessionHandle = {
      id,
      header: structuredClone(entry?.header ?? header(id)),
      inheritedEventCount: SessionLogOffset(0),
      access,
      read: (): Promise<SessionHandleReadResult> => {
        counters.read += 1
        return Promise.resolve({ eventState: 'detached', events: structuredClone(entry?.events ?? []) })
      },
      append: () => Promise.reject(new SessionReadOnlyError(id, 'append')),
      flush: () => Promise.reject(new SessionReadOnlyError(id, 'flush')),
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }
    return Promise.resolve(handle)
  }
  return { stat, open } as never
}

async function readerContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

/** One stored session per id, each holding a single user message. */
function storeOf(...ids: string[]): Map<SessionIdType, StoredEntry> {
  return new Map(ids.map((id) => {
    const meta = header(id)
    return [meta.id, { header: meta, events: [messageEvent(0, id)], revision: 'r1' }]
  }))
}

/** Read one session and release the lease immediately, leaving the entry reusable. */
async function readOnce(reader: SessionObservationReader, id: SessionIdType): Promise<void> {
  using observed = await reader.read(id, { projectionMode: 'none' })
  void observed
}

describe('SessionObservationReader byte budget', () => {
  it('drops the least recently used entry at the byte bound', async () => {
    const ctx = await readerContext()
    const store = storeOf('bytes-a', 'bytes-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    // One byte cannot hold any prepared observation, so only the newest survives.
    const reader = new SessionObservationReader(ctx, { maxBytes: 1 })

    await readOnce(reader, SessionId('bytes-a'))
    await readOnce(reader, SessionId('bytes-b'))
    expect(counters.read).toBe(2)
    // B is the only resident entry; A was priced out of the account.
    await readOnce(reader, SessionId('bytes-b'))
    expect(counters.read).toBe(2)
    await readOnce(reader, SessionId('bytes-a'))
    expect(counters.read).toBe(3)
    await ctx.fiber.dispose()
  })

  it('treats a zero byte bound as no byte account at all', async () => {
    const ctx = await readerContext()
    const store = storeOf('nobytes-a', 'nobytes-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { maxBytes: 0 })

    await readOnce(reader, SessionId('nobytes-a'))
    await readOnce(reader, SessionId('nobytes-b'))
    await readOnce(reader, SessionId('nobytes-a'))
    await readOnce(reader, SessionId('nobytes-b'))
    expect(counters.read).toBe(2)
    await ctx.fiber.dispose()
  })

  it('never reclaims a leased entry to satisfy the byte bound', async () => {
    const ctx = await readerContext()
    const store = storeOf('leased-bytes-a', 'leased-bytes-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { maxBytes: 1 })

    const leasedA = await reader.read(SessionId('leased-bytes-a'), { projectionMode: 'none' })
    const leasedB = await reader.read(SessionId('leased-bytes-b'), { projectionMode: 'none' })
    using hitA = await reader.read(SessionId('leased-bytes-a'), { projectionMode: 'none' })
    using hitB = await reader.read(SessionId('leased-bytes-b'), { projectionMode: 'none' })

    // Both entries are well over the byte bound and both are still reusable:
    // a budget never costs a lease its cut.
    expect(counters.read).toBe(2)
    expect(hitA.events).toBe(leasedA.events)
    expect(hitB.events).toBe(leasedB.events)
    leasedA[Symbol.dispose]()
    leasedB[Symbol.dispose]()
    await ctx.fiber.dispose()
  })
})

describe('SessionObservationReader entry-count budget', () => {
  it('honors the entry count given with the other bounds', async () => {
    const ctx = await readerContext()
    const store = storeOf('count-a', 'count-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { maxEntries: 1, maxBytes: 0 })

    await readOnce(reader, SessionId('count-a'))
    await readOnce(reader, SessionId('count-b'))
    // A is the least recently used reusable entry.
    await readOnce(reader, SessionId('count-b'))
    expect(counters.read).toBe(2)
    await readOnce(reader, SessionId('count-a'))
    expect(counters.read).toBe(3)
    await ctx.fiber.dispose()
  })

  it('holds a leased entry outside the count until its lease releases', async () => {
    const ctx = await readerContext()
    const store = storeOf('count-lease-a', 'count-lease-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { maxEntries: 1, maxBytes: 0 })

    const leasedA = await reader.read(SessionId('count-lease-a'), { projectionMode: 'none' })
    {
      using leasedB = await reader.read(SessionId('count-lease-b'), { projectionMode: 'none' })
      using hitB = await reader.read(SessionId('count-lease-b'), { projectionMode: 'none' })
      expect(hitB.events).toBe(leasedB.events)
    }
    // A leased entry is invisible to the count; B's release found the total
    // over the bound and left B out of the cache rather than keeping both.
    using hitA = await reader.read(SessionId('count-lease-a'), { projectionMode: 'none' })
    expect(counters.read).toBe(2)
    expect(hitA.events).toBe(leasedA.events)
    await readOnce(reader, SessionId('count-lease-b'))
    expect(counters.read).toBe(3)
    leasedA[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('returns a released entry to the cache inside the bounds', async () => {
    const ctx = await readerContext()
    const store = storeOf('return-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { maxEntries: 2, maxBytes: 0 })

    const leased = await reader.read(SessionId('return-a'), { projectionMode: 'none' })
    expect(counters.read).toBe(1)
    leased[Symbol.dispose]()
    using hit = await reader.read(SessionId('return-a'), { projectionMode: 'none' })
    expect(counters.read).toBe(1)
    expect(hit.events).toBe(leased.events)
    await ctx.fiber.dispose()
  })

  it('keeps a superseded revision out of the cache when its lease releases', async () => {
    const ctx = await readerContext()
    const store = storeOf('superseded-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    const stale = await reader.read(SessionId('superseded-a'), { projectionMode: 'none' })
    const entry = store.get(SessionId('superseded-a'))!
    entry.revision = 'r2'
    const fresh = await reader.read(SessionId('superseded-a'), { projectionMode: 'none' })
    // The stale lease releases only its own cut: the id is already represented
    // by the newer entry, so the released preparation never becomes reusable.
    stale[Symbol.dispose]()
    fresh[Symbol.dispose]()
    using hit = await reader.read(SessionId('superseded-a'), { projectionMode: 'none' })
    expect(counters.read).toBe(2)
    expect(hit.revision).toBe(SessionPersistenceRevision('r2'))
    await ctx.fiber.dispose()
  })

  it('drops a release the cache already holds a newer cut for', async () => {
    const ctx = await readerContext()
    await ctx.plugin(SessionProjectionRegistry)
    const store = storeOf('cached-newer-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    const stale = await reader.read(SessionId('cached-newer-a'), { projectionMode: 'none' })
    const entry = store.get(SessionId('cached-newer-a'))!
    entry.revision = 'r2'
    // A failed projection leaves the newer revision stored but unleased.
    vi.spyOn(ctx.sessionProjections, 'hydrate').mockImplementationOnce(() => {
      throw new Error('hydration failed')
    })
    await expect(reader.read(SessionId('cached-newer-a'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
    })
    // Releasing the stale lease must not overwrite the newer cut in the cache.
    stale[Symbol.dispose]()
    using hit = await reader.read(SessionId('cached-newer-a'), { projectionMode: 'none' })
    expect(counters.read).toBe(2)
    expect(hit.revision).toBe(SessionPersistenceRevision('r2'))
    await ctx.fiber.dispose()
  })
})

describe('SessionObservationReader idle window', () => {
  it('reclaims an entry left idle past the window', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('idle-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { idleTtlMs: 100 })

    await readOnce(reader, SessionId('idle-a'))
    expect(counters.read).toBe(1)
    vi.advanceTimersByTime(200)
    await readOnce(reader, SessionId('idle-a'))
    expect(counters.read).toBe(2)
    await ctx.fiber.dispose()
  })

  it('restamps a hit inside the window', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('idle-hit-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { idleTtlMs: 100 })

    await readOnce(reader, SessionId('idle-hit-a'))
    vi.advanceTimersByTime(50)
    // The hit at 50 ms restarts the window; without it the sweep at 100 ms
    // would have reclaimed the entry.
    await readOnce(reader, SessionId('idle-hit-a'))
    vi.advanceTimersByTime(100)
    await readOnce(reader, SessionId('idle-hit-a'))
    expect(counters.read).toBe(1)
    vi.advanceTimersByTime(150)
    await readOnce(reader, SessionId('idle-hit-a'))
    expect(counters.read).toBe(2)
    await ctx.fiber.dispose()
  })

  it('never reclaims a leased entry, only the reusable one beside it', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('idle-lease-a', 'idle-reusable-b')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { idleTtlMs: 100 })

    const leasedA = await reader.read(SessionId('idle-lease-a'), { projectionMode: 'none' })
    await readOnce(reader, SessionId('idle-reusable-b'))
    vi.advanceTimersByTime(1000)
    using hitA = await reader.read(SessionId('idle-lease-a'), { projectionMode: 'none' })
    expect(hitA.events).toBe(leasedA.events)
    await readOnce(reader, SessionId('idle-reusable-b'))
    expect(counters.read).toBe(3)
    leasedA[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('keeps entries resident when the idle window is off', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('no-idle-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    using reader = new SessionObservationReader(ctx, { idleTtlMs: 0, maxBytes: 0 })

    await readOnce(reader, SessionId('no-idle-a'))
    vi.advanceTimersByTime(10 * 60 * 1000)
    await readOnce(reader, SessionId('no-idle-a'))
    expect(counters.read).toBe(1)
    await ctx.fiber.dispose()
  })

  it('reclaims by the default ten-minute window', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('default-idle-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    await readOnce(reader, SessionId('default-idle-a'))
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    await readOnce(reader, SessionId('default-idle-a'))
    expect(counters.read).toBe(1)
    // A full window past that hit, one sweep reclaims the entry.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    await readOnce(reader, SessionId('default-idle-a'))
    expect(counters.read).toBe(2)
    await ctx.fiber.dispose()
  })

  it('stops reclaiming on dispose while retaining the entries', async () => {
    vi.useFakeTimers()
    const ctx = await readerContext()
    const store = storeOf('disposed-idle-a')
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, { idleTtlMs: 100 })

    await readOnce(reader, SessionId('disposed-idle-a'))
    reader[Symbol.dispose]()
    reader[Symbol.dispose]()
    vi.advanceTimersByTime(1000)
    await readOnce(reader, SessionId('disposed-idle-a'))
    expect(counters.read).toBe(1)
    await ctx.fiber.dispose()
  })
})
