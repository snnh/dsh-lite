/** The resident-set policy, its throttle, and the collector lookup. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GC_MIN_INTERVAL_MS,
  DEFAULT_GC_THRESHOLD_BYTES,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_METRICS_INTERVAL_MS,
  GC_DISABLED_ENV,
  GC_INITIAL_DELAY_ENV,
  GC_METRICS_INTERVAL_ENV,
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
  vi.doUnmock('node:vm')
  vi.doUnmock('node:v8')
  vi.resetModules()
})

/**
 * The metric line's shape: an ISO timestamp, one-decimal sizes in megabytes, the
 * collection counter, and the age of the last collection. Built rather than
 * written out so each assertion pins the counters instead of repeating the
 * pattern.
 */
const metricsLine = (collections: number, age: string): RegExp => new RegExp(
  '^memory policy: metrics at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z, '
  + 'rss \\d+\\.\\d MB, heap \\d+\\.\\d/\\d+\\.\\d MB, '
  + `external \\d+\\.\\d MB, collections ${String(collections)}, last collection ${age}$`,
  'u',
)

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

  it('treats a runtime that refuses the flag hook as one with no collector', async () => {
    vi.stubGlobal('gc', undefined)
    vi.resetModules()
    vi.doMock('node:v8', () => ({
      setFlagsFromString: () => { throw new Error('flag refused') },
    }))
    const { resolveCollectGarbage: lookup } = await import('../src/index.ts')
    expect(lookup()).toBeUndefined()
  })

  it('treats a fresh context without a gc binding as one with no collector', async () => {
    vi.stubGlobal('gc', undefined)
    vi.resetModules()
    // The flag hook can succeed while the context it creates still exposes no
    // `gc`; the lookup reports that as no collector rather than a bad function.
    vi.doMock('node:vm', () => ({ runInNewContext: () => 42 }))
    const { resolveCollectGarbage: lookup } = await import('../src/index.ts')
    expect(lookup()).toBeUndefined()
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
      [GC_METRICS_INTERVAL_ENV]: '40',
    })).toEqual({ minIntervalMs: 10, sampleIntervalMs: 20, initialDelayMs: 30, metricsIntervalMs: 40 })
    // Zero is a setting rather than a malformed value: it turns the periodic
    // metric line off while the collection reports keep running.
    expect(policyOptionsFromEnv({ [GC_METRICS_INTERVAL_ENV]: '0' })).toEqual({ metricsIntervalMs: 0 })
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
    // The injected clock follows the fake timer, so the sampler samples every
    // 10 ms while the throttle window stays at 25 ms — the two intervals are
    // what this test separates.
    startMemoryPolicy({
      collect, initialDelayMs: 0, sampleIntervalMs: 10, thresholdBytes: 0,
      minIntervalMs: 25, now: () => Date.now(), log: () => {},
    })
    vi.advanceTimersByTime(20)
    // The startup collection at 0 opened the window; the samples at 10 and 20
    // both landed inside it.
    expect(collect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10)
    // The sample at 30 is exactly one window after the startup collection.
    expect(collect).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(20)
    // The samples at 40 and 50 are inside the window the 30 ms collection opened.
    expect(collect).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10)
    expect(collect).toHaveBeenCalledTimes(3)
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

  it('reports a failure that is not an Error at all', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const failure = { code: 'refused' }
    startMemoryPolicy({
      collect: () => { throw failure },
      initialDelayMs: 10, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(10)
    expect(lines).toEqual(['memory policy: collection failed: [object Object]'])
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

  it('applies the defaults a caller left out', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    // No sink, no collector, and no delay: the policy falls back to the
    // runtime's collector, the default sink, and the documented delay, and the
    // startup report reaches the default no-op sink without throwing.
    vi.stubGlobal('gc', collect)
    startMemoryPolicy({ thresholdBytes: Number.MAX_SAFE_INTEGER })
    vi.advanceTimersByTime(DEFAULT_INITIAL_DELAY_MS - 1)
    expect(collect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('logs a metric line on its own interval, with the counters behind it', () => {
    vi.useFakeTimers()
    const collect = vi.fn()
    const lines: string[] = []
    // The sampler is effectively off (a threshold no reading reaches) and its
    // 60 s spacing never elapses, so every line past the first is a metric
    // line: the metric interval is independent of the sampling interval.
    startMemoryPolicy({
      collect, initialDelayMs: 0, sampleIntervalMs: 60000,
      thresholdBytes: Number.MAX_SAFE_INTEGER, metricsIntervalMs: 1500,
      log: line => lines.push(line),
    })
    vi.advanceTimersByTime(1500)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^memory policy: startup collection, /u)
    // One collection, 1.5 s before this line, rounded to whole seconds.
    expect(lines[1]).toMatch(metricsLine(1, '2s ago'))
    vi.advanceTimersByTime(1500)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(metricsLine(1, '3s ago'))
  })

  it('reports no collection yet when the metric line precedes the first one', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startMemoryPolicy({
      collect: vi.fn(), initialDelayMs: 100, sampleIntervalMs: 10,
      metricsIntervalMs: 10, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(10)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(metricsLine(0, 'never'))
  })

  it('counts the threshold collections the sampler runs', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startMemoryPolicy({
      collect: vi.fn(), initialDelayMs: 0, sampleIntervalMs: 10, minIntervalMs: 0,
      thresholdBytes: 0, metricsIntervalMs: 45, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(45)
    // The startup collection at 0 plus the samples at 10, 20, 30, and 40.
    expect(lines.filter(line => line.includes('threshold collection'))).toHaveLength(4)
    expect(lines.at(-1)).toMatch(metricsLine(5, '0s ago'))
  })

  it('leaves the periodic line off when the interval is zero', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const policy = startMemoryPolicy({
      collect: vi.fn(), initialDelayMs: 0, sampleIntervalMs: 10,
      metricsIntervalMs: 0, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(100)
    // The startup report stands alone: no metrics interval was armed.
    expect(lines).toHaveLength(1)
    expect(lines.filter(line => line.includes('metrics'))).toHaveLength(0)
    // Stopping a policy that never armed a metrics interval stays safe.
    policy.stop()
    policy.stop()
    vi.advanceTimersByTime(100)
    expect(lines).toHaveLength(1)
  })

  it('stops the metric line after stop()', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const policy = startMemoryPolicy({
      collect: vi.fn(), initialDelayMs: 0, sampleIntervalMs: 10,
      metricsIntervalMs: 10, log: line => lines.push(line),
    })
    vi.advanceTimersByTime(10)
    expect(lines.filter(line => line.includes('metrics'))).toHaveLength(1)
    policy.stop()
    vi.advanceTimersByTime(100)
    expect(lines.filter(line => line.includes('metrics'))).toHaveLength(1)
  })

  it('defaults the metric interval to five minutes', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    startMemoryPolicy({
      collect: vi.fn(), initialDelayMs: 5, sampleIntervalMs: 60000,
      thresholdBytes: Number.MAX_SAFE_INTEGER, log: line => lines.push(line),
    })
    expect(DEFAULT_METRICS_INTERVAL_MS).toBe(300000)
    vi.advanceTimersByTime(299999)
    expect(lines.filter(line => line.includes('metrics'))).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(lines.filter(line => line.includes('metrics'))).toHaveLength(1)
  })
})
