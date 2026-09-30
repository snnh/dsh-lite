/**
 * Process memory policy for the CLI's long-running profile commands.
 *
 * Booting a profile allocates far more than the host retains: module records,
 * profile parsing, the client roster, and every transient the loader built on
 * the way. An idle host without this policy holds those committed pages: the
 * built Web profile measures ~243 MB resident and stays there, against a live
 * set of ~57 MB.
 *
 * The policy resolves a collect function once, which needs the V8 flag hook
 * because a build launched without `--expose-gc` has none, and then samples the
 * resident set: once shortly after startup, and afterwards only above a
 * threshold and never more often than the minimum interval. Both timers are
 * unref'd, so the policy never keeps a finishing process alive.
 *
 * Measured on the built Web profile, 6 s to 90 s after startup: without the
 * policy the resident set is flat at ~243 MB, with it ~146-152 MB and flat at
 * that level. The startup report shows the resident set already reduced when it
 * runs, so the hook that makes collection reachable is what lets V8 reduce the
 * heap here, and the periodic collection is what bounds a host that keeps
 * working. A runtime that refuses the hook reports that once and samples
 * nothing.
 *
 * @module @deepseek-ai/dsh/memory-policy
 */

import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

/** Collect function obtained from the runtime, or obtained through its flag hook. */
export type CollectGarbage = () => void

/** Resident-set threshold above which a sample triggers a collection. */
export const DEFAULT_GC_THRESHOLD_BYTES = 256 * 1024 * 1024
/** Minimum spacing between two collections. */
export const DEFAULT_GC_MIN_INTERVAL_MS = 5 * 60 * 1000
/** Spacing between resident-set samples. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 1000
/** Delay before the startup collection, which must land after boot allocates. */
export const DEFAULT_INITIAL_DELAY_MS = 10 * 1000

/** Policy inputs; every field has a default so a caller states only its deviation. */
export interface MemoryPolicyOptions {
  /** Resident bytes above which a sample collects. */
  thresholdBytes?: number
  /** Minimum interval between two collections, in milliseconds. */
  minIntervalMs?: number
  /** Interval between resident-set samples, in milliseconds. */
  sampleIntervalMs?: number
  /** Delay before the startup collection, in milliseconds. */
  initialDelayMs?: number
  /** Sink for collection reports; the policy never throws into it. */
  log?: (line: string) => void
  /** Clock hook, for a caller that measures elapsed time itself. */
  now?: () => number
}

/** A running policy. */
export interface MemoryPolicy {
  /** Stop sampling and collecting; safe to call more than once. */
  stop: () => void
}

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
    setFlagsFromString('--expose-gc')
    const hooked = runInNewContext('gc') as unknown
    return typeof hooked === 'function' ? (hooked as CollectGarbage) : undefined
  } catch {
    // A runtime that refuses the flag hook simply has no collector.
    return undefined
  }
}

/** One resident-set reading. */
interface Reading {
  rssBytes: number
  heapUsedBytes: number
}

function readMemory(): Reading {
  const usage = process.memoryUsage()
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed }
}

/** Report in whole megabytes, the unit an operator compares against a limit. */
function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/**
 * Start the policy for the current process.
 * @param options - thresholds, intervals, and the report sink.
 * @returns the running policy; a runtime without a collector returns an inert one.
 */
export function startMemoryPolicy(options: MemoryPolicyOptions = {}): MemoryPolicy {
  const collect = resolveCollectGarbage()
  const log = options.log ?? (() => {})
  if (collect === undefined) {
    log('memory policy: this runtime exposes no garbage collector; resident memory is left to V8')
    return { stop: () => {} }
  }

  const thresholdBytes = options.thresholdBytes ?? DEFAULT_GC_THRESHOLD_BYTES
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_GC_MIN_INTERVAL_MS
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
  const now = options.now ?? Date.now
  let lastCollectedAt = Number.NEGATIVE_INFINITY
  let stopped = false

  const report = (reason: string, before: Reading, after: Reading): void => {
    log(`memory policy: ${reason} collection, rss ${megabytes(before.rssBytes)} -> ${megabytes(after.rssBytes)}, `
      + `heap ${megabytes(before.heapUsedBytes)} -> ${megabytes(after.heapUsedBytes)}`)
  }

  const collectNow = (reason: string): void => {
    const before = readMemory()
    try {
      collect()
    } catch (error: unknown) {
      // A failed collection leaves the policy sampling; the next sample retries.
      log(`memory policy: collection failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    lastCollectedAt = now()
    report(reason, before, readMemory())
  }

  // The startup collection is unconditional: it reports the resident set once
  // boot has settled, and it forces the full collection a busy boot may defer.
  const startup = setTimeout(() => { if (!stopped) collectNow('startup') }, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  startup.unref()
  const sampler = setInterval(() => {
    if (stopped) return
    const reading = readMemory()
    if (reading.rssBytes < thresholdBytes) return
    if (now() - lastCollectedAt < minIntervalMs) return
    collectNow('threshold')
  }, sampleIntervalMs)
  sampler.unref()

  return {
    stop: () => {
      stopped = true
      clearTimeout(startup)
      clearInterval(sampler)
    },
  }
}
