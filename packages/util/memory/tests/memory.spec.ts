/** The resident-set policy, its throttle, and the collector lookup. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GC_MIN_INTERVAL_MS,
  DEFAULT_GC_THRESHOLD_BYTES,
  GC_DISABLED_ENV,
  GC_INITIAL_DELAY_ENV,
  GC_MIN_INTERVAL_ENV,
  GC_SAMPLE_INTERVAL_ENV,
  GC_THRESHOLD_ENV,
  createCollector,
  maybeGc,
  policyOptionsFromEnv,
  resolveCollectGarbage,
  startMemoryPolicy,
} from '../src/index.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('resolveCollectGarbage', () => {
  it('prefers a collector the runtime already exposed', () => {
    const exposed = (): void => {}
    vi.stubGlobal('gc', exposed)
    expect(resolveCollectGarbage()).toBe(exposed)
  })

  it('reaches a collector through the flag hook when the runtime exposed none', () => {
    // Without --expose-gc the lookup sets the flag and reads `gc` from a fresh
    // context; this runtime grants it, so the result is callable.
    const collect = resolveCollectGarbage()
    expect(typeof collect).toBe('function')
    expect(() => { (collect as () => void)() }).not.toThrow()
  })
})

describe('policyOptionsFromEnv', () => {
  it('is undefined only for the explicit disable', () => {
    expect(policyOptionsFromEnv({ [GC_DISABLED_ENV]: '0' })).toBeUndefined()
    expect(policyOptionsFromEnv({ [GC_DISABLED_ENV]: '1' })).toEqual({})
  })

  it('converts the threshold from megabytes, and reads zero as never collecting', () => {
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: '12' })).toEqual({ thresholdBytes: 12 * 1048576 })
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: '0' })).toEqual({ thresholdBytes: Number.POSITIVE_INFINITY })
  })

  it('keeps the default for blank, malformed, and negative values', () => {
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: '  ' })).toEqual({})
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: 'lots' })).toEqual({})
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: '-1' })).toEqual({})
    expect(policyOptionsFromEnv({ [GC_THRESHOLD_ENV]: '1.5' })).toEqual({})
  })

  it('reads each interval override', () => {
    expect(policyOptionsFromEnv({
      [GC_MIN_INTERVAL_ENV]: '10',
      [GC_SAMPLE_INTERVAL_ENV]: '20',
      [GC_INITIAL_DELAY_ENV]: '30',
    })).toEqual({ minIntervalMs: 10, sampleIntervalMs: 20, initialDelayMs: 30 })
  })
})

describe('createCollector', () => {
  it('runs the injected collector and reports that it ran', () => {
    const collect = vi.fn()
    const clock = { now: 1000 }
    const collector = createCollector({ collect, now: () => clock.now })
    expect(collector.collect()).toBe(true)
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('holds the throttle window and lets force through', () => {
    const collect = vi.fn()
    const clock = { now: 0 }
    const collector = createCollector({ collect, minIntervalMs: 100, now: () => clock.now })
    expect(collector.collect()).toBe(true)
    clock.now = 99
    expect(collector.collect()).toBe(false)
    expect(collector.collect(true)).toBe(true)
    expect(collect).toHaveBeenCalledTimes(2)
    // The window is exclusive: one millisecond short is refused, exactly on it
    // is allowed.
    clock.now = 198
    expect(collector.collect()).toBe(false)
    clock.now = 199
    expect(collector.collect()).toBe(true)
    expect(collect).toHaveBeenCalledTimes(3)
  })

  it('defaults to the runtime collector and the default interval', () => {
    vi.stubGlobal('gc', () => {})
    const collector = createCollector({ now: () => 0 })
    expect(collector.collect()).toBe(true)
    expect(collector.collect()).toBe(false)
    expect(DEFAULT_GC_MIN_INTERVAL_MS).toBeGreaterThan(0)
  })
})

describe('maybeGc', () => {
  it('initializes one shared throttle window and reuses it', () => {
    vi.stubGlobal('gc', () => {})
    expect(maybeGc()).toBe(true)
    // The second call lands inside the window the first one opened.
    expect(maybeGc()).toBe(false)
    expect(maybeGc(true)).toBe(true)
  })
})

describe('startMemoryPolicy', () => {
  it('collects once after the startup delay and reports both readings', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    const lines: string[] = []
    startMemoryPolicy({ collect, initialDelayMs: 50, log: line => lines.push(line) })
    vi.advanceTimersByTime(49)
    expect(collect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(collect).toHaveBeenCalledTimes(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^memory policy: startup collection, rss \d+\.\d MB -> \d+\.\d MB, heap \d+\.\d MB -> \d+\.\d MB$/u)
  })

  it('samples above the threshold and stays silent below it', () => {
    vi.useFakeTimers()
    const quiet = vi.fn()
    const lines: string[] = []
    // A threshold no reading reaches keeps the sampler quiet: only the startup
    // collection runs, and no sample turns into a collection.
    startMemoryPolicy({
      collect: quiet, initialDelayMs: 5, sampleIntervalMs: 10,
      thresholdBytes: Number.MAX_SAFE_INTEGER, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(100)
    expect(quiet).toHaveBeenCalledTimes(1)
    expect(lines.filter(line => line.includes('threshold collection'))).toHaveLength(0)

    const loud = vi.fn()
    const noisy: string[] = []
    // Threshold zero: every sample is above it, so each one collects.
    startMemoryPolicy({
      collect: loud, initialDelayMs: 0, sampleIntervalMs: 10, thresholdBytes: 0,
      minIntervalMs: 0, log: line => noisy.push(line),
    })
    vi.advanceTimersByTime(30)
    // One startup collection plus one per sample.
    expect(loud).toHaveBeenCalledTimes(4)
    expect(noisy.filter(line => line.includes('threshold collection'))).toHaveLength(3)
  })

  it('honours the collection interval between threshold samples', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    const clock = { now: 0 }
    startMemoryPolicy({
      collect, initialDelayMs: 0, sampleIntervalMs: 10, thresholdBytes: 0,
      minIntervalMs: 25, now: () => clock.now, log: () => {},
    })
    vi.advanceTimersByTime(20)
    expect(collect).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(20)
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('reports a failed collection and keeps sampling', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const failure = new Error('collector refused')
    startMemoryPolicy({
      collect: () => { throw failure },
      initialDelayMs: 10, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(10)
    expect(lines).toEqual(['memory policy: collection failed: collector refused'])
  })

  it('stops collecting after stop(), and stopping twice is safe', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    const policy = startMemoryPolicy({ collect, initialDelayMs: 10, sampleIntervalMs: 10, thresholdBytes: 0, log: () => {} })
    policy.stop()
    policy.stop()
    vi.advanceTimersByTime(100)
    expect(collect).not.toHaveBeenCalled()
  })

  it('accepts a reading below the default threshold without collecting', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    // The real resident set of this process is far below the 256 MB default,
    // which is exactly the "sample quietly" path a healthy host takes.
    startMemoryPolicy({ collect, initialDelayMs: 0, sampleIntervalMs: 10, log: () => {} })
    vi.advanceTimersByTime(50)
    expect(DEFAULT_GC_THRESHOLD_BYTES).toBe(256 * 1024 * 1024)
    // Only the unconditional startup collection; every sample stayed under it.
    expect(collect).toHaveBeenCalledTimes(1)
  })
})
