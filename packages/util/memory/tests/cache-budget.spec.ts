/** The cache budget primitives: the byte estimator, the bounded LRU, and the idle wrapper. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IDLE_SWEEP_INTERVAL_MS,
  createBoundedMap,
  createIdleCache,
  estimateJsonBytes,
  readHeapUsedBytes,
} from '../src/index.ts'
import type { BoundedMapEvictionReason } from '../src/index.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('estimateJsonBytes', () => {
  it('charges one constant for each JSON atom', () => {
    expect(estimateJsonBytes(null)).toBe(4)
    expect(estimateJsonBytes(undefined)).toBe(4)
    expect(estimateJsonBytes(true)).toBe(4)
    expect(estimateJsonBytes(false)).toBe(4)
    expect(estimateJsonBytes(1234.5)).toBe(8)
    expect(estimateJsonBytes(Number.NaN)).toBe(8)
  })

  it('charges a string its UTF-8 byte length, not its code unit count', () => {
    expect(estimateJsonBytes('')).toBe(0)
    expect(estimateJsonBytes('abc')).toBe(3)
    expect(estimateJsonBytes('中')).toBe(3)
    expect(estimateJsonBytes('👍')).toBe(4)
  })

  it('sums array elements, a hole counting as undefined', () => {
    expect(estimateJsonBytes([])).toBe(0)
    expect(estimateJsonBytes([1, 'a', null])).toBe(8 + 1 + 4)
    expect(estimateJsonBytes([undefined, 1])).toBe(4 + 8)
    expect(estimateJsonBytes([[1]])).toBe(8)
  })

  it('sums a plain object as its keys plus their values', () => {
    expect(estimateJsonBytes({})).toBe(0)
    expect(estimateJsonBytes({ a: 1, bb: 'xx' })).toBe(1 + 8 + 2 + 2)
    expect(estimateJsonBytes({ outer: { inner: 'ab' } })).toBe(5 + 5 + 2)
    expect(estimateJsonBytes({ a: undefined })).toBe(1 + 4)
  })

  it('measures a typed array or a Buffer by its byte length', () => {
    expect(estimateJsonBytes(new Uint8Array(3))).toBe(3)
    expect(estimateJsonBytes(Buffer.alloc(5))).toBe(5)
  })

  it('charges a Date its ISO-8601 string form', () => {
    expect(estimateJsonBytes(new Date(0))).toBe(24)
  })

  it('sums a Map over its keys and values and a Set over its elements', () => {
    expect(estimateJsonBytes(new Map())).toBe(0)
    expect(estimateJsonBytes(new Map([['ab', 1]]))).toBe(2 + 8)
    expect(estimateJsonBytes(new Set())).toBe(0)
    expect(estimateJsonBytes(new Set(['ab', 1]))).toBe(2 + 8)
  })

  it('reads a class instance through its own enumerable properties', () => {
    class Point {
      x = 1
      y = 'ab'
    }
    expect(estimateJsonBytes(new Point())).toBe(1 + 8 + 1 + 2)
  })

  it('charges one conservative constant for values with no JSON form', () => {
    expect(estimateJsonBytes(() => {})).toBe(32)
    expect(estimateJsonBytes(Symbol('s'))).toBe(32)
    expect(estimateJsonBytes(1n)).toBe(32)
  })

  it('charges a shared object once and a back-reference not at all', () => {
    const shared = { v: 1 }
    expect(estimateJsonBytes([shared, shared])).toBe(1 + 8)

    const selfArray: unknown[] = []
    selfArray.push(selfArray)
    expect(estimateJsonBytes(selfArray)).toBe(0)

    const selfMap = new Map<string, unknown>()
    selfMap.set('self', selfMap)
    expect(estimateJsonBytes(selfMap)).toBe(4)

    const cyclic: Record<string, unknown> = { self: null }
    cyclic.self = cyclic
    expect(estimateJsonBytes(cyclic)).toBe(4)

    const mutualA: Record<string, unknown> = {}
    const mutualB: Record<string, unknown> = { a: mutualA }
    mutualA.b = mutualB
    expect(estimateJsonBytes(mutualA)).toBe(1 + 1)
  })
})

describe('readHeapUsedBytes', () => {
  it('reads the heap this process currently holds', () => {
    const before = process.memoryUsage().heapUsed
    const value = readHeapUsedBytes()
    expect(value).toBeGreaterThan(0)
    // The reading is the live counter, not a cached sample from an earlier call.
    expect(Math.abs(value - before)).toBeLessThan(64 * 1024 * 1024)
  })
})

describe('createBoundedMap', () => {
  it('retains everything and accounts bytes when neither bound is given', () => {
    const cache = createBoundedMap<string, string>()
    cache.set('a', 'xx')
    cache.set('b', 'yyy')
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBe(5)
    expect([...cache.entries()]).toEqual([['a', 'xx'], ['b', 'yyy']])
    expect([...cache.keys()]).toEqual(['a', 'b'])
    expect(cache.get('a')).toBe('xx')
    expect(cache.has('b')).toBe(true)
    // The hit re-inserted 'a' at the newest end of the iteration order.
    expect([...cache.keys()]).toEqual(['b', 'a'])
    expect(createBoundedMap<string, string>().entries().next().done).toBe(true)
  })

  it('drops the least recently used entry over the count bound, oldest first', () => {
    const evicted: [string, string, BoundedMapEvictionReason][] = []
    const cache = createBoundedMap<string, string>({
      maxEntries: 2,
      onEvict: (key, value, reason) => { evicted.push([key, value, reason]) },
    })
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    expect(cache.size).toBe(2)
    expect([...cache.keys()]).toEqual(['b', 'c'])
    expect(cache.has('a')).toBe(false)
    expect(evicted).toEqual([['a', '1', 'entries']])
  })

  it('moves a hit to the newest end, so the untouched entry is dropped first', () => {
    const cache = createBoundedMap<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect([...cache.keys()]).toEqual(['a', 'c'])
    expect(cache.has('b')).toBe(false)
  })

  it('leaves recency alone on has(), so the oldest entry is still the one dropped', () => {
    const cache = createBoundedMap<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.has('a')).toBe(true)
    cache.set('c', 3)
    expect([...cache.keys()]).toEqual(['b', 'c'])
  })

  it('corrects the byte account when a present key is replaced', () => {
    const evicted: string[] = []
    const cache = createBoundedMap<string, string>({ onEvict: (key) => { evicted.push(key) } })
    cache.set('k', 'a')
    expect(cache.bytes).toBe(1)
    cache.set('k', 'abc')
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(3)
    // Replacing a value is not a removal, so the hook stays silent.
    expect(evicted).toEqual([])
  })

  it('drops least recently used entries until the byte bound holds', () => {
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createBoundedMap<string, string>({
      maxBytes: 6,
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    cache.set('a', 'aaa')
    cache.set('b', 'bbb')
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBe(6)
    cache.set('c', 'ccc')
    expect([...cache.keys()]).toEqual(['b', 'c'])
    expect(cache.bytes).toBe(6)
    expect(evicted).toEqual([['a', 'bytes']])
  })

  it('keeps one entry priced above the whole byte bound', () => {
    const cache = createBoundedMap<string, string>({ maxBytes: 2 })
    cache.set('big', 'abcdefghij')
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(10)
    // It leaves only when a second entry would still break the bound without it.
    cache.set('second', 'z')
    expect([...cache.keys()]).toEqual(['second'])
    expect(cache.bytes).toBe(1)
  })

  it('settles the count bound before the byte bound', () => {
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createBoundedMap<string, string>({
      maxEntries: 2,
      maxBytes: 4,
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    cache.set('a', 'aa')
    cache.set('b', 'bb')
    cache.set('c', 'cc')
    cache.set('d', 'dddd')
    expect([...cache.keys()]).toEqual(['d'])
    expect(cache.bytes).toBe(4)
    expect(evicted).toEqual([['a', 'entries'], ['b', 'entries'], ['c', 'bytes']])
  })

  it('reports a delete of a present key and stays silent for a miss', () => {
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createBoundedMap<string, number>({
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    expect(cache.delete('missing')).toBe(false)
    cache.set('k', 1)
    expect(cache.delete('k')).toBe(true)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    expect(evicted).toEqual([['k', 'delete']])
  })

  it('reports every retained key as cleared exactly once', () => {
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createBoundedMap<string, number>({
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    cache.clear()
    expect(evicted).toEqual([['a', 'clear'], ['b', 'clear']])
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('retains an undefined value as a present entry', () => {
    const cache = createBoundedMap<string, string | undefined>({})
    cache.set('k', undefined)
    expect(cache.has('k')).toBe(true)
    const value = cache.get('k')
    expect(value).toBeUndefined()
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(4)
    expect(cache.delete('k')).toBe(true)
  })

  it('treats a non-positive or non-finite bound as no bound at all', () => {
    const notANumber = createBoundedMap<string, string>({ maxEntries: Number.NaN, maxBytes: Number.POSITIVE_INFINITY })
    notANumber.set('a', 'a')
    notANumber.set('b', 'b')
    expect(notANumber.size).toBe(2)

    const zeroAndNegative = createBoundedMap<string, string>({ maxEntries: 0, maxBytes: -3 })
    zeroAndNegative.set('a', 'a')
    zeroAndNegative.set('b', 'b')
    expect(zeroAndNegative.size).toBe(2)
  })

  it('prices an entry through a caller estimator that sees the key', () => {
    const cache = createBoundedMap<string, string>({
      estimateBytes: (value, key) => value.length + key.length,
    })
    cache.set('kk', 'vvv')
    expect(cache.bytes).toBe(5)
  })
})

describe('createIdleCache', () => {
  it('drops entries idle for the window and keeps a refreshed one', () => {
    vi.useFakeTimers()
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createIdleCache<string, string>({
      idleTtlMs: 100,
      sweepIntervalMs: 20,
      now: () => Date.now(),
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    cache.set('kept', 'v')
    cache.set('dropped', 'v')
    vi.advanceTimersByTime(60)
    // The hit at 60 ms restarts the window for this key alone.
    expect(cache.get('kept')).toBe('v')
    vi.advanceTimersByTime(40)
    expect([...cache.keys()]).toEqual(['kept'])
    expect(evicted).toEqual([['dropped', 'idle']])
    vi.advanceTimersByTime(60)
    expect(cache.size).toBe(0)
    expect(evicted).toEqual([['dropped', 'idle'], ['kept', 'idle']])
    expect(cache.get('kept')).toBeUndefined()
  })

  it('never tracks a key the cache does not hold', () => {
    vi.useFakeTimers()
    // No clock and no sweep spacing: the wrapper falls back to Date.now and to
    // the idle window itself.
    const cache = createIdleCache<string, number>({ idleTtlMs: 30 })
    expect(cache.get('ghost')).toBeUndefined()
    vi.advanceTimersByTime(90)
    expect(cache.size).toBe(0)
    expect([...cache.keys()]).toEqual([])
  })

  it('takes the default sweep spacing for a non-positive override', () => {
    vi.useFakeTimers()
    const cache = createIdleCache<string, number>({ idleTtlMs: 20, sweepIntervalMs: 0 })
    cache.set('a', 1)
    vi.advanceTimersByTime(19)
    expect(cache.size).toBe(1)
    vi.advanceTimersByTime(1)
    expect(cache.size).toBe(0)
  })

  it('caps the default sweep spacing at five minutes', () => {
    vi.useFakeTimers()
    expect(DEFAULT_IDLE_SWEEP_INTERVAL_MS).toBe(300000)
    const cache = createIdleCache<string, number>({ idleTtlMs: 10 * 60 * 1000 })
    cache.set('a', 1)
    vi.advanceTimersByTime(299999)
    expect(cache.size).toBe(1)
    // The first sweep lands at 5 min, still inside the 10 min window.
    vi.advanceTimersByTime(1)
    expect(cache.size).toBe(1)
    vi.advanceTimersByTime(300000)
    expect(cache.size).toBe(0)
  })

  it('stops sweeping on stop(), and stopping twice is safe', () => {
    vi.useFakeTimers()
    const cache = createIdleCache<string, number>({ idleTtlMs: 10, sweepIntervalMs: 5 })
    cache.set('a', 1)
    cache.stop()
    cache.stop()
    vi.advanceTimersByTime(100)
    expect(cache.size).toBe(1)
    // Only reclamation stopped; the retained entries stay readable.
    expect(cache.get('a')).toBe(1)
  })

  it('forwards every removal the bounded cache reports', () => {
    vi.useFakeTimers()
    const evicted: [string, BoundedMapEvictionReason][] = []
    const cache = createIdleCache<string, string>({
      idleTtlMs: 1000,
      sweepIntervalMs: 1000,
      maxEntries: 1,
      onEvict: (key, _value, reason) => { evicted.push([key, reason]) },
    })
    cache.set('a', '1')
    cache.set('b', '2')
    expect([...cache.keys()]).toEqual(['b'])
    expect([...cache.entries()]).toEqual([['b', '2']])
    cache.delete('b')
    cache.set('c', '3')
    cache.clear()
    expect(evicted).toEqual([['a', 'entries'], ['b', 'delete'], ['c', 'clear']])
    expect(cache.bytes).toBe(0)
    expect(cache.has('c')).toBe(false)
  })

  it('expires only what the idle window covers after a clear', () => {
    vi.useFakeTimers()
    const cache = createIdleCache<string, number>({ idleTtlMs: 50, sweepIntervalMs: 10 })
    cache.set('old', 1)
    vi.advanceTimersByTime(30)
    cache.clear()
    cache.set('new', 2)
    vi.advanceTimersByTime(40)
    expect([...cache.keys()]).toEqual(['new'])
    vi.advanceTimersByTime(10)
    expect(cache.size).toBe(0)
  })
})
