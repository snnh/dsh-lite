/**
 * Node's module compile cache for the CLI process.
 *
 * A cold `dsh` start evaluates every module of every mounted row before the host
 * can accept a request, and V8 parses and compiles each file first. Node's compile
 * cache keeps that bytecode in `$DSH_HOME/cache/compile`, so a second start of the
 * same build compiles only what changed.
 *
 * This is an optimization, never a prerequisite: an unwritable home, an embedded
 * runtime without the API, or a full disk leaves the command's outcome untouched.
 * The enable call is an import side effect, and `bin.ts` imports this module before
 * any other, because the cache only covers modules compiled after it runs.
 *
 * @module @deepseek-ai/dsh/compile-cache
 */

import { mkdirSync } from 'node:fs'
import { constants, enableCompileCache } from 'node:module'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'

/** What one enable attempt did, for startup diagnostics. */
export interface CompileCacheOutcome {
  /** Whether this process now caches compiled modules. */
  enabled: boolean
  /** The directory holding the cache, when one was chosen. */
  directory?: string
  /** Why the cache is not active, when it is not. */
  reason?: string
}

/**
 * Enable Node's compile cache for this process.
 * @param directory - cache directory; defaults to `$DSH_HOME/cache/compile`.
 * @returns the outcome; failures are reported, never thrown.
 */
export function enableDshCompileCache(directory: string = dshCachePath('compile')): CompileCacheOutcome {
  try {
    if (typeof enableCompileCache !== 'function') return { enabled: false, reason: 'unsupported runtime' }
    mkdirSync(directory, { recursive: true })
    const { status, message } = enableCompileCache(directory)
    if (status === constants.compileCacheStatus.ENABLED
      || status === constants.compileCacheStatus.ALREADY_ENABLED) return { enabled: true, directory }
    return { enabled: false, directory, ...message === undefined ? {} : { reason: message } }
  } catch (error: unknown) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Outcome of this process's enable attempt, resolved when the module loads. */
export const compileCache: CompileCacheOutcome = enableDshCompileCache()
