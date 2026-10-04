/**
 * The cache's resident-copy budget and its archive purge: the read faces serve
 * a bounded copy of the domain's records, dropping a record from that copy is a
 * memory-only decision that leaves the durable document in place, and the
 * Workspace registry's archive commits — observed as `domain/changed` on the
 * `workspace` global — delete a session's record resident and durable.
 * Disposal is the control case: the live-to-cold moment checkpoints and must
 * never delete.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord, projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'resident-test/marks': { marks: string[] } | null
  }
  interface SessionProjectionMap {
    'resident-test/marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'resident-test/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'resident-test/mark': true
  }
}

/** One foldable projection unit: a mark replaces the accumulated list. */
const marksUnit = {
  key: 'resident-test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'resident-test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'resident-test/marks', { marks: string[] } | null>

/** Cache config a case may narrow; the two throttle fields are always stated. */
interface CacheConfig {
  writeEveryEvents: number
  writeIntervalMs: number
  residentMaxEntries?: number
  residentMaxBytes?: number
}

const contexts: Context[] = []
const roots: string[] = []

async function harness(config: CacheConfig = { writeEveryEvents: 100, writeIntervalMs: 60_000 }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-resident-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(marksUnit)
  await ctx.plugin(SessionProjectionCache, config)
  return { ctx, root, cache: ctx.sessionProjectionCache }
}

/** One session's record document on the per-record medium. */
const recordPath = (root: string, id: Session['id']): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${String(id)}.json`)

/** The durable rows of one session (undefined = absent or unreadable). */
async function storedRows(root: string, id: Session['id']): Promise<CheckpointRecord['rows'] | undefined> {
  try {
    const document = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as { record: unknown }
    return checkpointRecord.parse(document.record).rows
  } catch {
    return undefined
  }
}

/** Resolve after this session's next durable cache replacement. */
function whenWritten(ctx: Context, id: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('domain/changed', (change) => {
      if (change.domain !== projectionCacheDomainSpec.name
        || change.table !== 'sessions' || change.key !== id || change.operation !== 'put') return
      dispose()
      resolve()
    })
  })
}

/** Resolve after this session's record is deleted from the domain. */
function whenDeleted(ctx: Context, id: SessionId): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('domain/changed', (change) => {
      if (change.domain !== projectionCacheDomainSpec.name
        || change.table !== 'sessions' || change.key !== id || change.operation !== 'deleted') return
      dispose()
      resolve()
    })
  })
}

/** Emit one Workspace-registry global commit carrying an archive set. */
function archiveCommit(ctx: Context, archivedSessionIds: readonly unknown[]): void {
  ctx.emit('domain/changed', {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: { initialized: true, workspaceIds: [], archivedSessionIds, pinnedSessionIds: [] },
  })
}

/**
 * One live session whose durable, resident record holds a mark. The explicit
 * checkpoint is the case's barrier: it is queued behind the creation write the
 * store fires on its own, and awaiting it settles both the durable record and
 * the resident copy's admission of it.
 * @param cache - the cache under test.
 * @param ctx - harness context.
 * @param id - the session to create.
 * @returns the live session and the seq of the mark its record folded.
 */
async function markedSession(
  cache: SessionProjectionCache,
  ctx: Context,
  id: SessionId,
): Promise<{ session: Session; markSeq: number }> {
  const session = ctx.sessions.create(id)
  // The mark alone only arms the interval throttle; the checkpoint below is
  // what makes the marked cut durable.
  const mark = session.append('resident-test/mark', { marks: ['a'] })
  await cache.write(session)
  return { session, markSeq: mark.seq }
}

/** The marked wire block every cache read of a {@link markedSession} serves. */
const markedValues = { 'resident-test/marks': { marks: ['a'] } }

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

describe('SessionProjectionCache resident budget', () => {
  it('resolves both bounds to the documented defaults, and passes explicit values through', () => {
    const bareCtx = new Context()
    contexts.push(bareCtx)
    // A hand-built config may omit the bounds; the loader schema normally fills
    // them in, so the constructor's own defaults must be the same numbers.
    const bare = new SessionProjectionCache(bareCtx, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    expect(bare.residentUsage).toEqual({ entries: 0, bytes: 0, maxEntries: 5000, maxBytes: 64 * 1024 * 1024 })

    const offCtx = new Context()
    contexts.push(offCtx)
    // 0 is the documented "this dimension is unbounded" spelling.
    const unbounded = new SessionProjectionCache(offCtx, {
      writeEveryEvents: 100, writeIntervalMs: 60_000, residentMaxEntries: 0, residentMaxBytes: 0,
    })
    expect(unbounded.residentUsage).toEqual({ entries: 0, bytes: 0, maxEntries: 0, maxBytes: 0 })
  })

  it('applies the same defaults through the loader schema and prices what it retains', async () => {
    const { ctx, cache } = await harness()
    expect(cache.residentUsage).toEqual({ entries: 0, bytes: 0, maxEntries: 5000, maxBytes: 64 * 1024 * 1024 })
    await markedSession(cache, ctx, SessionId('priced'))
    // The write admitted the record: the copy is not empty and it prices bytes.
    expect(cache.residentUsage.entries).toBe(1)
    expect(cache.residentUsage.bytes).toBeGreaterThan(0)
  })

  for (const [dimension, bounds] of [
    ['entry bound', { residentMaxEntries: 1, residentMaxBytes: 0 }],
    ['byte bound', { residentMaxEntries: 0, residentMaxBytes: 1 }],
  ] as const) {
    it(`drops the least recently served record under the ${dimension} without touching the durable one`, async () => {
      const { ctx, root, cache } = await harness({ writeEveryEvents: 100, writeIntervalMs: 60_000, ...bounds })
      const { session: first, markSeq } = await markedSession(cache, ctx, SessionId('resident-first'))
      expect(cache.residentUsage.entries).toBe(1)
      const { session: second } = await markedSession(cache, ctx, SessionId('resident-second'))
      // The second admission settled the budget: only the newest record stays.
      expect(cache.residentUsage.entries).toBe(1)

      // Eviction is memory-only: both durable documents are exactly as written.
      expect((await storedRows(root, first.id))?.['resident-test/marks']?.val).toEqual({ marks: ['a'] })
      expect((await storedRows(root, second.id))?.['resident-test/marks']?.val).toEqual({ marks: ['a'] })

      // A read of the dropped record refills the copy from the domain table and
      // serves the same block a hit would have served.
      expect(cache.cachedSnapshot(first.header)).toEqual({ asOfSeq: markSeq, values: markedValues })
      expect(cache.cachedSnapshot(first.header)?.values).toEqual(markedValues)
      expect(cache.residentUsage.entries).toBe(1)

      // A later write for the evicted session re-admits it and still serves.
      await cache.write(first)
      expect(cache.cachedSnapshot(first.header)?.values).toEqual(markedValues)
    })
  }

  it('deletes an archived session record from the copy and the medium, and rebuilds it on a later write', async () => {
    const { ctx, root, cache } = await harness()
    const { session } = await markedSession(cache, ctx, SessionId('archived'))
    // Served from the resident copy before the archive.
    expect(cache.cachedSnapshot(session.header)?.values).toEqual(markedValues)

    const purged = whenDeleted(ctx, session.id)
    archiveCommit(ctx, [session.id])
    await purged
    // The durable document is gone too — archiving, not memory pressure, is what
    // removes a record — so a listing read now misses and the consumer refolds.
    expect(cache.residentUsage.entries).toBe(0)
    expect(await storedRows(root, session.id)).toBeUndefined()
    expect(cache.cachedSnapshot(session.header)).toBeUndefined()
    // The archived session itself is untouched: archival is not a lifecycle end.
    expect(ctx.sessions.get(session.id)).toBe(session)

    // Unguarded again (an unarchive continues the session), the next checkpoint
    // recreates the record from scratch.
    await cache.write(session)
    expect((await storedRows(root, session.id))?.['resident-test/marks']?.val).toEqual({ marks: ['a'] })
    expect(cache.cachedSnapshot(session.header)?.values).toEqual(markedValues)
  })

  it('keeps a detached session record: disposal is a checkpoint, never a deletion', async () => {
    const { ctx, root, cache } = await harness()
    const id = SessionId('detached')
    // Register before the session exists: the creation write is the first one.
    const created = whenWritten(ctx, id)
    let session: Session | undefined
    // Sessions dispose with their owning fiber.
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    await created
    const written = whenWritten(ctx, id)
    await owner.dispose()
    await written

    // The detach write is the reason disposal cannot be treated as a deletion:
    // its checkpoint is the freshest value the listing reads want.
    expect((await storedRows(root, id))?.['resident-test/marks']?.val).toEqual(null)
    expect(cache.residentUsage.entries).toBe(1)
  })

  it('ignores every commit that is not a Workspace archive set', async () => {
    const { ctx, root, cache } = await harness()
    const { session } = await markedSession(cache, ctx, SessionId('guarded'))
    const deleted = vi.fn()
    ctx.on('domain/changed', (change) => {
      if (change.domain === projectionCacheDomainSpec.name && change.operation === 'deleted') deleted()
    })

    // Another domain's global, a Workspace *record* write, and a deletion of the
    // Workspace global all carry no archive set this cache may act on.
    ctx.emit('domain/changed', { domain: 'other', table: '', key: '', operation: 'put', value: { archivedSessionIds: [session.id] } })
    ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'w', operation: 'put', value: { archivedSessionIds: [session.id] } })
    ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'deleted' })
    // Values that carry no usable archive set read as "no information".
    ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: 'not-a-workspace-state' })
    ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: null })
    ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: {} })
    ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: 'not-an-array' } })
    // An archive set naming only ids this cache never held purges nothing and
    // must not spend a write-chain slot; the non-string member is dropped.
    archiveCommit(ctx, [7, 'never-cached'])

    // A durable write of our own queues behind anything those commits had
    // started, so awaiting it settles the question deterministically.
    await cache.write(session)
    expect(deleted).not.toHaveBeenCalled()
    expect(cache.residentUsage.entries).toBe(1)
    expect((await storedRows(root, session.id))?.['resident-test/marks']?.val).toEqual({ marks: ['a'] })
    expect(cache.cachedSnapshot(session.header)?.values).toEqual(markedValues)
  })

  it('keeps the record and warns when the durable deletion fails', async () => {
    const { ctx, root, cache } = await harness()
    const { session } = await markedSession(cache, ctx, SessionId('purge-fails'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A directory where the document must be removed makes the durable deletion
    // fail; the in-memory record the domain still holds stays authoritative.
    const path = recordPath(root, session.id)
    await rm(path, { force: true })
    await mkdir(path, { recursive: true })

    archiveCommit(ctx, [session.id])
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping archived session "purge-fails" failed'))
    }, { timeout: 5_000 })
    // Fail-soft: the failed deletion left the domain's record in place, so the
    // copy (invalidated before the attempt) simply refills from it and serves
    // exactly what it served before.
    expect(cache.residentUsage.entries).toBe(0)
    expect(cache.cachedSnapshot(session.header)?.values).toEqual(markedValues)
    expect(cache.residentUsage.entries).toBe(1)
  })
})
