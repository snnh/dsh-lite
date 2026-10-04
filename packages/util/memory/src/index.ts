/**
 * Resident-set policy and collector access for long-running hosts.
 *
 * A host that boots a large profile retains far more than it needs: module
 * records, profile parsing, client rosters, and every transient the loader built
 * on the way. The lever that releases those pages is reaching the runtime's
 * collector at all. This package owns that reach, the throttle around it, and
 * the resident-set watchdog a long-running host boots with.
 *
 * Reaching the collector means asking the runtime for one. A build launched
 * without `--expose-gc` has none, so the lookup sets the flag and reads `gc` out
 * of a fresh context. Creating that context collects once and V8 then returns
 * the idle pages to the operating system; both halves are load-bearing and
 * neither alone is enough. Measured on a built Web profile by an external
 * sampler:
 *
 * - `setFlagsFromString('--expose-gc')` alone leaves the resident set at 260 MB.
 * - A fresh context whose `gc` is absent (the lookup's own failure path) still
 *   settles at 152 MB.
 * - The explicit startup collection reports the resident set already reduced,
 *   so it adds observability and bounds a long-running host rather than making
 *   the initial drop.
 *
 * Generation sizes are startup-only: setting `--max-semi-space-size` after the
 * heap exists changes nothing (measured at 256 MB against 164 MB for the same
 * value passed to node), and the published `dsh` entry point is an `env node`
 * script that cannot carry node arguments. An operator who wants that ~90 MB
 * sets `NODE_OPTIONS=--max-semi-space-size=2` themselves.
 *
 * The package also owns the cache budget primitives a long-running host's caches
 * share: {@link estimateJsonBytes} prices a value without serializing it,
 * {@link createBoundedMap} retains entries under an entry count and a byte
 * budget, {@link createIdleCache} adds an idle window over it, and
 * {@link readHeapUsedBytes} reports the heap a budget reacts to. They carry no
 * policy of their own: the caller states its bounds, and only the entries it
 * hands over are ever evicted.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

/** Collect function obtained from the runtime, or obtained through its flag hook. */
export type CollectGarbage = () => void

/**
 * Environment variable naming the resident-set threshold in whole megabytes.
 * `0` turns threshold sampling off while the startup collection still runs.
 */
export const GC_THRESHOLD_ENV = 'DSH_GC_THRESHOLD_MB'
/** Environment variable naming the minimum interval between two collections, in milliseconds. */
export const GC_MIN_INTERVAL_ENV = 'DSH_GC_MIN_INTERVAL_MS'
/** Environment variable naming the interval between resident-set samples, in milliseconds. */
export const GC_SAMPLE_INTERVAL_ENV = 'DSH_GC_SAMPLE_INTERVAL_MS'
/** Environment variable naming the delay before the startup collection, in milliseconds. */
export const GC_INITIAL_DELAY_ENV = 'DSH_GC_INITIAL_DELAY_MS'
/** Environment variable naming the interval between memory-metric lines, in milliseconds. */
export const GC_METRICS_INTERVAL_ENV = 'DSH_GC_METRICS_INTERVAL_MS'
/** Environment variable that turns the whole policy off when set to `0`. */
export const GC_DISABLED_ENV = 'DSH_GC'

/** Resident-set threshold above which a sample triggers a collection. */
export const DEFAULT_GC_THRESHOLD_BYTES = 256 * 1024 * 1024
/** Minimum spacing between two collections. */
export const DEFAULT_GC_MIN_INTERVAL_MS = 5 * 60 * 1000
/** Spacing between resident-set samples. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000
/** Delay before the startup collection, which must land after boot allocates. */
export const DEFAULT_INITIAL_DELAY_MS = 10 * 1000
/**
 * Interval between memory-metric lines. Five minutes is twelve lines an hour: a
 * trend long enough to read after a host dies of memory pressure, and far less
 * volume than the per-collection reports already emit. The collection reports
 * say what a collection did; only a periodic line says what memory is doing
 * while nothing collects.
 */
export const DEFAULT_METRICS_INTERVAL_MS = 5 * 60 * 1000

/**
 * Resolve the runtime's collect function.
 * @returns the collector, or undefined when this runtime exposes none.
 */
export function resolveCollectGarbage(): CollectGarbage | undefined {
  const exposed = Reflect.get(globalThis, 'gc') as unknown
  if (typeof exposed === 'function') return exposed as CollectGarbage
  try {
    // Node exposes `gc` only to a context created after the flag is set, so a
    // build launched without `--expose-gc` still reaches it through this hook.
    // The fresh context is also what drops the idle resident set by ~100 MB:
    // creating it collects once and V8 then returns pages to the OS. Do not
    // replace it with a cheaper flag read — a runtime that refuses the hook
    // keeps the higher resident set (see the module comment for the A/B).
    setFlagsFromString('--expose-gc')
    const hooked = runInNewContext('gc') as unknown
    return typeof hooked === 'function' ? (hooked as CollectGarbage) : undefined
  } catch {
    // A runtime that refuses the flag hook simply has no collector.
    return undefined
  }
}

/**
 * One memory reading. `heapTotalBytes` and `externalBytes` feed the metric line
 * rather than the collection reports, which compare the two resident-set ends.
 */
interface Reading {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
}

function readMemory(): Reading {
  const usage = process.memoryUsage()
  // `external` already includes `arrayBuffers`, so a metric line reports the
  // superset instead of a second number that repeats part of the first.
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  }
}

/** Parse one non-negative integer setting, or undefined when unset or malformed. */
function readCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  // A malformed override keeps the documented default instead of failing a boot.
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Read the policy settings an operator may override without a rebuild. Every
 * unset or malformed value keeps its default; `DSH_GC_THRESHOLD_MB=0` turns
 * threshold sampling off while the startup collection still runs; `DSH_GC=0`
 * disables the policy outright.
 * @param env - environment to read; defaults to the process environment.
 * @returns options for {@link startMemoryPolicy}, or undefined when disabled.
 */
export function policyOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryPolicyOptions | undefined {
  if (env[GC_DISABLED_ENV] === '0') return undefined
  const options: MemoryPolicyOptions = {}
  const thresholdMegabytes = readCount(env[GC_THRESHOLD_ENV])
  if (thresholdMegabytes !== undefined) {
    // An explicit zero means "never collect from a sample", which no finite
    // resident-set reading reaches.
    options.thresholdBytes = thresholdMegabytes === 0
      ? Number.POSITIVE_INFINITY
      : thresholdMegabytes * 1048576
  }

  const intervals = [[GC_MIN_INTERVAL_ENV, 'minIntervalMs'], [GC_SAMPLE_INTERVAL_ENV, 'sampleIntervalMs'],
    [GC_INITIAL_DELAY_ENV, 'initialDelayMs'], [GC_METRICS_INTERVAL_ENV, 'metricsIntervalMs']] as const
  for (const [name, field] of intervals) {
    const value = readCount(env[name])
    if (value !== undefined) options[field] = value
  }
  return options
}

/** Inputs for a throttled collector; every field has a default. */
export interface CollectorOptions {
  /** Collector to drive; defaults to {@link resolveCollectGarbage}. */
  collect?: CollectGarbage
  /** Minimum spacing between two collections, in milliseconds. */
  minIntervalMs?: number
  /** Clock hook, for a caller that measures elapsed time itself. */
  now?: () => number
}

/** A collector with one throttle window. */
export interface Collector {
  /**
   * Collect through the runtime.
   * @param force - collect even inside the throttle window.
   * @returns whether a collection ran; a runtime with no collector never runs one.
   */
  collect: (force?: boolean) => boolean
}

/**
 * Wrap the runtime's collector in one throttle window. Every caller that wants
 * "collect, but not more often than this" shares this instead of re-deriving
 * the interval accounting.
 * @param options - collector, interval, and clock overrides.
 * @returns the throttled collector.
 */
export function createCollector(options: CollectorOptions = {}): Collector {
  const collect = options.collect ?? resolveCollectGarbage()
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_GC_MIN_INTERVAL_MS
  const now = options.now ?? Date.now
  let lastCollectedAt = Number.NEGATIVE_INFINITY
  return {
    collect: (force = false) => {
      /* v8 ignore next -- a runtime that refuses the flag hook exposes no collector at all. */
      if (collect === undefined) return false
      if (!force && now() - lastCollectedAt < minIntervalMs) return false
      collect()
      lastCollectedAt = now()
      return true
    },
  }
}

let sharedCollector: Collector | undefined

/**
 * Collect through the runtime's collector through one process-wide throttle
 * window. The shared entry point for packages that release memory outside a
 * policy — cache eviction, session teardown, terminal release.
 * @param force - collect even inside the throttle window.
 * @returns whether a collection ran.
 */
export function maybeGc(force = false): boolean {
  sharedCollector ??= createCollector()
  return sharedCollector.collect(force)
}

/** Policy inputs; every field has a default so a caller states only its deviation. */
export interface MemoryPolicyOptions extends CollectorOptions {
  /** Resident bytes above which a sample collects. */
  thresholdBytes?: number
  /** Interval between resident-set samples, in milliseconds. */
  sampleIntervalMs?: number
  /** Delay before the startup collection, in milliseconds. */
  initialDelayMs?: number
  /**
   * Interval between memory-metric lines, in milliseconds; `0` leaves the
   * periodic line off while the collection reports still run. Independent of
   * {@link sampleIntervalMs}: one paces the sampler, the other the reporting.
   */
  metricsIntervalMs?: number
  /** Sink for collection and metric reports; the policy never throws into it. */
  log?: (line: string) => void
}

/** A running policy. */
export interface MemoryPolicy {
  /** Stop sampling, collecting, and reporting; safe to call more than once. */
  stop: () => void
}

/** Report in whole megabytes, the unit an operator compares against a limit. */
function megabytes(bytes: number): string {
  return `${megabyteValue(bytes)} MB`
}

/** One reading in megabytes without the unit, for a line that states it once. */
function megabyteValue(bytes: number): string {
  return (bytes / 1048576).toFixed(1)
}

/**
 * Start the resident-set policy for the current process: one collection once
 * boot has settled, then further collections only above a threshold and never
 * inside the minimum interval, plus one memory-metric line every
 * `metricsIntervalMs`. Every timer is unref'd, so the policy never keeps a
 * finishing process alive, and `stop()` clears them, so a cleared policy never
 * reports again.
 * @param options - thresholds, intervals, collector, and the report sink.
 * @returns the running policy; a runtime without a collector returns an inert one.
 */
export function startMemoryPolicy(options: MemoryPolicyOptions = {}): MemoryPolicy {
  const log = options.log ?? (() => {})
  const collect = options.collect ?? resolveCollectGarbage()
  /* v8 ignore next 4 -- a runtime that refuses the flag hook exposes no collector at all. */
  if (collect === undefined) {
    log('memory policy: this runtime exposes no garbage collector; resident memory is left to V8')
    return { stop: () => {} }
  }

  const thresholdBytes = options.thresholdBytes ?? DEFAULT_GC_THRESHOLD_BYTES
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_GC_MIN_INTERVAL_MS
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
  const metricsIntervalMs = options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS
  const now = options.now ?? Date.now
  const collector = createCollector({ collect, minIntervalMs, now })
  // What the metric line reports about this policy's own work: how many
  // collections it ran, and when the last of them landed. A `maybeGc` call from
  // a cache eviction elsewhere in the process never reaches this counter.
  let collections = 0
  let lastCollectedAt: number | undefined

  const report = (reason: string, before: Reading, after: Reading): void => {
    log(`memory policy: ${reason} collection, rss ${megabytes(before.rssBytes)} -> ${megabytes(after.rssBytes)}, `
      + `heap ${megabytes(before.heapUsedBytes)} -> ${megabytes(after.heapUsedBytes)}`)
  }

  /** Record one collection this policy ran, for the next metric line. */
  const noteCollected = (): void => {
    collections += 1
    lastCollectedAt = now()
  }

  /**
   * Report the current reading without collecting: the trend an operator has
   * while nothing collects, which the collection reports alone cannot show.
   */
  const reportMetrics = (): void => {
    const reading = readMemory()
    const age = lastCollectedAt === undefined
      ? 'never'
      : `${String(Math.round((now() - lastCollectedAt) / 1000))}s ago`
    // The wall clock is read directly rather than through `now`, which a caller
    // may point at a monotonic source for its throttle accounting.
    log(`memory policy: metrics at ${new Date().toISOString()}, rss ${megabytes(reading.rssBytes)}, `
      + `heap ${megabyteValue(reading.heapUsedBytes)}/${megabyteValue(reading.heapTotalBytes)} MB, `
      + `external ${megabytes(reading.externalBytes)}, collections ${String(collections)}, `
      + `last collection ${age}`)
  }

  const collectNow = (reason: string): void => {
    const before = readMemory()
    try {
      collector.collect(true)
    } catch (error: unknown) {
      // A failed collection leaves the policy sampling; the next sample retries.
      log(`memory policy: collection failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    noteCollected()
    report(reason, before, readMemory())
  }

  // No callback checks a "stopped" flag: `stop()` clears every timer below, and
  // a cleared timer never runs its callback. The flag would only add a branch
  // that no test — and no host — could reach.
  // The startup collection is unconditional: it reports the resident set once
  // boot has settled, and it forces the full collection a busy boot may defer.
  const startup = setTimeout(() => { collectNow('startup') }, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  startup.unref()
  const sampler = setInterval(() => {
    const reading = readMemory()
    if (reading.rssBytes < thresholdBytes) return
    if (!collector.collect()) return
    noteCollected()
    report('threshold', reading, readMemory())
  }, sampleIntervalMs)
  sampler.unref()
  // Metrics are paced separately from the sampler, so a host that never crosses
  // the threshold still reports its trend; an interval of zero leaves the
  // periodic line off and keeps only the collection reports.
  const metrics = metricsIntervalMs > 0 ? setInterval(reportMetrics, metricsIntervalMs) : undefined
  metrics?.unref()

  return {
    stop: () => {
      clearTimeout(startup)
      clearInterval(sampler)
      clearInterval(metrics)
    },
  }
}

/**
 * Read the heap this process currently holds.
 *
 * A cache budget reacts to this number rather than to the resident set: the
 * resident set also counts native and shared pages a cache cannot release, and
 * it lags the heap a dropped object graph frees.
 * @returns the bytes of JavaScript heap in use right now.
 */
export function readHeapUsedBytes(): number {
  return process.memoryUsage().heapUsed
}

/** Bytes charged for one number: a JSON number is one double in the grammar. */
const JSON_NUMBER_BYTES = 8
/** Bytes charged for a boolean, `null`, or `undefined`, each one JSON atom. */
const JSON_ATOMIC_BYTES = 4
/** Bytes charged for a value with no JSON form at all: a function, symbol, or bigint. */
const JSON_OPAQUE_BYTES = 32
/** Bytes charged for a `Date`: its 24-character ISO-8601 string form. */
const JSON_DATE_BYTES = 24

/**
 * Estimate the retained size of a JSON-shaped value without serializing it.
 *
 * The estimate is cheap, deterministic, and deliberately not a serialized
 * length: a string charges its UTF-8 byte length, a number 8 bytes, a boolean,
 * `null`, or `undefined` 4 bytes, a function, symbol, or bigint 32 bytes, a
 * `Uint8Array` or `Buffer` its `byteLength`, a `Date` 24 bytes, an array the sum
 * of its elements, a `Map` the sum of its keys and values, a `Set` the sum of
 * its elements, and every other object the sum of its own enumerable string keys
 * and their values. A container charges nothing beyond its contents, so an empty
 * one costs 0.
 *
 * Object identity is charged once per call: an alias or a back-reference that
 * the walk already visited adds nothing, which is both the cheaper answer for a
 * shared subgraph and what keeps a cyclic value from spinning the walk.
 * @param value - the value to measure.
 * @returns the estimated bytes a cache should account for this value.
 */
export function estimateJsonBytes(value: unknown): number {
  return estimateValueBytes(value, new Set<object>())
}

/**
 * Price one value, charging every object identity in `seen` once.
 * @param value - the value to measure.
 * @param seen - object identities already charged by this walk.
 * @returns the estimated bytes.
 */
function estimateValueBytes(value: unknown, seen: Set<object>): number {
  if (value === null || value === undefined) return JSON_ATOMIC_BYTES
  if (typeof value === 'string') return byteLength(value)
  if (typeof value === 'number') return JSON_NUMBER_BYTES
  if (typeof value === 'boolean') return JSON_ATOMIC_BYTES
  // bigint, symbol, and function have no JSON form but each retains something.
  if (typeof value !== 'object') return JSON_OPAQUE_BYTES
  if (seen.has(value)) return 0
  seen.add(value)
  return estimateObjectBytes(value, seen)
}

/**
 * Price one object whose identity is already charged.
 * @param object - the object to measure.
 * @param seen - object identities already charged by this walk.
 * @returns the estimated bytes.
 */
function estimateObjectBytes(object: object, seen: Set<object>): number {
  if (object instanceof Uint8Array) return object.byteLength
  if (object instanceof Date) return JSON_DATE_BYTES
  if (object instanceof Map) return estimateMapBytes(object, seen)
  if (object instanceof Set) return estimateSetBytes(object, seen)
  if (Array.isArray(object)) return estimateElementsBytes(object, seen)
  return estimatePropertiesBytes(object, seen)
}

/** Price every entry of a map as its key plus its value. */
function estimateMapBytes(map: Map<unknown, unknown>, seen: Set<object>): number {
  let total = 0
  for (const [key, value] of map) total += estimateValueBytes(key, seen) + estimateValueBytes(value, seen)
  return total
}

/** Price every element of a set. */
function estimateSetBytes(set: ReadonlySet<unknown>, seen: Set<object>): number {
  let total = 0
  for (const value of set) total += estimateValueBytes(value, seen)
  return total
}

/** Price every element of an array. */
function estimateElementsBytes(elements: readonly unknown[], seen: Set<object>): number {
  let total = 0
  for (const value of elements) total += estimateValueBytes(value, seen)
  return total
}

/**
 * Price one object with no more specific form — a plain object or a class
 * instance — as its own enumerable string keys plus their values.
 */
function estimatePropertiesBytes(object: object, seen: Set<object>): number {
  let total = 0
  for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
    total += byteLength(key) + estimateValueBytes(value, seen)
  }
  return total
}

/** UTF-8 byte length, the width a string occupies on the wire and in the heap. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Why one entry left a bounded cache. `entries` and `bytes` are the two budgets
 * evicting; `delete` and `clear` are the caller asking; `idle` is the idle
 * window over a bounded cache reclaiming an untouched key.
 */
export type BoundedMapEvictionReason = 'entries' | 'bytes' | 'delete' | 'clear' | 'idle'

/** One retained entry with the byte estimate its insertion was charged. */
interface BoundedEntry<V> {
  value: V
  size: number
}

/** Bounds, pricing, and removal reporting for {@link createBoundedMap}. */
export interface BoundedMapOptions<K, V> {
  /**
   * Entries retained before the least recently used ones are dropped. Omitted,
   * or any non-positive or non-finite value, leaves the entry count unbounded.
   */
  maxEntries?: number | undefined
  /**
   * Estimated bytes retained before the least recently used entries are
   * dropped. Omitted, or any non-positive or non-finite value, leaves the byte
   * account unbounded.
   */
  maxBytes?: number | undefined
  /**
   * Per-entry byte price; defaults to {@link estimateJsonBytes}, which prices
   * the value alone. A caller whose keys are large prices them here.
   * @param value - the entry's value.
   * @param key - the entry's key.
   * @returns the bytes to charge for this entry.
   */
  estimateBytes?: ((value: V, key: K) => number) | undefined
  /**
   * Removal hook, called once per entry after it has left the cache and the
   * byte account has been corrected. Replacing a present key is not a removal.
   * The hook must not insert into or clear the cache it is reporting on.
   * @param key - the removed key.
   * @param value - the removed value.
   * @param reason - the budget or request that removed it.
   */
  onEvict?: ((key: K, value: V, reason: BoundedMapEvictionReason) => void) | undefined
}

/**
 * A Map-style container that drops its least recently used entries to hold an
 * entry count and a byte budget.
 *
 * Iteration is oldest first, matching a `Map`'s insertion order: `get` re-inserts
 * a hit as the newest entry, and eviction removes the first key. Reads never
 * price anything — `bytes` is the sum of the prices charged at insertion.
 */
export interface BoundedMap<K, V> {
  /**
   * Read a key, moving a hit to the newest end of the iteration order.
   * @param key - the key to read.
   * @returns the retained value, or `undefined` for a miss.
   */
  get: (key: K) => V | undefined
  /**
   * Insert or replace one entry, then settle both bounds.
   * @param key - the key to write.
   * @param value - the value to retain.
   */
  set: (key: K, value: V) => void
  /**
   * Report whether a key is retained, without touching its recency.
   * @param key - the key to look up.
   * @returns true when the key is retained.
   */
  has: (key: K) => boolean
  /**
   * Remove one key if present, reporting the removal as `delete`.
   * @param key - the key to remove.
   * @returns true when a retained entry was removed.
   */
  delete: (key: K) => boolean
  /** Remove every entry, reporting each one as `clear`. */
  clear: () => void
  /** Number of retained entries. */
  readonly size: number
  /** Sum of the byte prices charged for the retained entries. */
  readonly bytes: number
  /**
   * Iterate retained entries, oldest first; a hit moves its entry to the end.
   * @returns the entry iterator.
   */
  entries: () => IterableIterator<[K, V]>
  /**
   * Iterate retained keys, oldest first.
   * @returns the key iterator.
   */
  keys: () => IterableIterator<K>
}

/**
 * Read one budget as a positive finite limit, or undefined for "no limit in
 * this dimension". A caller that passes `0` or a negative or non-finite value
 * gets an unbounded dimension rather than a cache that rejects every write.
 * @param value - the caller's value, if any.
 * @returns the usable limit, or undefined.
 */
function readPositiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Build a Map-style LRU container bounded by entry count and by estimated bytes.
 *
 * Both bounds settle after every `set`, count first and bytes second, each
 * evicting the least recently used entry until it holds. A single entry priced
 * above the whole byte budget is kept once it is the only entry left: emptying
 * the cache could never satisfy that budget, so every insert would evict the
 * value it just stored.
 * @param options - bounds, pricing, and the removal hook.
 * @returns the bounded cache.
 */
export function createBoundedMap<K, V>(options: BoundedMapOptions<K, V> = {}): BoundedMap<K, V> {
  const maxEntries = readPositiveLimit(options.maxEntries)
  const maxBytes = readPositiveLimit(options.maxBytes)
  const estimateBytes = options.estimateBytes ?? estimateJsonBytes
  const onEvict = options.onEvict
  const store = new Map<K, BoundedEntry<V>>()
  let bytes = 0

  /** Remove one present key, correcting the account before reporting it. */
  const remove = (key: K, reason: BoundedMapEvictionReason): boolean => {
    const entry = store.get(key)
    if (entry === undefined) return false
    store.delete(key)
    bytes -= entry.size
    onEvict?.(key, entry.value, reason)
    return true
  }

  /** Drop the least recently used entry; the caller has proven the store is not empty. */
  const evictOldest = (reason: BoundedMapEvictionReason): void => {
    const oldest = store.keys().next().value as K
    remove(oldest, reason)
  }

  /** Settle both bounds, count first and bytes second. */
  const evict = (): void => {
    if (maxEntries !== undefined) {
      while (store.size > maxEntries) evictOldest('entries')
    }
    if (maxBytes !== undefined) {
      while (bytes > maxBytes && store.size > 1) evictOldest('bytes')
    }
  }

  return {
    get: (key) => {
      const entry = store.get(key)
      if (entry === undefined) return undefined
      store.delete(key)
      store.set(key, entry)
      return entry.value
    },
    set: (key, value) => {
      const previous = store.get(key)
      if (previous !== undefined) {
        bytes -= previous.size
        store.delete(key)
      }
      const size = estimateBytes(value, key)
      store.set(key, { value, size })
      bytes += size
      evict()
    },
    has: key => store.has(key),
    delete: key => remove(key, 'delete'),
    clear: () => {
      // Snapshot: a hook that inserts must not disturb this walk, and its entry
      // is cleared by the `clear()` below either way.
      for (const [key, entry] of [...store]) onEvict?.(key, entry.value, 'clear')
      store.clear()
      bytes = 0
    },
    get size() {
      return store.size
    },
    get bytes() {
      return bytes
    },
    *entries(): IterableIterator<[K, V]> {
      for (const [key, entry] of store) yield [key, entry.value]
    },
    keys: () => store.keys(),
  }
}

/** Idle sweep spacing cap: five minutes, the longest a stale entry waits. */
export const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Options for {@link createIdleCache}: every bound of a bounded cache plus the idle window. */
export interface IdleCacheOptions<K, V> extends BoundedMapOptions<K, V> {
  /**
   * Idle window in milliseconds. A retained key whose last `get` hit or `set`
   * is at least this old is dropped at the next sweep; a caller that wants no
   * idle window leaves this wrapper out instead of passing 0.
   */
  idleTtlMs: number
  /**
   * Sweep spacing in milliseconds; defaults to `idleTtlMs` capped at
   * {@link DEFAULT_IDLE_SWEEP_INTERVAL_MS}. Any non-positive or non-finite
   * value takes that default, so the sweep can never spin the event loop.
   */
  sweepIntervalMs?: number | undefined
  /**
   * Clock hook; defaults to `Date.now`. A caller that measures elapsed time
   * itself points this at the same source it stamps its entries with.
   * @returns the current time in milliseconds.
   */
  now?: (() => number) | undefined
}

/** A bounded cache that also reclaims entries left untouched past its idle window. */
export interface IdleCache<K, V> extends BoundedMap<K, V> {
  /**
   * Stop the sweep timer. Safe to call more than once, and the retained entries
   * stay readable — only reclamation stops.
   */
  stop: () => void
}

/**
 * Build a bounded cache whose entries also expire after being idle.
 *
 * A `get` hit and a `set` both stamp the key as active; a periodic unref'd sweep
 * drops every key idle for `idleTtlMs` or longer, reporting it through
 * `onEvict` with reason `idle`. The sweep runs synchronously, so a key is either
 * present or reported as reclaimed before the next turn of the event loop.
 * @param options - the bounded cache's bounds plus the idle window and its sweep.
 * @returns the idle-aware cache.
 */
export function createIdleCache<K, V>(options: IdleCacheOptions<K, V>): IdleCache<K, V> {
  const { idleTtlMs, sweepIntervalMs, now: clock, ...boundedOptions } = options
  const now = clock ?? Date.now
  const sweepInterval = readPositiveLimit(sweepIntervalMs) ?? Math.min(Math.max(idleTtlMs, 1), DEFAULT_IDLE_SWEEP_INTERVAL_MS)
  // Last activity per retained key. The adapter below keeps this map's keys
  // exactly the store's keys, which is what lets the sweep treat a stamp as
  // proof of a present entry.
  const lastActiveAt = new Map<K, number>()
  // Keys this sweep selected, so the adapter can report their removal as idle
  // rather than as the plain delete the store performs.
  const expired = new Set<K>()

  const store = createBoundedMap<K, V>({
    ...boundedOptions,
    onEvict: (key, value, reason) => {
      lastActiveAt.delete(key)
      options.onEvict?.(key, value, expired.delete(key) ? 'idle' : reason)
    },
  })

  const sweep = (): void => {
    const at = now()
    // Snapshot: each removal below drops its stamp through the adapter.
    for (const [key, last] of [...lastActiveAt]) {
      if (at - last < idleTtlMs) continue
      expired.add(key)
      store.delete(key)
    }
  }
  const timer = setInterval(sweep, sweepInterval)
  timer.unref()

  return {
    get: (key) => {
      // Only a hit stamps activity: a miss must not retain a key it never held.
      if (store.has(key)) lastActiveAt.set(key, now())
      return store.get(key)
    },
    set: (key, value) => {
      store.set(key, value)
      lastActiveAt.set(key, now())
    },
    has: key => store.has(key),
    delete: key => store.delete(key),
    clear: () => {
      store.clear()
    },
    get size() {
      return store.size
    },
    get bytes() {
      return store.bytes
    },
    entries: () => store.entries(),
    keys: () => store.keys(),
    stop: () => {
      clearInterval(timer)
    },
  }
}
