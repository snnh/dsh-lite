/**
 * SessionManager list-entry cache bound: the reference-stability cache keeps a
 * ceiling of admitted identities, reuses the previous entry object verbatim on
 * every unchanged rebuild, refreshes the recency of reused identities, and —
 * once a rebuild admits more rows than the bound — drops the least recently
 * reused ones first instead of the rows a later rebuild turns out to still hold.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

/** A manager whose remote is never reached: these cases only drive list rows. */
function manager(options?: { entryCacheMaxEntries: number }): SessionManager {
  return new SessionManager({} as unknown as SessionRemotes, options)
}

function row(id: string): SessionSummary {
  return { agentAvailable: true, sessionId: id as SessionId, updatedAt: 1, running: false, blank: false }
}

const sid = (id: string): SessionId => id as SessionId

/** Display-order session ids, which are also the entries the cache handed out. */
function ids(m: SessionManager): SessionId[] {
  return m.getListSnapshot().items.map(item => item.sessionId)
}

/** Entry objects by session id: identity is exactly what this cache exists to keep. */
function refs(m: SessionManager): Map<SessionId, object> {
  return new Map(m.getListSnapshot().items.map(item => [item.sessionId, item]))
}

describe('SessionManager entry-cache bound', () => {
  it('reuses every entry object while a rebuild stays exactly at the bound', () => {
    const m = manager({ entryCacheMaxEntries: 3 })
    for (const id of ['a', 'b', 'c']) m.handleSessionAdded(row(id))
    // Admission order follows display order: an upsert prepends the arriving session.
    expect(ids(m)).toEqual(['c', 'b', 'a'])
    const first = refs(m)
    m.handleSessionAdded(row('a')) // identical fields: every row is a cache hit, nothing is evicted
    const second = refs(m)
    expect([...second.keys()]).toEqual(['c', 'b', 'a'])
    for (const [sessionId, entry] of second) expect(entry).toBe(first.get(sessionId))
  })

  it('keeps the default bound when no option is injected', () => {
    const m = manager()
    for (const index of Array.from({ length: 500 }, (_unused, at) => at)) {
      m.handleSessionAdded(row(`d${index}`))
    }
    const first = refs(m)
    expect(first.size).toBe(500)
    m.handleSessionAdded(row('d0')) // rebuild over the same 500 rows: still within the default bound
    const second = refs(m)
    for (const [sessionId, entry] of second) expect(entry).toBe(first.get(sessionId))
  })

  it('drops the least recently reused identities when a rebuild exceeds the bound', () => {
    const m = manager({ entryCacheMaxEntries: 2 })
    for (const id of ['a', 'b', 'c', 'd']) m.handleSessionAdded(row(id))
    expect(ids(m)).toEqual(['d', 'c', 'b', 'a'])
    // Four rows through a bound of two admissions: only the two rows admitted last keep identity.
    const overflow = refs(m)
    m.handleSessionRemoved(sid('d'))
    m.handleSessionRemoved(sid('c'))
    expect(ids(m)).toEqual(['b', 'a'])
    const survivors = refs(m)
    for (const sessionId of ['b', 'a'] as SessionId[]) {
      expect(survivors.get(sessionId)).toBe(overflow.get(sessionId))
    }
  })

  it('refreshes the recency of a reused identity, so the next overflow spares it', () => {
    const m = manager({ entryCacheMaxEntries: 3 })
    for (const id of ['a', 'b', 'c']) m.handleSessionAdded(row(id))
    expect(ids(m)).toEqual(['c', 'b', 'a'])
    m.handleSessionRemoved(sid('b')) // [c, a]: pruned from the rows, both entries still cached
    expect(ids(m)).toEqual(['c', 'a'])
    m.handleSessionAdded(row('b')) // [b, c, a]: b admitted, then c and a reused in that order
    expect(ids(m)).toEqual(['b', 'c', 'a'])
    m.handleSessionAdded(row('x')) // [x, b, c, a] over a bound of three: every row is re-admitted
    expect(ids(m)).toEqual(['x', 'b', 'c', 'a'])
    const overflow = refs(m)
    m.handleSessionRemoved(sid('x')) // [b, c, a]: exactly at the bound again
    const after = refs(m)
    expect(ids(m)).toEqual(['b', 'c', 'a'])
    // The overflow pass re-admitted all four rows, so the identities it keeps are the tail of
    // its own work: pass E still finds b, c and a cached and reuses the very objects the
    // overflow snapshot handed out. Without the reuse refresh, that pass's order would have
    // left x's identity cached and evicted b's, and b would be minted anew here.
    for (const sessionId of ['b', 'c', 'a'] as SessionId[]) {
      expect(after.get(sessionId)).toBe(overflow.get(sessionId))
    }
  })
})
