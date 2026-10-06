/**
 * Compiled in-host probe for the built headless CLI memory posture.
 *
 * The parent benchmark mounts this cordis plugin through a `--patch` overlay
 * beside the shipped `headless` bundles, with the one-shot runner disabled so
 * the host stays up. The plugin then owns one measurement pass inside the real
 * process: settle past the shipped resident-set policy's startup collection,
 * observe the idle resident set, spend one idle CPU window, and finally open N
 * Sessions through the production Agent registry to price one retained Session.
 *
 * It reports exactly one JSON line on stdout and exits; the parent owns the
 * process deadline and the budgets. `assertBuiltBenchmarkRuntime` rejects a run
 * reached through a TypeScript loader or from source.
 *
 * @module benchmarks/memory-posture/probe
 */

import { performance } from 'node:perf_hooks'
import { scheduler, setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
// Empty type imports carry the `ctx.agents`, `ctx.sessionPersistence` service merges.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import {
  BENCH_MODEL,
  BENCH_PROVIDER,
  CPU_WINDOW_MS,
  HISTORY,
  PROBE_SESSION_PREFIX,
  SESSIONS,
  SETTLE_MS,
} from './memory-posture.constants.ts'
import { syntheticHistory } from './memory-posture.history.ts'

/** Stable cordis plugin name mounted by the benchmark-owned patch overlay. */
export const name = 'memory-posture-probe'
/** The production Agent registry and Session persistence must exist before a sample can open Sessions. */
export const inject = ['agents', 'sessionPersistence']

/** One resident-set observation inside the measured host. */
export interface PostureMemorySnapshot {
  readonly rssMb: number
  readonly heapUsedMb: number
  readonly heapTotalMb: number
  readonly externalMb: number
  readonly arrayBuffersMb: number
  readonly peakRssMb: number
}

/** The idle resident set plus the CPU the host spent over one idle window. */
export interface PostureIdleMeasurement extends PostureMemorySnapshot {
  readonly cpuWindowMs: number
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly idleCpuMs: number
  /** Whole 10 ms jiffies of process CPU over the window, the unit the decision record uses. */
  readonly idleJiffies: number
}

/** What one retained Session cost, measured across the N Sessions this pass opened. */
export interface PostureSessionMeasurement {
  readonly sessions: number
  /** Completed turns every opened Session carried. */
  readonly historyTurns: number
  readonly before: PostureMemorySnapshot
  readonly after: PostureMemorySnapshot
  readonly deltaRssMb: number
  readonly perSessionRssMb: number
  readonly perSessionHeapMb: number
}

/** The single JSON report one probe child writes on stdout. */
export interface MemoryPostureReport {
  readonly profile: 'headless'
  /** Milliseconds from process start to the probe plugin's own activation. */
  readonly activatedMs: number
  /** Milliseconds from process start to the launcher's committed readiness signal. */
  readonly readyMs: number
  readonly settleMs: number
  /** How many Sessions the per-session phase was asked to open. */
  readonly requestedSessions: number
  readonly idle: PostureIdleMeasurement
  /** Absent only when the per-session phase threw; its reason is then in `sessionsError`. */
  readonly sessionsMeasurement?: PostureSessionMeasurement
  readonly sessionsError?: string
  readonly totalMs: number
}

/** Keeps the event loop referenced until the report has been flushed. */
const KEEP_ALIVE_MS = 3_600_000

function megabytes(bytes: number): number {
  return Math.round(bytes / 104_857.6) / 10
}

/**
 * Read the current process memory shape.
 * @returns resident set, heap, external, array-buffer, and peak figures in megabytes.
 */
function snapshot(): PostureMemorySnapshot {
  const memory = process.memoryUsage()
  return {
    rssMb: megabytes(memory.rss),
    heapUsedMb: megabytes(memory.heapUsed),
    heapTotalMb: megabytes(memory.heapTotal),
    externalMb: megabytes(memory.external),
    arrayBuffersMb: megabytes(memory.arrayBuffers),
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 102.4) / 10,
  }
}

/**
 * Collect twice around an event-loop yield, so what remains is retained rather than garbage.
 * @returns the resident set after collection.
 * @throws when the child was launched without `--expose-gc`.
 */
async function collectAndSnapshot(): Promise<PostureMemorySnapshot> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (gc === undefined) throw new Error('memory posture probe requires --expose-gc for the per-session phase')
  gc()
  await scheduler.yield()
  gc()
  return snapshot()
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Launcher-provided successful-startup signal; `@deepseek-ai/dsh-cmdline` publishes it on every profile boot. */
interface ReadySignal {
  onReady(listener: () => void): () => void
}

/**
 * Wait for the launcher's committed readiness signal, so the idle sample is taken
 * after the whole profile mounted rather than while rows are still activating.
 * @param ctx - the booted profile context.
 * @returns a promise that settles once the profile is ready, or immediately when no launcher signal is mounted.
 */
function whenReady(ctx: Context): Promise<void> {
  // Read structurally: this private adapter must not add a dependency on the
  // launcher package just to name a service the launcher already provides.
  const ready = (ctx as Context & { appReady?: ReadySignal }).appReady
  if (ready === undefined) return Promise.resolve()
  return new Promise(resolve => { ready.onReady(() => { resolve() }) })
}

/**
 * Observe the idle resident set and the CPU spent over one idle window.
 * @param windowMs - idle window length in milliseconds.
 * @returns the resident set at the start of the window plus the CPU it cost.
 */
async function measureIdle(windowMs: number): Promise<PostureIdleMeasurement> {
  const memory = snapshot()
  const before = process.cpuUsage()
  await delay(windowMs)
  const cpu = process.cpuUsage(before)
  const idleCpuMs = (cpu.user + cpu.system) / 1_000
  return {
    ...memory,
    cpuWindowMs: windowMs,
    cpuUserMs: round1(cpu.user / 1_000),
    cpuSystemMs: round1(cpu.system / 1_000),
    idleCpuMs: round1(idleCpuMs),
    idleJiffies: Math.round(idleCpuMs / 10),
  }
}

/**
 * Persist N synthetic Sessions through the production handle before measuring.
 * @param ctx - the booted profile context.
 * @param count - Sessions to author.
 * @returns the identities the resume phase opens.
 */
async function seedSessions(ctx: Context, count: number): Promise<readonly SessionId[]> {
  const ids: SessionId[] = []
  for (let index = 0; index < count; index += 1) {
    const id = SessionId(`${PROBE_SESSION_PREFIX}-${String(index)}`)
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: HISTORY.timeZero,
      cwd: process.cwd(),
      isSeeded: false,
    }, {})
    try {
      await handle.append(syntheticHistory(id))
      await handle.flush()
    } finally {
      await handle.close()
    }
    ids.push(id)
  }
  return ids
}

/**
 * Open N persisted Sessions through the production registry and price each one.
 *
 * Seeding is fixture work and stays outside the measured interval: the sample
 * before the resumes is taken after the last seeded log has been closed and
 * collected, so the delta is what the live host retains per open Session.
 *
 * @param ctx - the booted profile context.
 * @param count - Sessions to open.
 * @returns the retained resident set across the opened Sessions.
 */
async function measureSessions(ctx: Context, count: number): Promise<PostureSessionMeasurement> {
  const ids = await seedSessions(ctx, count)
  const before = await collectAndSnapshot()
  const handles: AgentHandle[] = []
  try {
    for (const id of ids) {
      // The production registry parses the stored log, restores the Session, and
      // mounts the Agent over the shipped profile's own preset rows.
      handles.push(await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: BENCH_PROVIDER, model: BENCH_MODEL },
      }))
    }
  } catch (error: unknown) {
    // Whatever opened stays retained: the measured host would keep it too, and a
    // partial reading explains more than an unwound one.
    throw new Error(
      `opened ${String(handles.length)} of ${String(count)} Sessions before failing: ${String(error)}`,
    )
  }
  const after = await collectAndSnapshot()
  const deltaRssMb = round1(after.rssMb - before.rssMb)
  const deltaHeapMb = round1(after.heapUsedMb - before.heapUsedMb)
  return {
    sessions: handles.length,
    historyTurns: HISTORY.turns,
    before,
    after,
    deltaRssMb,
    perSessionRssMb: round1(deltaRssMb / count),
    perSessionHeapMb: round1(deltaHeapMb / count),
  }
}

async function measure(ctx: Context): Promise<MemoryPostureReport> {
  const activatedMs = round1(performance.now())
  const settle = SETTLE_MS
  const window = CPU_WINDOW_MS
  const count = SESSIONS
  const started = performance.now()
  await whenReady(ctx)
  const readyMs = round1(performance.now())
  await delay(settle)
  const idle = await measureIdle(window)
  let sessionsMeasurement: PostureSessionMeasurement | undefined
  let sessionsError: string | undefined
  try {
    sessionsMeasurement = await measureSessions(ctx, count)
  } catch (error: unknown) {
    sessionsError = error instanceof Error ? error.message : String(error)
  }
  return {
    profile: 'headless',
    activatedMs,
    readyMs,
    settleMs: settle,
    requestedSessions: count,
    idle,
    ...sessionsMeasurement === undefined ? {} : { sessionsMeasurement },
    ...sessionsError === undefined ? {} : { sessionsError },
    totalMs: round1(performance.now() - started),
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-session': import.meta.resolve('@deepseek-ai/dsh-session'),
})

/**
 * Start one measurement pass and keep the host alive until the report is flushed.
 * @param ctx - the booted profile context the probe was mounted into.
 */
export function apply(ctx: Context): void {
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS)
  void measure(ctx).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`, () => {
      clearInterval(keepAlive)
      process.exit(0)
    })
  }).catch((error: unknown) => {
    process.stderr.write(`memory posture probe failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, () => {
      clearInterval(keepAlive)
      process.exit(1)
    })
  })
}
