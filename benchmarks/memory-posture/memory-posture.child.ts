/**
 * Fresh built-CLI child for one memory-posture sample.
 *
 * The measured subject is the shipped `apps/cli` entry point booting the shipped
 * `headless` profile, so this launcher spawns the built bin under plain Node —
 * never this Vitest process, whose loader and instrumentation would be part of
 * the reading. The probe inside the child writes one JSON report on stdout; a
 * non-zero exit, a signal, or a deadline kill is reported with a bounded stderr
 * tail so a failed boot explains itself.
 *
 * @module benchmarks/memory-posture/child
 */

import { spawn } from 'node:child_process'

/** One bounded child run and its parsed report. */
export interface MemoryPostureChildRun<Report> {
  readonly report: Report | undefined
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Everything one measured child needs. */
export interface MemoryPostureChildOptions {
  /** Built `dsh` entry point (`apps/cli/lib/bin.js`). */
  readonly cliBin: string
  /** Benchmark-owned patch overlay that disables the one-shot runner and mounts the probe. */
  readonly patchPath: string
  /** Private working directory for the child. */
  readonly cwd: string
  /** Harness home for the child's profile state. */
  readonly home: string
  /** Agents home for the child. */
  readonly agentsHome: string
  /** Wall-clock bound; an expired child is killed and reported as `timedOut`. */
  readonly timeoutMs: number
}

/**
 * Last bound of stderr kept when a child fails, so a stack trace stays readable.
 * @param stderr - the child's full stderr.
 * @returns every line when short, otherwise head and tail around an omission marker.
 */
export function boundedStderr(stderr: string): string {
  const lines = stderr.trim().split('\n')
  if (lines.length <= 20) return lines.join('\n')
  return [...lines.slice(0, 10), '... stderr middle omitted ...', ...lines.slice(-10)].join('\n')
}

/**
 * Boot one measured CLI child and collect its report.
 * @param options - entry point, overlay, private roots, and deadline.
 * @returns the parsed report plus the child's exit details.
 */
export function runMemoryPostureChild<Report>(
  options: MemoryPostureChildOptions,
): Promise<MemoryPostureChildRun<Report>> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: options.home,
    USERPROFILE: options.home,
    DSH_HOME: options.home,
    DSH_AGENTS_HOME: options.agentsHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      options.cliBin,
      '--profile', 'headless',
      '--patch', options.patchPath,
    ], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      const line = stdout.trim().split('\n').findLast(candidate => candidate.startsWith('{'))
      if (exitCode !== 0 || line === undefined) {
        resolve({ report: undefined, exitCode, signal, timedOut, stdout, stderr })
        return
      }
      try {
        resolve({
          report: JSON.parse(line) as Report,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  })
}
