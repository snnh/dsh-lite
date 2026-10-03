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
