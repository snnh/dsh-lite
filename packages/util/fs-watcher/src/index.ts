/**
 * Chokidar-backed watcher lifecycle for every host watcher: this module creates
 * the underlying instance, gates readiness, routes failures, and closes it.
 *
 * Each consumer still owns WHAT to watch and what an event means — roots,
 * filters, depth, write stabilization, polling, and its own listeners. Only HOW
 * a watcher comes to life and goes away is centralized, so watcher
 * construction, readiness reporting, error routing, and teardown change in one
 * place instead of in every host package.
 * @module @deepseek-ai/dsh-fs-watcher
 */

import * as chokidar from 'chokidar'

/** Chokidar's per-change event names, without the combined `all` channel. */
export type WatchEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

/**
 * Watcher options, re-exported so consumers configure a watch without importing
 * the watcher library themselves. They are passed to Chokidar unchanged.
 */
export type WatchOptions = chokidar.ChokidarOptions

/** Listener arguments per event a {@link Watcher} reports. */
export interface WatcherEventMap {
  /** A file was created. */
  add: [path: string]
  /** A directory was created. */
  addDir: [path: string]
  /** A file was modified. */
  change: [path: string]
  /** A file was removed. */
  unlink: [path: string]
  /** A directory was removed. */
  unlinkDir: [path: string]
  /** Every change event, reported as the event name followed by its path. */
  all: [event: WatchEvent, path: string]
  /** The initial scan finished, so every later event is live. */
  ready: []
  /** The watcher failed; the value is whatever the backend reported. */
  error: [error: unknown]
}

/**
 * A live watcher produced by {@link createWatcher}. Listeners registered here
 * observe exactly the events the underlying backend emits, in the same order,
 * with the same arguments.
 */
export interface Watcher {
  /**
   * Subscribe for the watcher's whole lifetime.
   * @param event The event to observe.
   * @param listener Called with that event's arguments.
   * @returns This watcher, for chaining.
   */
  on<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this
  /**
   * Subscribe until the event's first delivery.
   * @param event The event to observe.
   * @param listener Called with that event's arguments.
   * @returns This watcher, for chaining.
   */
  once<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this
  /**
   * Remove one subscription previously registered with {@link Watcher.on} or
   * {@link Watcher.once}.
   * @param event The event the listener was registered for.
   * @param listener The exact listener reference to remove.
   * @returns This watcher, for chaining.
   */
  off<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this
  /**
   * Stop watching and release the backend's handles. Safe to call more than
   * once: the live-watcher count only drops on the first call.
   * @returns A promise that settles once the backend released its handles.
   */
  close(): Promise<void>
}

/** Watchers handed out by {@link createWatcher} that are not closed yet. */
const liveWatchers = new Set<Watcher>()

/**
 * Report how many watchers this process currently holds open. The registry is
 * where a future handle or memory ceiling would count from; this module never
 * refuses a watcher on its own.
 * @returns The number of created watchers that were not closed.
 */
export function liveWatcherCount(): number {
  return liveWatchers.size
}

/**
 * The listener position a watcher backend accepts. Chokidar resolves its own
 * listener parameter conditionally over the event name (and its `all` channel
 * carries stats the facade does not expose), so the facade forwards into this
 * erased position instead of re-deriving it per event.
 */
/* oxlint-disable-next-line typescript/no-explicit-any --
 * `unknown[]` and `never[]` both reject every concrete listener under strict
 * parameter contravariance; callers see {@link WatcherEventMap}'s types instead
 * of this one. */
type BackendListener = (...args: any[]) => void

/** The Chokidar surface this facade delegates to and nothing more. */
interface WatchInstance {
  on(event: string, listener: BackendListener): unknown
  once(event: string, listener: BackendListener): unknown
  off(event: string, listener: BackendListener): unknown
  close(): Promise<void>
}

/** Chokidar's watcher factory: paths plus options in, a live watcher out. */
type WatchFactory = (paths: string | string[], options: WatchOptions) => WatchInstance

/**
 * The two export shapes Chokidar's factory appears under. Every released major
 * exposes `watch` by name AND as a member of a default-export object carrying
 * `watch` and `FSWatcher`; a backend substituted for Chokidar may implement only
 * one of the two.
 */
interface ChokidarNamespace {
  watch?: WatchFactory
  default?: { watch?: WatchFactory }
}

/**
 * Read the watcher factory out of the loaded Chokidar module. Presence is
 * tested before the named export is read, because reading an export a module
 * facade does not define can fail loudly instead of yielding undefined.
 * @param loaded The imported Chokidar module.
 * @returns The watcher factory, or undefined when neither shape carries one.
 */
function resolveFactory(loaded: ChokidarNamespace): WatchFactory | undefined {
  if (Object.hasOwn(loaded, 'watch')) return loaded.watch
  return loaded.default?.watch
}

/** Watcher facade over one Chokidar instance; every event method delegates. */
class ChokidarWatcher implements Watcher {
  private readonly instance: WatchInstance

  /**
   * @param instance The Chokidar watcher this facade owns.
   */
  constructor(instance: WatchInstance) {
    this.instance = instance
  }

  on<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this {
    this.instance.on(event, listener)
    return this
  }

  once<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this {
    this.instance.once(event, listener)
    return this
  }

  off<E extends keyof WatcherEventMap>(event: E, listener: (...args: WatcherEventMap[E]) => void): this {
    this.instance.off(event, listener)
    return this
  }

  async close(): Promise<void> {
    liveWatchers.delete(this)
    await this.instance.close()
  }
}

/**
 * Start watching the given paths with the caller's own options. Filtering,
 * depth, write stabilization, polling, and path spelling stay the caller's
 * decision; this module only owns the instance's lifetime.
 * @param paths One path or a list of paths, resolved by Chokidar against the options' `cwd`.
 * @param options Watcher options, passed through unchanged.
 * @returns The live watcher, registered until it is closed.
 */
export function createWatcher(paths: string | string[], options: WatchOptions): Watcher {
  const create = resolveFactory(chokidar)
  if (create === undefined) throw new Error('the loaded watcher backend exposes no watch factory')
  const watcher = new ChokidarWatcher(create(paths, options))
  liveWatchers.add(watcher)
  return watcher
}

/** Readiness, cancellation, and late-failure routing for {@link waitForReady}. */
export interface ReadyOptions {
  /**
   * Whether to wait for the ready event. Pass false for a watcher with no
   * roots, whose consumers still have to hear every later failure.
   */
  awaitReady?: boolean
  /** Cancellation: an abort rejects the returned promise with the signal's reason. */
  signal?: AbortSignal
  /**
   * Handles errors raised after readiness settled, including after a failed
   * startup. The first error while waiting rejects the returned promise instead.
   */
  onError?: (error: unknown) => void
}

/**
 * Resolve when the watcher's initial scan finishes, or reject with the first
 * failure — or with the abort reason when the caller's signal aborts first.
 *
 * This is the one readiness gate every watcher consumer shares: the promise
 * settles exactly once, and the error listener stays attached afterwards, so a
 * failed startup rejects once and later failures reach
 * {@link ReadyOptions.onError}.
 * @param watcher The watcher to await.
 * @param options Readiness, cancellation, and late-error routing.
 * @returns A promise that resolves on readiness and rejects on the first failure or abort.
 */
export function waitForReady(watcher: Watcher, options: ReadyOptions = {}): Promise<void> {
  const { awaitReady = true, signal, onError } = options
  const ready = Promise.withResolvers<void>()
  if (signal?.aborted) {
    ready.reject(signal.reason)
    return ready.promise
  }
  let stopWaiting = (): void => {}
  let waiting = awaitReady
  watcher.on('error', (error) => {
    if (!waiting) {
      onError?.(error)
      return
    }
    waiting = false
    stopWaiting()
    ready.reject(error)
  })
  if (!awaitReady) {
    ready.resolve()
    return ready.promise
  }
  if (signal !== undefined) {
    const onAbort = (): void => { ready.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    stopWaiting = () => { signal.removeEventListener('abort', onAbort) }
  }
  watcher.once('ready', () => {
    waiting = false
    stopWaiting()
    ready.resolve()
  })
  return ready.promise
}
