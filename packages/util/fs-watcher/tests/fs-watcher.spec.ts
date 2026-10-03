/** Watcher-facade lifecycle over a faked backend: creation, delegation, readiness, and teardown. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcher, liveWatcherCount, waitForReady, type Watcher } from '../src/index.ts'

/** One faked Chokidar watcher: an event emitter that records its own teardown. */
type FakeWatcher = import('node:events').EventEmitter & {
  closeCalls: number
  closed: boolean
  paths: string | string[]
  options: import('chokidar').ChokidarOptions
}

const backend = vi.hoisted(() => ({
  /** Every `watch()` call, in order. */
  calls: [] as Array<{ paths: unknown; options: unknown }>,
  /** Watchers created through the named export. */
  created: [] as unknown[],
  /** Watchers created through the default export, which the named one must win over. */
  fallbackCreated: [] as unknown[],
}))

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  class Fake extends EventEmitter {
    closeCalls = 0
    closed = false
    paths: string | string[]
    options: import('chokidar').ChokidarOptions

    constructor(paths: string | string[], options: import('chokidar').ChokidarOptions) {
      super()
      this.paths = paths
      this.options = options
    }

    async close(): Promise<void> {
      this.closeCalls += 1
      this.closed = true
    }
  }
  const record = (
    bucket: unknown[],
    paths: string | string[],
    options: import('chokidar').ChokidarOptions = {},
  ): FakeWatcher => {
    const instance = new Fake(paths, options)
    backend.calls.push({ paths, options })
    bucket.push(instance)
    return instance
  }
  const watch = (paths: string | string[], options?: import('chokidar').ChokidarOptions): FakeWatcher =>
    record(backend.created, paths, options)
  // Chokidar's own shape: the factory is a named export AND a member of the
  // default export. The cases below remove one or both to pin the resolution.
  return {
    watch,
    default: {
      watch: (paths: string | string[], options?: import('chokidar').ChokidarOptions) =>
        record(backend.fallbackCreated, paths, options),
    },
  }
})

/** Every watcher this file created, closed after each case so the live count restarts at zero. */
const opened: Watcher[] = []

/** The faked backend instances the facade created, in order. */
function fakeWatchers(): FakeWatcher[] {
  return backend.created as FakeWatcher[]
}

/** Create a watcher through the facade and register it for teardown. */
function watch(paths: string | string[] = '/root', options: import('chokidar').ChokidarOptions = {}): Watcher {
  const watcher = createWatcher(paths, options)
  opened.push(watcher)
  return watcher
}

beforeEach(() => {
  backend.calls.length = 0
  backend.created.length = 0
  backend.fallbackCreated.length = 0
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async watcher => watcher.close()))
})

describe('createWatcher', () => {
  it('forwards the paths and the caller options unchanged and registers one live watcher', () => {
    const options: import('chokidar').ChokidarOptions = { ignoreInitial: true, depth: 0, ignored: () => false }
    const watcher = watch('/root', options)
    expect(backend.calls).toEqual([{ paths: '/root', options }])
    expect(backend.created).toHaveLength(1)
    expect(backend.fallbackCreated).toHaveLength(0)
    expect(watcher).not.toBe(fakeWatchers()[0])
    expect(liveWatcherCount()).toBe(1)
  })

  it('accepts a root list and reports one live watcher per creation', () => {
    watch(['/one', '/two'], { ignoreInitial: true })
    watch('/root', {})
    expect(backend.calls[0]).toEqual({ paths: ['/one', '/two'], options: { ignoreInitial: true } })
    expect(liveWatcherCount()).toBe(2)
  })

  it('drops the live count on close and delegates every close call', async () => {
    const watcher = watch()
    await watcher.close()
    expect(fakeWatchers()[0]?.closed).toBe(true)
    expect(fakeWatchers()[0]?.closeCalls).toBe(1)
    expect(liveWatcherCount()).toBe(0)
    await watcher.close()
    expect(fakeWatchers()[0]?.closeCalls).toBe(2)
    expect(liveWatcherCount()).toBe(0)
  })

  it.each([
    ['add', ['/added']],
    ['addDir', ['/directory']],
    ['change', ['/changed']],
    ['unlink', ['/removed']],
    ['unlinkDir', ['/removed-directory']],
    ['all', ['change', '/changed']],
    ['error', [new Error('watcher failed')]],
  ] as const)('delegates %s to the backend listener', (event, args) => {
    const listener = vi.fn()
    const watcher = watch()
    expect(watcher.on(event, listener)).toBe(watcher)
    fakeWatchers()[0]?.emit(event, ...args)
    expect(listener).toHaveBeenCalledExactlyOnceWith(...args)
  })

  it('removes one subscription with off and keeps the others', () => {
    const failure = new Error('backend failure')
    const removed = vi.fn()
    const kept = vi.fn()
    const watcher = watch()
    watcher.on('error', removed)
    watcher.on('error', kept)
    expect(watcher.off('error', removed)).toBe(watcher)
    fakeWatchers()[0]?.emit('error', failure)
    expect(removed).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('delivers once() one time and keeps the chained watcher', () => {
    const listener = vi.fn()
    const watcher = watch()
    expect(watcher.once('ready', listener)).toBe(watcher)
    fakeWatchers()[0]?.emit('ready')
    fakeWatchers()[0]?.emit('ready')
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('waitForReady', () => {
  it('resolves on ready and routes later failures to onError', async () => {
    const failures: unknown[] = []
    const watcher = watch()
    const ready = waitForReady(watcher, { onError: (error) => { failures.push(error) } })
    fakeWatchers()[0]?.emit('ready')
    await expect(ready).resolves.toBeUndefined()
    const failure = new Error('late failure')
    fakeWatchers()[0]?.emit('error', failure)
    expect(failures).toEqual([failure])
  })

  it('rejects with the first failure and ignores later ones without an onError', async () => {
    const failure = new Error('startup failure')
    const watcher = watch()
    const ready = waitForReady(watcher)
    fakeWatchers()[0]?.emit('error', failure)
    await expect(ready).rejects.toBe(failure)
    fakeWatchers()[0]?.emit('error', new Error('second failure'))
    fakeWatchers()[0]?.emit('ready')
    await expect(ready).rejects.toBe(failure)
  })

  it('resolves without waiting when the caller has no roots to scan', async () => {
    const failures: unknown[] = []
    const watcher = watch()
    const ready = waitForReady(watcher, { awaitReady: false, onError: (error) => { failures.push(error) } })
    const failure = new Error('failure without a scan')
    fakeWatchers()[0]?.emit('error', failure)
    expect(failures).toEqual([failure])
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects with the signal reason for an abort while waiting', async () => {
    const watcher = watch()
    const aborted = new AbortController()
    const ready = waitForReady(watcher, { signal: aborted.signal })
    aborted.abort(new Error('cancelled'))
    await expect(ready).rejects.toThrow('cancelled')
  })

  it('stops listening to the signal once readiness settles', async () => {
    const watcher = watch()
    const settled = new AbortController()
    const removed = vi.spyOn(settled.signal, 'removeEventListener')
    const ready = waitForReady(watcher, { signal: settled.signal })
    fakeWatchers()[0]?.emit('ready')
    await expect(ready).resolves.toBeUndefined()
    expect(removed).toHaveBeenCalledOnce()
  })

  it('rejects immediately for an already aborted signal without subscribing', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    const watcher = watch()
    const ready = waitForReady(watcher, { signal: aborted.signal })
    await expect(ready).rejects.toThrow('already cancelled')
    expect(fakeWatchers()[0]?.listenerCount('ready')).toBe(0)
    expect(fakeWatchers()[0]?.listenerCount('error')).toBe(0)
  })

  it('routes a failure after a failed startup and a late abort to onError', async () => {
    const failures: unknown[] = []
    const watcher = watch()
    const aborted = new AbortController()
    const ready = waitForReady(watcher, { signal: aborted.signal, onError: (error) => { failures.push(error) } })
    const failure = new Error('failed before ready')
    fakeWatchers()[0]?.emit('error', failure)
    await expect(ready).rejects.toBe(failure)
    aborted.abort(new Error('after the failure'))
    const later = new Error('later failure')
    fakeWatchers()[0]?.emit('error', later)
    expect(failures).toEqual([later])
  })

  it('resolves a no-wait gate whose signal aborts later', async () => {
    const watcher = watch()
    const aborted = new AbortController()
    const ready = waitForReady(watcher, { awaitReady: false, signal: aborted.signal })
    aborted.abort(new Error('nothing waits for this'))
    await expect(ready).resolves.toBeUndefined()
  })
})

describe('backend module shapes', () => {
  it('reads the factory from a default-only backend module', async () => {
    const module = await import('chokidar') as unknown as { watch?: unknown }
    Reflect.deleteProperty(module, 'watch')
    const watcher = watch('/root', { depth: 1 })
    expect(backend.created).toHaveLength(0)
    expect(backend.fallbackCreated).toHaveLength(1)
    await watcher.close()
    expect(liveWatcherCount()).toBe(0)
  })

  it('refuses a backend that exposes no factory at all', async () => {
    const module = await import('chokidar') as unknown as { default?: { watch?: unknown } }
    if (module.default !== undefined) Reflect.deleteProperty(module.default, 'watch')
    expect(() => createWatcher('/root', {})).toThrow('no watch factory')
  })
})
