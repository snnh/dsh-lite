/**
 * The plugin manager's process runner, resolved on first use.
 *
 * `execa` carries a dependency graph that only an install, a registry view, or a
 * service run needs, so it stays out of the boot path: a `dsh` process that never
 * manages plugins must not pay for it.
 *
 * @module @deepseek-ai/dsh-plugin-manager/execa
 */

/** The `execa` implementation exported by the dependency. */
type Execa = typeof import('execa')['execa']

let pending: Promise<Execa> | undefined

/**
 * Resolve the process runner once per process.
 * @returns the memoized `execa` implementation.
 */
export function loadExeca(): Promise<Execa> {
  // A failed load is not cached, so a corrected installation can be retried.
  return pending ??= import('execa').then(module => module.execa)
}
