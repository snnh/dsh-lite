/**
 * The archive-time resident clearing: archiving a session whose canonical path
 * is absent from the header index drops its cached header and the reason its
 * cwd could not be validated, because no listing projects such an id
 * (`Workspace.sessionIds` keeps an account id exactly while `sessionPaths`
 * resolves its path). The clearing is memory-only — the archive write stays the
 * only durable effect — and it never touches an id a project still lists: that
 * pair is the display state, and `unarchiveSession` restores the session's
 * position without reading session persistence.
 *
 * The residency itself is observed through the index's own refill path: an id
 * whose header the index holds is "known" without a persistence listing, while
 * a dropped one forces the next `archiveSession` to re-list and re-index.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from '../src/index.ts'

const header = (id: string, cwd?: string, createdAt = 0): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SessionId(id),
  createdAt,
  isSeeded: false,
  ...(cwd === undefined ? {} : { cwd }),
})

/** Boot the registry over a controllable header-only persistence peer. */
async function harness(sessions: SessionHeader[]) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    sessions.map(session => ({ header: session, revision: SessionPersistenceRevision(`rev-${session.id}`) })))
  ctx.provide('sessionPersistence', {
    list,
    open: vi.fn(() => { throw new Error('event bodies must not be opened') }),
    stat: vi.fn(() => { throw new Error('per-session stat must not be needed') }),
  } as never)

  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  changes.length = 0
  return { ctx, fiber, pool, registry: ctx.workspaceRegistry, changes, list }
}

/** The durable registry state the medium holds. */
function storedState(pool: MemoryMediaPool): WorkspaceDomainState {
  return pool.media.get('workspace')!.global as WorkspaceDomainState
}

/** The durable record of one workspace on the medium. */
function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

let base: string
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-residency-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('archive-time resident clearing', () => {
  it('drops the header and reason of an archived session no listing projects', async () => {
    const dir = await makeDir('unprojected-home')
    const result = await harness([
      header('kept', dir, 100),
      header('cwd-less', undefined, 200),
      header('missing-dir', join(base, 'not-there'), 300),
    ])
    // Bootstrap groups the one session whose cwd resolves; the other two are
    // indexed with a reason and projected by nobody.
    expect(result.registry.list().map(workspace => workspace.sessionIds)).toEqual([['kept']])
    expect(result.list).toHaveBeenCalledTimes(1)
    const listings = () => result.list.mock.calls.length

    for (const id of ['cwd-less', 'missing-dir']) {
      const before = listings()
      // The header is resident, so knowing the session costs no listing.
      await result.registry.archiveSession(SessionId(id))
      expect(listings()).toBe(before)
      expect(result.registry.archivedSessionIds).toContain(id)
      // Restoring reads no persistence, and makes the id archivable again.
      await result.registry.unarchiveSession(SessionId(id))
      expect(listings()).toBe(before)
      // The archived trace is gone: this archive has to re-list and re-index.
      await result.registry.archiveSession(SessionId(id))
      expect(listings()).toBe(before + 1)
    }

    // Every archive wrote the archive set and nothing else.
    expect(result.changes.every(change => change.table === '')).toBe(true)
    expect(result.changes).toHaveLength(6)
    expect(storedState(result.pool).archivedSessionIds).toEqual([SessionId('cwd-less'), SessionId('missing-dir')])
  })

  it('drops the pair of an archived session whose re-indexed cwd stopped resolving', async () => {
    const dir = await makeDir('vanishing-home')
    const result = await harness([header('vanishing', dir, 100)])
    const workspace = result.registry.list()[0]!
    expect(workspace.sessionIds).toEqual(['vanishing'])

    // The directory disappears, and a miss on another id re-indexes every
    // stored header: this session's pair moves from the path table to the
    // invalid table, and the projection follows it out of the workspace.
    await rm(dir, { recursive: true })
    await expect(result.registry.archiveSession(SessionId('ghost')))
      .rejects.toThrow(/cannot archive session 'ghost'/)
    expect(workspace.sessionIds).toEqual([])

    const before = result.list.mock.calls.length
    // The header is still resident, so this archive needs no listing.
    await result.registry.archiveSession(SessionId('vanishing'))
    expect(result.list.mock.calls.length).toBe(before)
    expect(result.registry.archivedSessionIds).toEqual(['vanishing'])
    expect(storedRecord(result.pool, String(workspace.id)).sessionIds).toEqual([SessionId('vanishing')])

    // Header and reason left together: the next archive re-lists and re-indexes.
    await result.registry.unarchiveSession(SessionId('vanishing'))
    await result.registry.archiveSession(SessionId('vanishing'))
    expect(result.list.mock.calls.length).toBe(before + 1)
  })

  it('keeps the resident pair of an archived session a project still lists', async () => {
    const dir = await makeDir('projected-home')
    const result = await harness([header('kept', dir, 100), header('gone', dir, 200)])
    const workspace = result.registry.list()[0]!
    expect(workspace.sessionIds).toEqual(['gone', 'kept'])
    expect(result.list).toHaveBeenCalledTimes(1)
    const listings = () => result.list.mock.calls.length

    // Two archive/restore rounds, and no round re-lists: the resident header
    // and its canonical path stay, because that path is what the projection —
    // and therefore the Workspace feed — reads for this session.
    for (let round = 0; round < 2; round += 1) {
      await result.registry.archiveSession(SessionId('gone'))
      expect(workspace.sessionIds).toEqual(['gone', 'kept'])
      await result.registry.unarchiveSession(SessionId('gone'))
      expect(workspace.sessionIds).toEqual(['gone', 'kept'])
    }
    expect(listings()).toBe(1)

    // Memory only: the durable account keeps the id and its position.
    const record = storedRecord(result.pool, String(workspace.id))
    expect(record.sessionIds).toEqual([SessionId('gone'), SessionId('kept')])
    expect(result.changes.every(change => change.table === '')).toBe(true)
    expect(result.changes).toHaveLength(4)
  })

  it('drops the trace before the stop providers run and never fails the archive for it', async () => {
    const result = await harness([header('cwd-less', undefined, 100)])
    const order: string[] = []
    result.ctx.on('workspace/session-stop', () => { order.push('stop'); throw new Error('job kill exploded') })
    const warn = vi.spyOn(result.ctx.logger, 'warn').mockImplementation(() => {})

    await expect(result.registry.archiveSession(SessionId('cwd-less'), { stopActivity: true })).resolves.toBeUndefined()
    expect(order).toEqual(['stop'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('job kill exploded'))
    expect(result.registry.archivedSessionIds).toEqual(['cwd-less'])

    // The trace left with the archive, not with the stops: this second archive
    // has to re-list the dropped header.
    await result.registry.unarchiveSession(SessionId('cwd-less'))
    const before = result.list.mock.calls.length
    await result.registry.archiveSession(SessionId('cwd-less'), { stopActivity: true })
    expect(result.list.mock.calls.length).toBe(before + 1)
    expect(storedState(result.pool).archivedSessionIds).toEqual([SessionId('cwd-less')])
  })
})
