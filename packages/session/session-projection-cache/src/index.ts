/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every projection unit's state, one record per session on
 * the `session_projcache` domain (`per-record` layout — the shipped json
 * backend stores one document per session under its root). Reads and writes
 * share ONE coherent state: the domain's in-memory tables serve every read
 * synchronously, and each write lands on the domain's write chain (durability
 * first, then memory), so a read can never observe a disk write the memory
 * has not applied, or a memory value the disk does not hold. The cache is a
 * fold shortcut, never an authority: a row
 * is possibly stale (its `seq` says how stale) but never wrong, so every
 * write path is fail-soft (a lost write costs a longer tail replay on the
 * next cold read) and a `ver` mismatch discards the row instead of migrating
 * it. Reads are served from this service's own budgeted copy of the domain's
 * records (`residentMaxEntries`/`residentMaxBytes`); dropping a record from
 * that copy is a memory-only decision that never touches the durable one, and
 * the domain's table remains the source a dropped record is refilled from.
 * Archiving a session is the one durable statement that its record is no
 * longer worth keeping, so it deletes the record — resident and durable —
 * while disposing a session only checkpoints it. Design authority: the
 * session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createBoundedMap } from '@deepseek-ai/dsh-memory'
import type { BoundedMap } from '@deepseek-ai/dsh-memory'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {
  ProjectionCheckpoint,
  ProjectionSnapshot,
  SessionProjectionMap,
} from '@deepseek-ai/dsh-session-projection'
import type { DomainChanged, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

/**
 * The identity a Session header alone witnesses: the format generation the
 * fold must have run under and the fields that distinguish one lifecycle
 * stored under a session id. The read-only listing face matches exactly this.
 */
type LifecycleIdentity = Omit<CurrentCheckpointIdentity, 'inheritedEventCount'>

/**
 * Complete identity written by the current cache generation: the lifecycle
 * identity plus the exact inherited cut, which only a caller holding the
 * Session or its body knows. The fold face (hydration, checkpoint writes)
 * matches this.
 */
type CurrentCheckpointIdentity = CheckpointIdentity & {
  formatVersion: number
  isSeeded: boolean
  inheritedEventCount: SessionLogOffset
}

const PREDECESSOR_TITLE_KEY = 'title' as Extract<keyof SessionProjectionMap, string>

/**
 * Entry bound of the resident copy ({@link Config.residentMaxEntries}) when the
 * composition leaves it unset. A record carries one row per projection of one
 * session — roughly 1–20 KB — so 5000 entries sit two orders of magnitude above
 * the working set of any listing a host serves at once, while a catalog that
 * grows with the session directory stops pinning one record per session for
 * the lifetime of the process.
 */
const DEFAULT_RESIDENT_MAX_ENTRIES = 5000

/**
 * Byte bound of the resident copy ({@link Config.residentMaxBytes}) when the
 * composition leaves it unset. Records are unevenly sized (a long schedule or
 * subagent catalog in one session outweighs hundreds of quiet ones), so the
 * byte account is what actually prices the copy; 64 MiB is a fraction of the
 * 256 MiB resident-set threshold the memory policy reacts to, which keeps this
 * cache from dominating the host's footprint. Both bounds are deliberately
 * generous rather than tight: evicting a record that listing reads want costs a
 * refill from the domain table, and eviction of the *durable* record would cost
 * a cold refold (empty titles, slower first paint), which is why no bound ever
 * deletes a record.
 */
const DEFAULT_RESIDENT_MAX_BYTES = 64 * 1024 * 1024

/**
 * The Workspace registry's domain (`packages/workspace/workspace/src/spec.ts`),
 * whose global singleton carries `archivedSessionIds`. The cache watches that
 * domain's commits through `domain/changed` instead of depending on the
 * registry package: archiving is the one durable statement that a session's
 * cached record is no longer worth keeping, and it arrives as a whole-set
 * snapshot that this cache reads structurally.
 */
const WORKSPACE_DOMAIN = 'workspace'

export { checkpointIdentity, checkpointRecord, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointIdentity, CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the three mandatory write points (session creation,
 * `turn/end`, and session disposal) are policy, not tunables, and always
 * fire. The two resident bounds are the opposite kind of setting: they have
 * conservative defaults a composition may tighten or lift, because a cache
 * that grows with the session directory is what the bound exists to prevent.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
  /**
   * Session records the resident copy retains before it drops the least
   * recently served ones; `0` leaves the entry count unbounded.
   * @default 5000
   */
  residentMaxEntries?: number
  /**
   * Estimated bytes the resident copy retains before it drops the least
   * recently served records; `0` leaves the byte account unbounded.
   * @default 67108864
   */
  residentMaxBytes?: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
  residentMaxEntries: z.natural().default(DEFAULT_RESIDENT_MAX_ENTRIES),
  residentMaxBytes: z.natural().default(DEFAULT_RESIDENT_MAX_BYTES),
})

/** Per-session write-behind bookkeeping (live sessions only; dropped at retire). */
interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus three mandatory points —
 * session creation, `turn/end`, and session disposal (the live-to-cold
 * moment) — and serves the
 * cached rows for a session header. Every durable write is fail-soft:
 * failures log a warning and the cache self-heals on the next write. Reads are
 * served from a budgeted resident copy of the domain's records; the domain
 * table is the authority that copy is refilled from, and archiving a session
 * (observed through the Workspace registry's commits) deletes its record from
 * both.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()
  /**
   * Resident copy of the records the read faces serve: the sessions a host
   * reads most recently, under {@link Config.residentMaxEntries} and
   * {@link Config.residentMaxBytes}. It starts empty and is admitted from the
   * domain table, so it is always a subset of the domain's records — dropping
   * an entry here costs one refill and never a durable delete. The invariant
   * every read relies on is that this copy never holds a record older than the
   * table's: a write invalidates its entry before the table can change and
   * re-admits it once the write landed, and a deletion invalidates it before
   * the record leaves the table.
   */
  private readonly resident: BoundedMap<SessionId, CheckpointRecord>
  /** Effective entry bound of {@link resident}; `0` leaves the count unbounded. */
  private readonly residentMaxEntries: number
  /** Effective byte bound of {@link resident}; `0` leaves the byte account unbounded. */
  private readonly residentMaxBytes: number

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
    // A hand-built config may omit the bounds (the loader schema fills them in
    // from `Config`), and the documented defaults are what an omitted bound
    // must mean — never an unbounded copy.
    this.residentMaxEntries = config.residentMaxEntries ?? DEFAULT_RESIDENT_MAX_ENTRIES
    this.residentMaxBytes = config.residentMaxBytes ?? DEFAULT_RESIDENT_MAX_BYTES
    this.resident = createBoundedMap<SessionId, CheckpointRecord>({
      maxEntries: this.residentMaxEntries,
      maxBytes: this.residentMaxBytes,
    })
  }

  /**
   * Open the domain and install the write-behind listeners.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    this.installWritePath()
    this.installArchivePurge()
  }

  /**
   * The resident copy's own reading: the records it retains, the bytes it
   * prices them at, and the bounds in force (`0` = that dimension unbounded).
   * Diagnostics only — an eviction here never touches a durable record, and
   * every record the domain table holds stays readable afterwards.
   * @returns retained entry count, priced bytes, and the effective bounds.
   */
  get residentUsage(): {
    readonly entries: number
    readonly bytes: number
    readonly maxEntries: number
    readonly maxBytes: number
  } {
    return {
      entries: this.resident.size,
      bytes: this.resident.bytes,
      maxEntries: this.residentMaxEntries,
      maxBytes: this.residentMaxBytes,
    }
  }

  /**
   * The record the domain holds for one session, admitted to the resident copy
   * on the way out. A copy hit is served directly (and re-stamped as the most
   * recently used entry); a miss the domain table can answer refills the copy,
   * and a miss in both is a session this cache holds no record for.
   * @param id - the session whose record is read.
   * @returns the stored record, or `undefined` when neither copy holds one.
   */
  private storedRecord(id: SessionId): CheckpointRecord | undefined {
    const resident = this.resident.get(id)
    if (resident !== undefined) return resident
    const stored = this.requireTable().get(id)
    if (stored !== undefined) this.resident.set(id, stored)
    return stored
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the resident copy, which the domain's in-memory state
   * refills — never from the medium.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CurrentCheckpointIdentity): CheckpointRecord | undefined {
    const record = this.storedRecord(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only) of the record bound to the caller's
   * lifecycle. The header is the only identity witness a listing holds, so
   * this face matches the lifecycle identity (`formatVersion`, `createdAt`,
   * `cwd`, `isSeeded`) and not the inherited cut: within one format
   * generation the cut is fixed at fork time, so it distinguishes no
   * lifecycle the other fields do not, and a viewed value never seeds a fold.
   * The view is as stale as the last durable checkpoint but never wrong and
   * never from an unrelated log. Its `asOfSeq` is the lowest watermark among
   * the served rows: the stored record's own position, which the header
   * cannot relate to the log the caller later opens. The Session list
   * therefore labels the block as cached, and the client lets every value the
   * connected Session produces supersede it whatever this number says.
   * @param meta - the listed session's header (identity witness; no log read).
   * @param keys - optional projection keys required by the caller's audience.
   * @returns the viewed block, or `undefined` when no usable row exists for
   *   this lifecycle at the current Session format.
   */
  cachedSnapshot(
    meta: SessionHeader,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.storedRecord(meta.id)
    if (record === undefined || !currentLifecycleMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, keys)
  }

  /**
   * Read only a predecessor checkpoint's title as a zero-I/O listing hint.
   *
   * The authoritative Session header supplies the lifecycle identity. A cache
   * checkpoint can lag that log but cannot lead it because writes flush the
   * log first, so a matching predecessor title is a genuine (possibly stale)
   * fact from this Session. The registry still requires the current title
   * projection's row version and schema. No other predecessor projection is
   * exposed: format normalization can change their current meaning, and the
   * {@link cachedSnapshot} / hydration paths continue to reject them.
   * @param meta - authoritative listed Session header.
   * @returns a title-only block at the stored title row's watermark, or
   *   `undefined` when the record is current, newer, unrelated, missing, or
   *   incompatible with the title unit.
   */
  cachedPredecessorTitle(meta: SessionHeader): ProjectionSnapshot | undefined {
    const expected = lifecycleIdentityOf(meta)
    const record = this.storedRecord(meta.id)
    if (record === undefined || !predecessorIdentityMatches(record.identity, expected)) return undefined
    return this.viewRecord(record, [PREDECESSOR_TITLE_KEY])
  }

  /**
   * View selected wire rows as one block bound to the lowest served
   * watermark: the seq every served value has folded through at least. The
   * number is the record's own; whether a consumer may compare it with a
   * live Session's seqs is decided by the face that serves the block, not
   * here.
   */
  private viewRecord(
    record: CheckpointRecord,
    keys?: readonly Extract<keyof SessionProjectionMap, string>[],
  ): ProjectionSnapshot | undefined {
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows, keys)
    let asOfSeq: ProjectionSnapshot['asOfSeq'] | undefined
    for (const [key, row] of Object.entries(record.rows)) {
      if (!Object.hasOwn(values, key)) continue
      if (asOfSeq === undefined || row.seq < asOfSeq) asOfSeq = row.seq
    }
    return asOfSeq === undefined ? undefined : { asOfSeq, values }
  }

  /**
   * Hydrate projection cells for an already-prepared Session without another
   * persistence read. The cache seeds matching rows; the supplied exact log
   * advances every unit to the observation cut. No checkpoint is written
   * because the logical observation may contain recovery events not yet durable.
   * @param session - exact unpublished Session retained by persistence.
   * @param events - exact logical event prefix represented by the observation.
   * @returns all projection values at the event cut.
   */
  hydratePrepared(
    session: Session,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const record = this.recordFor(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
    )
    if (record === undefined) {
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
    try {
      return this.ctx.sessionProjections.hydrate(
        session,
        record.rows,
        events,
        SessionLogOffset(0),
      )
    } catch {
      // Cached rows are disposable derived data. Retry from the exact log so a
      // stale schema cannot make a valid Session unreadable.
      return this.ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0))
    }
  }

  /**
   * Durably checkpoint one live session NOW (all mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the session's record is
   * replaced on the domain's write chain. NOT fail-soft — callers on the
   * fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(
      session.id,
      identityOf(session.header, session.inheritedEventCount),
      rows,
    )
  }

  /**
   * Cold-read one session's projections from its complete log. Each unit is
   * seeded from the identity-checked cached rows — the registry skips `apply`
   * for the already-folded prefix (events at or below the row's `seq`) — and
   * the refreshed checkpoint is written back (fail-soft, fire-and-forget), so
   * the first cold read creates the cache row and later ones seed from it.
   * The caller supplies the complete log in seq order: this service never
   * consults the persistence layer.
   * @param meta - the stored session header (identity witness).
   * @param inheritedEventCount - exact inherited prefix length for projection initialization and identity.
   * @param events - the session's complete log, in seq order.
   * @returns the projection cut at the log end.
   */
  coldSnapshot(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot {
    const identity = identityOf(meta, inheritedEventCount)
    const restored = this.ctx.sessionProjections.restore(
      this.recordFor(meta.id, identity)?.rows ?? {},
      events,
      SessionLogOffset(0),
      meta,
      inheritedEventCount,
    )
    // Refresh the row so the next cold read seeds from it; fail-soft and
    // fire-and-forget — a failed write-back only costs a longer tail replay.
    void this.put(meta.id, identity, restored.checkpoint).catch((error: unknown) => {
      this.ctx.logger.warn(`session projection cache: cold-read write-back for "${meta.id}" failed (cache stays stale): ${String(error)}`)
    })
    return restored.snapshot
  }


  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Creation is the FIRST mandatory point: a session that never talks (a
    // forked child seeded with its ancestor's title, say) would otherwise
    // get its first row only at detach — so a crash, or a fork held live in
    // the store, would leave the seed-derived values (the title) unreadable
    // on the cold list. The creation write captures the seed-derived cut.
    this.ctx.on('session/created', (session: Session) => {
      void this.flushSoft(session, 'create')
    })

    // Detach (the live-to-cold moment): the final mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    // Detach WRITES and never deletes: a detached session is still a listed
    // session, and the checkpoint taken here is the value those listings read
    // (deleting on detach would throw away the cut it just made). Only an
    // archival removes a record — see `installArchivePurge`.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // With the plugin (their sessions outlive the cache): clear pending
    // timers and stop accepting new work. The domain-close effect registered
    // in init runs after this disposer and drains already-queued writes, so
    // a late flush can never land after disposal (it rejects `closed` into
    // flushSoft's warning instead).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Replace one session's stored record with its log identity and a detached snapshot of `rows`. */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    const record: CheckpointRecord = { identity, rows: detached as CheckpointRecord['rows'] }
    // The copy must never serve a record the table has already replaced, so it
    // is invalidated before the table can change and re-admitted once the write
    // landed (durability first, then memory — a rejected write leaves the copy
    // empty for this id, and the next read refills it from the unchanged
    // table).
    this.resident.delete(id)
    await this.requireTable().put(id, record)
    this.resident.set(id, record)
  }

  /**
   * Drop cached records whose sessions the Workspace registry has archived.
   *
   * Archiving is the durable statement that a session's cached record is no
   * longer worth keeping (the archive set hides it from every listing surface,
   * so its rows serve no reader), and the commit that carries it delivers the
   * whole set — so one commit after boot is enough to learn every archival the
   * process never saw. Nothing else deletes a record: disposal (the live-to-cold
   * moment) only checkpoints, because a detached session is still listed and
   * still serves its rows.
   *
   * The domain name and the archived-id field are read structurally rather
   * than through an import of the registry package — this cache stays a
   * storage-domain consumer, and a value it does not recognize is ignored
   * instead of failing a cache path.
   */
  private installArchivePurge(): void {
    this.ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== WORKSPACE_DOMAIN || change.table !== '' || change.operation !== 'put') return
      const archived = archivedSessionIdsOf(change.value)
      if (archived === undefined) return
      for (const id of archived) {
        void this.purgeArchived(SessionId(id)).catch((error: unknown) => {
          this.ctx.logger.warn(`session projection cache: dropping archived session "${id}" failed (its record stays cached): ${String(error)}`)
        })
      }
    })
  }

  /**
   * Delete one archived session's record: the domain's record first (queued on
   * the write chain, so it lands after any checkpoint write already committed
   * and before later ones), then the resident copy. The copy is invalidated
   * before the deletion so it can never serve a record the table has already
   * dropped, and a rejected durable deletion leaves both the table and the
   * medium unchanged — the next read simply refills the copy from the table.
   * The record stays rebuildable from its own log whenever that session is read
   * again after an unarchive.
   * @param id - the archived session.
   * @returns resolution after durability, or immediately when nothing is cached.
   */
  private async purgeArchived(id: SessionId): Promise<void> {
    // One workspace commit carries the whole archive set, most of which this
    // cache never held: an absent record must not spend a write-chain slot.
    if (!this.resident.has(id) && this.requireTable().get(id) === undefined) return
    this.resident.delete(id)
    await this.requireTable().delete(id)
    // A checkpoint that completed while this deletion sat on the write chain
    // may have re-admitted its record: the archive state, not that write,
    // decides whether the copy keeps an entry.
    this.resident.delete(id)
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

/**
 * Read the archived-session ids out of a Workspace-registry global snapshot.
 * The value crosses a package boundary this cache deliberately does not import,
 * so it is read structurally and defensively: anything that is not an object
 * carrying an array of string ids reports "no archive information" — ignoring
 * a foreign or unreadable snapshot is always safer than failing a cache path
 * that runs inside another package's commit.
 * @param value - the `put` snapshot carried by `domain/changed`.
 * @returns the archived ids (possibly empty), or `undefined` when the value
 *   carries no archive set at all.
 */
function archivedSessionIdsOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const archived = (value as { archivedSessionIds?: unknown }).archivedSessionIds
  if (!Array.isArray(archived)) return undefined
  return archived.filter((id): id is string => typeof id === 'string')
}

/** Project a header onto the identity fields a header alone can witness. */
function lifecycleIdentityOf(header: SessionHeader): LifecycleIdentity {
  return {
    formatVersion: header.version,
    createdAt: header.createdAt,
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    isSeeded: header.isSeeded,
  }
}

/** Project a header and its exact inherited cut onto the complete fold identity. */
function identityOf(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): CurrentCheckpointIdentity {
  const cut = SessionLogOffset(inheritedEventCount)
  if (!header.isSeeded && cut !== 0) {
    throw new Error('unseeded projection-cache identity inherited event count must be 0')
  }
  return { ...lifecycleIdentityOf(header), inheritedEventCount: cut }
}

/**
 * Whether a stored record may seed the caller's fold: the current format
 * generation, the same lifecycle, and the same inherited cut. A record folded
 * under another cut encodes that cut in unit states (`schedule`,
 * `subagentCatalog`, `permissions`) and would carry it into the continued
 * fold and the next checkpoint. Absent lineage fields (records admitted via
 * `compatibleVersions` predate them) read as the unseeded lineage: exact for
 * an unseeded caller, while a seeded caller fails the match.
 */
function identityMatches(stored: CheckpointIdentity, expected: CurrentCheckpointIdentity): boolean {
  return currentLifecycleMatches(stored, expected)
    && (stored.inheritedEventCount ?? 0) === expected.inheritedEventCount
}

/**
 * Whether a stored record was folded from the caller's lifecycle at the
 * current Session format. An absent format generation cannot prove the fold
 * semantics and never matches. This is the whole identity a header-only
 * reader can check, and the whole identity a view needs.
 */
function currentLifecycleMatches(stored: CheckpointIdentity, expected: LifecycleIdentity): boolean {
  return stored.formatVersion === expected.formatVersion
    && lifecycleIdentityMatches(stored, expected)
}

/** Match one predecessor cache record to the authoritative listed lifecycle. */
function predecessorIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  const predecessor = stored.formatVersion === undefined
    || stored.formatVersion < expected.formatVersion
  return predecessor && lifecycleIdentityMatches(stored, expected)
}

/** Match the format-independent fields that distinguish one Session lifecycle. */
function lifecycleIdentityMatches(
  stored: CheckpointIdentity,
  expected: LifecycleIdentity,
): boolean {
  return stored.createdAt === expected.createdAt
    && stored.cwd === expected.cwd
    && (stored.isSeeded ?? false) === expected.isSeeded
}

export default SessionProjectionCache
