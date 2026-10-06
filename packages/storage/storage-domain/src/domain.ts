/**
 * Runtime of one open domain: authoritative state, the single per-domain
 * write chain, and change-event emission. An eager domain (the default) keeps
 * every table resident and serves reads synchronously from that memory; a
 * lazy domain holds no record at all and serves reads as durable point reads.
 * Either way every write queues on the chain, awaits backend durability
 * FIRST, then publishes the new value (to memory for an eager domain, to the
 * medium for a lazy one), then emits `domain/changed` — a rejected backend
 * write leaves the readable state untouched (no divergence between reads and
 * the medium), and events carry values that equal the readable state at
 * emission, in write order.
 *
 * This module also owns the durable-boundary validation pair that the runtime
 * and the facility share: {@link parseRecord} (one zod parse, failure
 * translated to `invalid-record` with its location) and
 * {@link skipInvalidRecord} (the spec's `invalidRecords` policy applied to one
 * failing record).
 * @module @deepseek-ai/dsh-storage-domain/src/domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import type { ZodType } from 'zod'
import { DomainError } from './error.ts'
import type { DomainSpec, DomainGlobalSpec, TableKeyOf, TableValueOf } from './spec.ts'
import type { DomainChanged } from './events.ts'

/** Handle on a domain's global singleton. */
export interface DomainGlobal<G> {
  /**
   * Current value, synchronously from the authoritative in-memory state.
   * Before the first `set` this is the spec's `initial`.
   * @returns the current global value.
   */
  get(): G

  /**
   * Replace the value durably. Queued on the domain's write chain; the first
   * `set` is what materializes the global on the medium.
   * @param value - New value; must satisfy the spec's schema (not re-checked
   * here — validation happens at the durable read boundary).
   * @returns resolution after durability and event emission.
   */
  set(value: G): Promise<void>
}

/**
 * Handle on one declared table of a table-resident (eager) domain. Records
 * are plain immutable data: returned values are the stored objects themselves
 * (no defensive copies) and must not be mutated in place — replace via
 * `put`/`update`.
 */
export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the
   * value current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/**
 * Handle on one declared table of a lazy-residency domain
 * (`residency: 'lazy'`). Nothing is resident: every read is a durable point
 * read through the unit and re-validates the record it just fetched.
 *
 * The surface is deliberately smaller than {@link KvTable}. A synchronous
 * `get`, and `entries`/`keys`/`size`, all promise the record, the whole
 * table, or its membership from memory — a lazy domain holds none of that, so
 * a synchronous read of a non-resident record could only return a lie (or a
 * value a queued write is about to replace). Point reads are asynchronous
 * precisely because the answer lives on the medium.
 *
 * Records are plain immutable data: returned values are the stored objects
 * themselves (no defensive copies) and must not be mutated in place — replace
 * via `put`/`update`.
 */
export interface LazyKvTable<K extends string, V> {
  /**
   * Read one record durably from the medium, validated against the table's
   * schema. Absent content — an unwritten key, an undeclared table, or a
   * record the unit cannot read — resolves `undefined`; a stored record that
   * fails the schema follows the spec's `invalidRecords` policy instead
   * (rejecting `invalid-record` by default, backed up and read as absent
   * under `'backup-and-skip'`).
   * @param key - Record key.
   * @returns the validated record, or `undefined` when absent.
   */
  read(key: K): Promise<V | undefined>

  /**
   * Insert or overwrite one record durably. Queued on the domain's write
   * chain like every other write.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case). Existence is decided at the
   * job's chain slot, so an earlier queued `put` of the same key is observed.
   */
  delete(key: K): Promise<boolean>

  /**
   * Atomic read-modify-write on the domain's write chain: the record is
   * re-read from the medium at this job's queue slot, so concurrent updates
   * never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** Global handle of a spec: typed when declared, `never` (inaccessible) when not. */
export type DomainGlobalHandleOf<S extends DomainSpec> =
  S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never

/** One open domain, typed by its spec. */
export interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance. Which shape a handle has follows the spec's
   * `residency`: only `residency: 'lazy'` yields a {@link LazyKvTable}
   * (durable point reads, nothing resident); every other domain yields the
   * fully resident {@link KvTable}.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): S extends { readonly residency: 'lazy' }
    ? LazyKvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
    : KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}

/** Internal boundary handing table handles their domain-owned write machinery. */
interface TableHost {
  readonly domainName: string
  readonly unit: KvUnit
  /** Queue one job on the domain's single write chain. */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** Throw `closed` once the domain has fully closed (reads stay valid while draining). */
  assertReadable(): void
  /** Emit `domain/changed` for one durably landed write. */
  emitChanged(change: DomainChanged): void
  /** Emit the `domain/changed` `put` notification of one durably landed record. */
  emitPut(table: string, key: string, value: unknown): void
  /** Apply the spec's invalid-record policy to one record that failed its schema. */
  skipInvalidRecord(table: string, key: string, error: unknown): Promise<void>
}

const noop = () => {}

/**
 * Run one zod parse, translating failure to `invalid-record` with its
 * location. The single construction point of that error: the eager open and
 * the lazy read path both validate through here, so both report a failure
 * identically.
 * @param domain - Owning domain name.
 * @param table - Table holding the record; `''` for the global singleton.
 * @param key - Record key; `''` for the global singleton.
 * @param parse - The throwing parse to run.
 * @returns whatever `parse` returns.
 */
export function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}

/**
 * Apply the spec's `invalidRecords` policy to one record that failed its
 * schema. With `'backup-and-skip'` and a unit that can move documents aside
 * (`KvUnit.backupRecord`), the record's document is moved out of the readable
 * set, the concrete failure is logged, and the caller continues with that
 * record absent; every other case rethrows the `invalid-record` error, so a
 * backend that cannot move a document keeps the loud path.
 * @param ctx - Context carrying the logger.
 * @param spec - The domain declaration carrying the policy and the name.
 * @param unit - The opened unit; its optional `backupRecord` decides whether the policy can apply.
 * @param table - Table holding the failing record.
 * @param key - Key of the failing record.
 * @param error - The `invalid-record` error {@link parseRecord} threw.
 * @returns resolution once the record was moved aside and logged.
 */
export async function skipInvalidRecord(
  ctx: Context,
  spec: DomainSpec,
  unit: KvUnit,
  table: string,
  key: string,
  error: unknown,
): Promise<void> {
  if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
  const moved = await unit.backupRecord(table, key)
  // parseRecord always wraps the zod failure as the cause.
  ctx.logger.error(
    `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
    + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
  )
}

/** Throw the `missing-key` error of an `update` whose target record is absent. */
function missingKey(domain: string, table: string, key: string): never {
  throw new DomainError(
    'missing-key',
    `domain '${domain}' table '${table}' has no record '${key}' to update`,
  )
}

/**
 * The single domain implementation behind the {@link Domain} interface. The
 * facility constructs it from a validated `loadAll` snapshot (an eager
 * domain) or from the spec alone (a lazy one) and erases it to `Domain<S>`;
 * nothing outside this package constructs one.
 */
export class DomainImpl {
  /** Domain name from the spec. */
  readonly name: string

  private readonly tables = new Map<string, KvTable<string, unknown> | LazyKvTable<string, unknown>>()
  private globalValue: unknown
  private readonly globalHandle?: DomainGlobal<unknown>

  /** Tail of the write chain; every link settles (rejections are observed by the caller's slice). */
  private chain: Promise<void> = Promise.resolve()
  /** Set when close begins: new writes reject while already-queued writes drain. */
  private disposing = false
  /** Set when close finishes (chain drained, unit closed): reads reject from here on. */
  private closed = false
  private disposal?: Promise<void>

  /**
   * @param ctx - Context that carries `domain/changed` emissions.
   * @param spec - The domain declaration.
   * @param unit - The opened backend unit; this instance owns its lifecycle.
   * @param records - For an eager domain, the validated records from the
   * unit's `loadAll`, one entry per declared table (empty maps included) —
   * the facility builds it from the spec, so the entry set IS the table set.
   * `undefined` selects lazy residency: no record map is held, and every
   * table handle reads the medium.
   * @param globalValue - Validated stored global, or the spec's `initial`
   * when the medium held none; `undefined` when the spec declares no global.
   * @param onClosed - Facility hook run once after teardown completes; frees
   * the domain name for a later open.
   */
  constructor(
    private readonly ctx: Context,
    spec: DomainSpec,
    private readonly unit: KvUnit,
    records: Map<string, Map<string, unknown>> | undefined,
    globalValue: unknown,
    private readonly onClosed: () => void,
  ) {
    this.name = spec.name
    const host: TableHost = {
      domainName: spec.name,
      unit,
      enqueue: job => this.enqueue(job),
      assertReadable: () => { this.assertReadable() },
      emitChanged: (change) => { this.emitChanged(change) },
      emitPut: (table, key, value) => {
        this.emitChanged({ domain: spec.name, table, key, operation: 'put', value })
      },
      skipInvalidRecord: (table, key, error) => skipInvalidRecord(this.ctx, spec, unit, table, key, error),
    }
    if (records === undefined) {
      // Lazy residency: nothing is resident, so the declared tables alone
      // produce the stable handles and every read goes to the medium.
      for (const [table, tableSpec] of Object.entries(spec.tables)) {
        this.tables.set(table, new LazyKvTableImpl(host, table, tableSpec.valueSchema))
      }
    } else {
      for (const [table, tableRecords] of records) {
        this.tables.set(table, new KvTableImpl(host, table, tableRecords))
      }
    }
    if (spec.global !== undefined) {
      this.globalValue = globalValue
      this.globalHandle = {
        get: () => {
          this.assertReadable()
          return this.globalValue
        },
        set: value => this.enqueue(async () => {
          await this.unit.setGlobal(value)
          this.globalValue = value
          this.emitChanged({ domain: this.name, table: '', key: '', operation: 'put', value })
        }),
      }
    }
  }

  /** Global singleton handle; accessing it on a spec that declares no global is a caller bug and throws. */
  get global(): DomainGlobal<unknown> {
    if (this.globalHandle === undefined) {
      throw new Error(`domain '${this.name}' declares no global`)
    }
    return this.globalHandle
  }

  /**
   * Resolve one declared table handle; an undeclared name is a caller bug
   * and throws. The handle's shape follows the spec's `residency` — resident
   * `KvTable` for an eager domain, `LazyKvTable` for a lazy one.
   * @param name - Declared table name.
   * @returns the stable table handle.
   */
  table(name: string): KvTable<string, unknown> | LazyKvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table
  }

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), close the unit, then free the name via
   * the facility hook. Idempotent — repeated calls share one teardown.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    this.disposing = true
    // Chain links never reject (each is settled via then(noop, noop)), so
    // this await is a pure drain barrier.
    await this.chain
    await this.unit.close()
    this.closed = true
    this.onClosed()
  }

  /**
   * Dispatch one post-durability change notification, containing observer
   * failures: the write is already committed (the medium — and, for an eager
   * domain, memory — holds the new state), so a throwing listener must not
   * retroactively reject it.
   */
  private emitChanged(change: DomainChanged): void {
    try {
      this.ctx.emit('domain/changed', change)
    } catch (error) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant — the commit point has
      // passed, so containment (with a log) is the only correct outcome.
      this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`)
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new DomainError('closed', `domain '${this.name}' is closed`))
    }
    const result = this.chain.then(job)
    this.chain = result.then(noop, noop)
    return result
  }

  private assertReadable(): void {
    if (this.closed) {
      throw new DomainError('closed', `domain '${this.name}' is closed`)
    }
  }
}

/** Table handle bound to one in-memory record map and its domain's write chain. */
class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.records.set(key, value)
      this.host.emitPut(this.tableName, key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // Existence is decided at this job's chain slot, not at call time: an
      // earlier queued put of the same key makes this delete observe it.
      if (!this.records.has(key)) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.records.delete(key)
      this.host.emitChanged({
        domain: this.host.domainName,
        table: this.tableName,
        key,
        operation: 'deleted',
      })
      return true
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      if (!this.records.has(key)) missingKey(this.host.domainName, this.tableName, key)
      const next = fn(this.records.get(key) as V)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.records.set(key, next)
      this.host.emitPut(this.tableName, key, next)
      return next
    })
  }
}

/**
 * Table handle of a lazy domain: no record map behind it, so `read` is a
 * durable point read through the unit, validated with the same zod schema the
 * eager open applies, and every write goes straight to the unit on the
 * domain's write chain.
 */
class LazyKvTableImpl<K extends string, V> implements LazyKvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly schema: ZodType<V>,
  ) {}

  async read(key: K): Promise<V | undefined> {
    this.host.assertReadable()
    const raw = await this.host.unit.readRecord(this.tableName, key)
    if (raw === undefined) return undefined
    try {
      return parseRecord(this.host.domainName, this.tableName, key, () => this.schema.parse(raw))
    } catch (error) {
      // The eager open's policy, applied per record at read time instead: the
      // record it rejects is the one this read just met on the medium.
      await this.host.skipInvalidRecord(this.tableName, key, error)
      return undefined
    }
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.host.emitPut(this.tableName, key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // Existence is decided at this job's chain slot, not at call time: this
      // durable read observes every earlier queued put of the key. Raw
      // presence decides it — a record that fails its schema still exists.
      if (await this.host.unit.readRecord(this.tableName, key) === undefined) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.host.emitChanged({
        domain: this.host.domainName,
        table: this.tableName,
        key,
        operation: 'deleted',
      })
      return true
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      // Re-read at this job's chain slot, so concurrent updates never
      // interleave; the read validates what the transform receives.
      const current = await this.read(key)
      if (current === undefined) missingKey(this.host.domainName, this.tableName, key)
      const next = fn(current)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.host.emitPut(this.tableName, key, next)
      return next
    })
  }
}
