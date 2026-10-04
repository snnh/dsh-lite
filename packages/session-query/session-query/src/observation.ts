/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import { createBoundedMap, createIdleCache } from '@deepseek-ai/dsh-memory'
import type { BoundedMap, IdleCache } from '@deepseek-ai/dsh-memory'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import {
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_IDLE_TTL_MS,
  SessionQueryError,
} from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
}

/**
 * One reusable cold observation: an unpublished restored Session plus the
 * exact balanced log it represents, valid while the producing persistence
 * instance still reports the same revision.
 */
interface PreparedEntry {
  /** Stable service identity whose `stat` produced this revision; proxy references are not instance identities. */
  readonly persistenceIdentity: symbol
  /** Durable revision observed by `stat` immediately before the log read. */
  readonly revision: SessionPersistenceRevision
  /** Unpublished Session restored from the balanced log; never entered into the store. */
  readonly session: Session
  /** Immutable balanced log (stored events plus in-memory interrupted-turn closers). */
  readonly events: readonly SessionEvent[]
  /**
   * Active observation leases. An entry with `refs > 0` is held by at least one
   * lease: it sits outside the reusable cache, so no budget and no idle sweep
   * can reclaim it until the last lease releases.
   */
  refs: number
}

/** Budget for the reusable cold-observation cache; every field has a default. */
export interface SessionObservationCacheOptions {
  /**
   * Maximum reusable prepared observations retained. Entries held by a lease
   * sit outside this bound until it releases them. Defaults to
   * {@link SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE}.
   */
  readonly maxEntries?: number
  /**
   * Estimated retained bytes above which the least recently used reusable entry
   * is dropped, priced over the restored Session and its frozen events by
   * `estimateJsonBytes`. `0`, or any other non-positive or non-finite value,
   * leaves the byte account unbounded. Defaults to
   * {@link SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES}.
   */
  readonly maxBytes?: number
  /**
   * Idle window in milliseconds: an untouched reusable entry is dropped once it
   * has been idle this long, reclaimed by a sweep that runs at most one window
   * later. `0`, or any other non-positive value, keeps entries resident until a
   * bound or a lease release drops them. Defaults to
   * {@link SESSION_QUERY_DEFAULT_PREPARED_SESSION_IDLE_TTL_MS}.
   */
  readonly idleTtlMs?: number
}

/**
 * Builds point observations without a corpus listing preflight.
 *
 * Cold reads are cached per session id, keyed by the persistence instance and
 * the `stat` revision observed before the log read: an unchanged revision
 * reuses the restored Session without re-reading the log. The cache is bounded
 * three ways — entry count, estimated bytes, and an idle window — and only
 * entries that no lease holds are ever reclaimed.
 *
 * An entry with an active lease (`refs > 0`) leaves the reusable cache for the
 * lease's lifetime and returns to it when the last lease releases, so a lease's
 * cut stays valid even after a newer revision lands and a lease is never
 * reclaimed to satisfy a budget. The cache can therefore hold more than the
 * count or byte bound while leases are outstanding; the excess is exactly the
 * leased entries, and it falls back to the bounds as those leases are released.
 * A cold observation is reclaimed without ever touching the stored session.
 */
export class SessionObservationReader {
  /** Reusable entries under the count, byte, and idle budgets. */
  private readonly cache: BoundedMap<SessionId, PreparedEntry>
  /** Idle window behind {@link cache}, when one is configured; the sweep a dispose stops. */
  private readonly idleCache: IdleCache<SessionId, PreparedEntry> | undefined
  /** Unpinned-entry bound that a release settles; see {@link trimOverBound}. */
  private readonly cacheCapacity: number
  /**
   * Leased entries by session id. One id holds at most one entry here: a newer
   * revision replaces a lease-visible older one, whose own lease keeps it alive
   * through the lease closure alone.
   */
  private readonly leased = new Map<SessionId, PreparedEntry>()

  /**
   * @param ctx - context carrying Session and optional persistence/projection services.
   * @param cache - reusable-cache budget, or the maximum entry count alone.
   */
  constructor(
    private readonly ctx: Context,
    cache: number | SessionObservationCacheOptions = {},
  ) {
    const options = typeof cache === 'number' ? { maxEntries: cache } : cache
    this.cacheCapacity = options.maxEntries ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const bounds = {
      maxEntries: this.cacheCapacity,
      maxBytes: options.maxBytes ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_BYTES,
    }
    const idleTtlMs = options.idleTtlMs ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_IDLE_TTL_MS
    if (idleTtlMs > 0) {
      const idle = createIdleCache<SessionId, PreparedEntry>({ ...bounds, idleTtlMs })
      this.idleCache = idle
      this.cache = idle
    } else {
      // No idle window: a plain bounded cache, with no sweep timer at all.
      this.idleCache = undefined
      this.cache = createBoundedMap<SessionId, PreparedEntry>(bounds)
    }
  }

  /**
   * Stop the idle sweep. Safe to call more than once, and the retained entries
   * stay readable — only reclamation stops.
   */
  [Symbol.dispose](): void {
    this.idleCache?.stop()
  }

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   * @throws {@link SessionQueryError} with code `SESSION_QUERY_CORRUPT_SESSION` when live or prepared projection computation fails.
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      const snapshot = await this.statSource(persistence, sessionId, signal)
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (attachedDuringStat !== undefined) return this.live(attachedDuringStat, projectionMode)
      let entry = this.cachedEntry(persistence.identity, sessionId, snapshot.revision)
      if (entry === undefined) {
        const loaded = await this.loadSource(persistence, sessionId, signal)
        throwIfObservationAborted(signal)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.live(attached, projectionMode)
        // The handle marks persisted events as adoptable; synthetic closers
        // are owned by this read, so the combined seed needs no copy.
        const seed = loaded.events
        let session: Session
        try {
          session = this.ctx.sessions.prepare(sessionId, {
            seed,
            meta: structuredClone(loaded.header),
            inheritedEventCount: loaded.inheritedEventCount,
            eventState: loaded.eventState,
          })
        } catch (error: unknown) {
          // The store rejects an id with a live owner: that owner is the
          // fresher source, so retry the live path. Any other rejection means
          // the stored log failed restore validation.
          if (this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        entry = {
          persistenceIdentity: persistence.identity,
          revision: snapshot.revision,
          session,
          events: Object.freeze(seed),
          refs: 0,
        }
        this.store(sessionId, entry)
      }

      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          `failed to project session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_CORRUPT_SESSION',
          { cause: error },
        )
      }
      return this.preparedLease(sessionId, entry, projections)
    }
  }

  /** Observe the stored snapshot, mapping absence and backend failures to the query taxonomy. */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
    throwIfObservationAborted(signal)
    if (snapshot === undefined) throw notFound(sessionId)
    if (snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** Read the complete balanced cold log, mapping backend failures to the query taxonomy. */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
  }

  /** Return a still-valid cached entry and mark it most recently used. */
  private cachedEntry(
    persistenceIdentity: symbol,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
  ): PreparedEntry | undefined {
    const reusable = this.cache.get(sessionId)
    if (reusable !== undefined) {
      // A hit restamps recency and idle activity; a different revision is
      // superseded by the one just observed, so it keeps no reuse value.
      if (matchesRevision(reusable, persistenceIdentity, revision)) return reusable
      this.cache.delete(sessionId)
    }
    const leased = this.leased.get(sessionId)
    return leased !== undefined && matchesRevision(leased, persistenceIdentity, revision)
      ? leased
      : undefined
  }

  /** Insert or replace the entry for one id, leaving both bounds to the cache. */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // Replacing a stale revision only drops the cache's reference; live leases
    // keep the old entry alive through their own references.
    this.cache.set(sessionId, entry)
  }

  /** Take one lease reference, moving the first one out of the reusable cache. */
  private pin(entry: PreparedEntry): void {
    entry.refs += 1
    if (entry.refs > 1) return
    const sessionId = entry.session.id
    // Whatever the cache holds under this id is either this entry or a
    // revision the read that produced this entry has just superseded.
    this.cache.delete(sessionId)
    this.leased.set(sessionId, entry)
  }

  /** Drop one lease reference, returning the entry to the reusable cache at zero. */
  private unpin(entry: PreparedEntry): void {
    entry.refs -= 1
    if (entry.refs > 0) return
    const sessionId = entry.session.id
    // A newer revision took this id over while the lease held it: the released
    // cut has no reuse value, and the lease closure alone keeps it alive.
    if (this.leased.get(sessionId) !== entry) return
    this.leased.delete(sessionId)
    if (!this.cache.has(sessionId)) this.cache.set(sessionId, entry)
    this.trimOverBound()
  }

  /**
   * Settle the count bound after a release returned an entry to the cache.
   * Leased entries are not candidates: they are the reason the total may sit
   * over the bound, and they fall back under it as their own leases release.
   */
  private trimOverBound(): void {
    while (this.leased.size + this.cache.size > this.cacheCapacity && this.cache.size > 0) {
      this.evictLeastRecentlyUsed()
    }
  }

  /** Drop the least recently used reusable entry; the caller proved one exists. */
  private evictLeastRecentlyUsed(): void {
    for (const oldest of this.cache.keys()) {
      this.cache.delete(oldest)
      return
    }
  }

  /** Build one disposable lease over a cached entry, pinning it until every lease releases. */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    this.pin(entry)
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          this.pin(entry)
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          this.unpin(entry)
        },
      }
    }
    return lease()
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    // The cut is the log length now. The log only appends, so the prefix
    // below `seq` is the same array whenever a consumer first reads `events`.
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    let projections: ProjectionSnapshot | undefined
    try {
      projections = projectionMode === 'none'
        ? undefined
        : this.ctx.get('sessionProjections')?.snapshot(session)
    } catch (error: unknown) {
      throw new SessionQueryError(
        `failed to project session "${session.id}": ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          materialized ??= session.snapshotEvents(SessionLogOffset(0), seq)
          return materialized
        },
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

/**
 * Whether one prepared entry answers a read of the given source revision.
 * @param entry - the retained preparation.
 * @param persistenceIdentity - persistence instance the read observed.
 * @param revision - durable revision the read observed.
 * @returns true when the entry is exactly that cut.
 */
function matchesRevision(
  entry: PreparedEntry,
  persistenceIdentity: symbol,
  revision: SessionPersistenceRevision,
): boolean {
  return entry.persistenceIdentity === persistenceIdentity && entry.revision === revision
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
