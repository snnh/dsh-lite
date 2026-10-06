/** Event-loop fairness and cancellation of synchronous Session-list summaries. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import SessionController from '../src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiSessionList, COLD_READ_WINDOW } from '../src/list.ts'

type Phase = 'live' | 'cold'
interface Row {
  id: string
  phase: Phase
  cwd?: false
}

const contexts = new Set<Context>()
const immediates = new Set<ReturnType<typeof setImmediate>>()

afterEach(async () => {
  for (const handle of immediates) clearImmediate(handle)
  immediates.clear()
  vi.restoreAllMocks()
  try {
    await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  } finally {
    contexts.clear()
  }
})

function betweenRows(action: () => void): void {
  const handle = setImmediate(() => {
    immediates.delete(handle)
    action()
  })
  immediates.add(handle)
}

async function harness(rows: readonly Row[], summaryMs = 8, workSliceMs = 8) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const list = new ApiSessionList(ctx, workSliceMs)
  const clock = { now: 0 }
  const prepared = new Map<string, Session>()
  const agents = new Map<string, { status: Agent['status'] }>()
  const detach = new Map<string, () => void>()
  const trace: string[] = []
  const observer: { summary: (phase: Phase, id: string) => void } = { summary: () => {} }
  const recordSummary = (phase: Phase, id: string): void => {
    clock.now += summaryMs
    trace.push(`${phase}:${id}`)
    observer.summary(phase, id)
  }
  const attach = (id: string): void => {
    const session = prepared.get(id)
    if (session === undefined) throw new Error(`missing prepared Session ${id}`)
    const detachSession = ctx.sessions.enter(session)
    ctx.effect(() => detachSession, 'list-scheduling.session')
    ctx.sessions.announce(session)
    const agent = { id: session.id, session, ctx, status: 'idle' as Agent['status'] }
    // Only registry lookup and status are consumed; no Agent execution occurs in this fixture.
    const detachAgent = ctx.agents.enter(agent as Agent, undefined)
    ctx.effect(() => detachAgent, 'list-scheduling.agent')
    agents.set(id, agent)
    detach.set(id, () => { detachAgent(); detachSession() })
  }
  const records: SessionRecord[] = rows.map((row) => {
    const session = ctx.sessions.prepare(SessionId(row.id), {
      meta: { createdAt: 100, ...(row.cwd === false ? {} : { cwd: resolve('list-scheduling-fixture') }) },
    })
    prepared.set(row.id, session)
    if (row.phase === 'live') attach(row.id)
    return { header: session.header, live: row.phase === 'live', persisted: true }
  })
  const listSessions = vi.fn(async (_signal?: AbortSignal) => records)
  ctx.provide('sessionQuery', { listSessions } as never)
  ctx.provide('sessionProjectionCache', {
    // The read faces are asynchronous on the cache service; the stub keeps the
    // counted work synchronous by resolving immediately.
    cachedSnapshot: async (header: SessionRecord['header']) => {
      recordSummary('cold', header.id)
      return { asOfSeq: -1, values: { sessionListMetadata: { blank: false, lastPromptAt: null } } }
    },
    cachedPredecessorTitle: async () => undefined,
  } as never)
  const summaryFor = list.summaryFor.bind(list)
  vi.spyOn(list, 'summaryFor').mockImplementation((session) => {
    const summary = summaryFor(session)
    recordSummary('live', session.id)
    return summary
  })
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  return { ctx, list, listSessions, trace, observer, attach, agents, detach, clock }
}

describe('Session-list work slices', () => {
  it('keeps cheap live summaries in one synchronous slice', async () => {
    const h = await harness([{ id: 'first', phase: 'live' }, { id: 'middle', phase: 'live' }, { id: 'last', phase: 'live' }], 2)
    const yieldWork = vi.spyOn(scheduler, 'yield')
    h.observer.summary = (_phase, id) => {
      if (id !== 'first') return
      queueMicrotask(() => { h.trace.push('microtask') })
      betweenRows(() => { h.trace.push('immediate') })
    }

    await h.list.list()
    // No await sits between two live summaries: the microtask the first row
    // queued runs only after the whole synchronous slice.
    expect(yieldWork).not.toHaveBeenCalled()
    expect(h.trace).toEqual(['live:first', 'live:middle', 'live:last', 'microtask'])
    await new Promise<void>((resolve) => { betweenRows(resolve) })
    expect(h.trace.at(-1)).toBe('immediate')
  })

  it('keeps cheap cold summaries inside one work slice, one cache read each', async () => {
    const h = await harness([{ id: 'first', phase: 'cold' }, { id: 'middle', phase: 'cold' }, { id: 'last', phase: 'cold' }], 2)
    const yieldWork = vi.spyOn(scheduler, 'yield')
    h.observer.summary = (_phase, id) => {
      if (id !== 'first') return
      queueMicrotask(() => { h.trace.push('microtask') })
      betweenRows(() => { h.trace.push('immediate') })
    }

    await h.list.list()
    // A cold row awaits the cache's read, so the microtask the first row queued
    // runs at the first window boundary — before the rows that follow it start
    // — while the whole pass stays one macrotask and the accumulated work stays
    // under the budget, so nothing yields.
    expect(yieldWork).not.toHaveBeenCalled()
    expect(h.trace).toEqual(['cold:first', 'cold:middle', 'microtask', 'cold:last'])
    await new Promise<void>((resolve) => { betweenRows(resolve) })
    expect(h.trace.at(-1)).toBe('immediate')
  })

  it('accumulates work across both phases and resets the deadline after waiting', async () => {
    const h = await harness([{ id: 'first', phase: 'live' }, { id: 'second', phase: 'cold' }, { id: 'last', phase: 'cold' }], 4)
    const yieldWork = vi.spyOn(scheduler, 'yield')
    h.observer.summary = (_phase, id) => {
      if (id !== 'first') return
      betweenRows(() => {
        h.clock.now += 1_000
        h.trace.push('other-work')
      })
    }

    await h.list.list()
    // Both queued reads start as one window, so the classification work plus
    // those starts reach the deadline set before the pass began; the wait
    // restarts the deadline from the post-wait clock, which the interleaved
    // other work no longer reaches.
    expect(h.trace).toEqual(['live:first', 'cold:second', 'cold:last', 'other-work'])
    expect(yieldWork).toHaveBeenCalledTimes(1)
  })

  it('honors an overridden budget without yielding early', async () => {
    const h = await harness([{ id: 'first', phase: 'cold' }, { id: 'last', phase: 'cold' }], 10, 16)
    const yieldWork = vi.spyOn(scheduler, 'yield')
    h.observer.summary = (_phase, id) => {
      if (id === 'first') betweenRows(() => { h.trace.push('other-work') })
    }
    await h.list.list()
    expect(h.trace).toEqual(['cold:first', 'cold:last', 'other-work'])
    expect(yieldWork).toHaveBeenCalledTimes(1)
  })

  it('includes skipped-record classification in the work budget', async () => {
    const h = await harness([
      { id: 'first', phase: 'cold', cwd: false },
      { id: 'second', phase: 'cold', cwd: false },
      { id: 'last', phase: 'cold', cwd: false },
    ], 0)
    const controller = new AbortController()
    const reason = new Error('stop classification')
    const get = h.ctx.sessions.get.bind(h.ctx.sessions)
    const lookup = vi.spyOn(h.ctx.sessions, 'get').mockImplementation((id) => {
      h.clock.now += 4
      if (id === SessionId('first')) betweenRows(() => { controller.abort(reason) })
      return get(id)
    })
    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(h.trace).toEqual([])
  })

  it.each(['first', 'last'])('honors synchronous cancellation in the %s cheap row without yielding', async (abortAt) => {
    const h = await harness([{ id: 'first', phase: 'cold' }, { id: 'last', phase: 'cold' }], 0)
    const yieldWork = vi.spyOn(scheduler, 'yield')
    const controller = new AbortController()
    const reason = new Error('stop without waiting')
    h.observer.summary = (_phase, id) => { if (id === abortAt) controller.abort(reason) }
    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(yieldWork).not.toHaveBeenCalled()
    expect(h.trace).toEqual(abortAt === 'first' ? ['cold:first'] : ['cold:first', 'cold:last'])
  })

  it('resolves default and overridden budgets without changing native-opening input', () => {
    expect(SessionController.Config({}).listWorkSliceMs).toBe(16)
    expect(SessionController.Config({ nativeOpen: false, listWorkSliceMs: 32 })).toMatchObject({ nativeOpen: false, listWorkSliceMs: 32 })
  })

  it('routes an overridden budget through the public Session Controller', async () => {
    const h = await harness([{ id: 'first', phase: 'cold' }, { id: 'middle', phase: 'cold' }, { id: 'last', phase: 'cold' }], 4)
    const dispose = (): void => {}
    h.ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose } } as never)
    h.ctx.provide('fileUploads', { registerAgentResolver: () => dispose } as never)
    h.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
    h.ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
    const controller = new SessionController(h.ctx, { nativeOpen: false, listWorkSliceMs: 4 }, { canOpenPath: () => false })
    const yieldWork = vi.spyOn(scheduler, 'yield')
    const result = await controller.list({}, new AbortController().signal)
    expect(result.items).toHaveLength(3)
    // Read windows of two make the overridden budget yield at two drained
    // results; the default 16 ms budget would not yield at all for this
    // fixture, which is what makes the count evidence that the override reached
    // the list.
    expect(yieldWork).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid work-slice budget %s', (listWorkSliceMs) => {
    expect(() => SessionController.Config({ listWorkSliceMs })).toThrow()
  })

  it('yields between live summaries that each exhaust the work slice', async () => {
    const h = await harness([
      { id: 'first', phase: 'live' }, { id: 'middle', phase: 'live' }, { id: 'last', phase: 'live' },
    ])
    h.observer.summary = (_phase, id) => { betweenRows(() => { h.trace.push(`immediate:${id}`) }) }

    const items = await h.list.list()
    h.trace.push('resolved')

    expect(h.trace).toEqual([
      'live:first', 'immediate:first', 'live:middle', 'immediate:middle',
      'live:last', 'immediate:last', 'resolved',
    ])
    expect(items.map(item => item.sessionId)).toEqual(['first', 'middle', 'last'])
  })

  it('yields between cold read windows that each exhaust the work slice', async () => {
    // One row past a full window, so the first yield provably sits between two
    // windows rather than after the last read.
    const ids = Array.from({ length: COLD_READ_WINDOW + 1 }, (_, index) => `row-${index}`)
    const h = await harness(ids.map(id => ({ id, phase: 'cold' as Phase })))
    h.observer.summary = (_phase, id) => { betweenRows(() => { h.trace.push(`immediate:${id}`) }) }

    const items = await h.list.list()
    h.trace.push('resolved')

    // The first window starts together, then the exhausted slice hands the
    // loop back before the next row starts: every queued row's host callback
    // runs before the list resolves, so the host is never held across the whole
    // list.
    expect(h.trace).toEqual([
      ...ids.slice(0, COLD_READ_WINDOW).map(id => `cold:${id}`),
      ...ids.slice(0, COLD_READ_WINDOW).map(id => `immediate:${id}`),
      `cold:${ids[COLD_READ_WINDOW]}`, `immediate:${ids[COLD_READ_WINDOW]}`, 'resolved',
    ])
    expect(items.map(item => item.sessionId)).toEqual(ids)
  })

  it.each([
    { phase: 'live', abortAt: 'first' },
    { phase: 'live', abortAt: 'last' },
    { phase: 'cold', abortAt: 'first' },
    { phase: 'cold', abortAt: 'last' },
  ] as const)('preserves cancellation after the $abortAt $phase row', async ({ phase, abortAt }) => {
    // The cold phase reads a window of rows at once, so its fixture is longer
    // than that window: an abort must stop the list after the reads already in
    // flight and never issue another.
    const ids: readonly string[] = phase === 'cold'
      ? Array.from({ length: COLD_READ_WINDOW + 2 }, (_, index) => `row-${index}`)
      : ['first', 'middle', 'last']
    const aborted = abortAt === 'first' ? ids[0] as string : ids.at(-1) as string
    // Cancellation stops the list at the next boundary: a live row stops it
    // there, a cold row after the window's reads that were already in flight.
    const expected = abortAt === 'first'
      ? ids.slice(0, phase === 'cold' ? COLD_READ_WINDOW : 1)
      : ids
    const h = await harness(ids.map(id => ({ id, phase })))
    const lookup = vi.spyOn(h.ctx.sessions, 'get')
    const controller = new AbortController()
    const reason = { cancellation: `${phase}-${abortAt}` }
    h.observer.summary = (_phase, id) => {
      if (id === aborted) betweenRows(() => { controller.abort(reason) })
    }

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual(expected.map(id => `${phase}:${id}`))
    expect(h.listSessions).toHaveBeenCalledExactlyOnceWith(controller.signal)
    if (phase === 'live' && abortAt === 'first') {
      expect(lookup).toHaveBeenCalledExactlyOnceWith(SessionId('first'))
    }
  })

  it('starts no cold read beyond the read window once cancellation is observed', async () => {
    const ids = Array.from({ length: COLD_READ_WINDOW + 3 }, (_, index) => `row-${index}`)
    const h = await harness(ids.map(id => ({ id, phase: 'cold' as Phase })))
    const controller = new AbortController()
    const reason = new Error('stop inside the first window')
    h.observer.summary = (_phase, id) => {
      if (id === ids[0]) betweenRows(() => { controller.abort(reason) })
    }

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    // Exactly the window's reads were issued: the abort stops the list at the
    // next drained result instead of walking the rest of the rows.
    expect(h.trace).toEqual(ids.slice(0, COLD_READ_WINDOW).map(id => `cold:${id}`))
  })

  it('does not start cold summaries after cancellation during the last live row', async () => {
    const h = await harness([{ id: 'cold', phase: 'cold' }, { id: 'live', phase: 'live' }])
    const controller = new AbortController()
    const reason = new Error('cancel before cold phase')
    h.observer.summary = (phase) => {
      if (phase === 'live') betweenRows(() => { controller.abort(reason) })
    }

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual(['live:live'])
  })

  it('rejects a pre-aborted request before querying headers', async () => {
    const h = await harness([{ id: 'live', phase: 'live' }])
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.listSessions).not.toHaveBeenCalled()
    expect(h.trace).toEqual([])
  })

  it('checks cancellation after the header query before summarizing any row', async () => {
    const h = await harness([{ id: 'cold', phase: 'cold' }])
    const controller = new AbortController()
    const reason = new Error('query cancelled')
    h.listSessions.mockImplementation(async () => {
      controller.abort(reason)
      return []
    })

    await expect(h.list.list(controller.signal)).rejects.toBe(reason)
    expect(h.trace).toEqual([])
  })

  it('returns an empty list without invoking a summary', async () => {
    const h = await harness([])
    await expect(h.list.list()).resolves.toEqual([])
    expect(h.trace).toEqual([])
  })

  it('omits cwd-less cold rows but retains cwd-less attached Sessions', async () => {
    const h = await harness([
      { id: 'omitted-first', phase: 'cold', cwd: false },
      { id: 'visible-cold', phase: 'cold' },
      { id: 'visible-live', phase: 'live', cwd: false },
      { id: 'omitted-last', phase: 'cold', cwd: false },
    ])

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:visible-live', 'cold:visible-cold'])
    expect(items.map(item => item.sessionId)).toEqual(['visible-live', 'visible-cold'])
    expect(items[0]).not.toHaveProperty('cwd')
  })

  it('keeps live-before-cold stable ties despite interleaved query order', async () => {
    const h = await harness([
      { id: 'cold-a', phase: 'cold' }, { id: 'live-a', phase: 'live' },
      { id: 'cold-b', phase: 'cold' }, { id: 'live-b', phase: 'live' },
    ])

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:live-a', 'live:live-b', 'cold:cold-a', 'cold:cold-b'])
    expect(items.map(item => item.sessionId)).toEqual(['live-a', 'live-b', 'cold-a', 'cold-b'])
    expect(items.map(item => item.updatedAt)).toEqual([100, 100, 100, 100])
  })

  it('observes later attachment and status changes without reclassifying queued cold rows', async () => {
    const h = await harness([
      { id: 'queued', phase: 'cold' }, { id: 'first', phase: 'live' },
      { id: 'removed', phase: 'live' }, { id: 'promoted', phase: 'cold' },
      { id: 'status', phase: 'live' },
    ])
    h.observer.summary = (_phase, id) => {
      if (id !== 'first') return
      betweenRows(() => {
        h.detach.get('removed')!()
        h.attach('queued')
        h.attach('promoted')
        h.agents.get('first')!.status = 'running'
        h.agents.get('promoted')!.status = 'running'
        h.agents.get('status')!.status = 'running'
      })
    }

    const items = await h.list.list()

    expect(h.trace).toEqual(['live:first', 'live:promoted', 'live:status', 'cold:queued', 'cold:removed'])
    expect(items.map(({ sessionId, agentAvailable, running }) => ({ sessionId, agentAvailable, running }))).toEqual([
      { sessionId: 'first', agentAvailable: true, running: false },
      { sessionId: 'promoted', agentAvailable: true, running: true },
      { sessionId: 'status', agentAvailable: true, running: true },
      { sessionId: 'queued', agentAvailable: false, running: false },
      { sessionId: 'removed', agentAvailable: false, running: false },
    ])
    expect(h.ctx.agents.get(SessionId('queued'))).toBeDefined()
    expect(h.ctx.sessions.get(SessionId('removed'))).toBeUndefined()
  })
})
