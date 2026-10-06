/**
 * Required memory-posture budgets for the built headless CLI host.
 *
 * Three reviewed tripwires, each measured inside a fresh child running the
 * shipped `apps/cli` entry point and the shipped `headless` profile (the keyless
 * one):
 *
 * - **idle resident set** — sampled after the host settled past the shipped
 *   resident-set policy's startup collection, so the reading is the posture a
 *   long-running host actually holds rather than the transient a boot leaves.
 * - **per-session resident set** — the retained resident set one opened Session
 *   adds, measured across N production Session opens in the same host, each
 *   Session carrying the reviewed synthetic history in
 *   [memory-posture.history.ts](memory-posture.history.ts).
 * - **idle CPU** — process CPU over an idle window, reported both in
 *   milliseconds and in the 10 ms jiffies the decision record uses.
 *
 * The measured path is the shipped boot, not a re-composed approximation: one
 * benchmark-owned `--patch` overlay disables the one-shot runner that would
 * otherwise own the process lifetime and mounts the probe beside every other
 * shipped row, and the shipped resident-set policy in `bin.ts` keeps running.
 * A private `mkdtemp` home, workspace, and agents home — primed by one
 * unmeasured boot, so every sample reads the same warm posture — plus a private
 * Session store per child, keep ambient profiles and transcripts out of the
 * reading.
 *
 * Budgets are regression tripwires, not tight budgets: CI enforces the reviewed
 * constants in [memory-posture.constants.ts](memory-posture.constants.ts), and
 * the recorded reference posture sits far below each ceiling. Every verdict
 * reports the raw samples and the aggregate it decides on — the median for the
 * idle resident set and idle CPU, the maximum for per-session growth, because one
 * child can hand freed pages back to the OS inside its resume phase.
 *
 * Deliberate exclusions: long-run drift (hours, not a bounded sample), the
 * browser face, model generation (the per-session phase never asks a provider
 * for a completion), and any assertion about readiness time — `readyMs` is
 * reported because it is a boot-time quantity rather than a posture one — the
 * recorded reference for the same warm private home is ≈443 ms (the 652-806 ms
 * figures in the memory workstream's notes were measured for a cold, shared
 * home and before the compile-cache work).
 *
 * @module benchmarks/memory-posture/bench
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundedStderr, runMemoryPostureChild } from './memory-posture.child.ts'
import {
  CHILD_TIMEOUT_MS,
  CPU_WINDOW_MS,
  HISTORY,
  IDLE_CPU_PERCENT,
  IDLE_CPU_BUDGET_MS,
  PER_SESSION_CEILING_MB,
  RSS_CEILING_MB,
  SAMPLES,
  SESSIONS,
  SETTLE_MS,
} from './memory-posture.constants.ts'
import type { MemoryPostureReport, PostureSessionMeasurement } from './memory-posture.probe.ts'

/** Shipped entry point under measurement; `test:bench` builds it before this file runs. */
const CLI_BIN = join(import.meta.dirname, '..', '..', 'apps', 'cli', 'lib', 'bin.js')
/** Compiled benchmark-owned probe plugins mounted through the patch overlay. */
const WORKERS = join(import.meta.dirname, '..', '.dsh-build', 'memory-posture')

/**
 * Build the benchmark-owned profile overlay for one child.
 *
 * The shipped one-shot runner owns a task and dies with it; replacing it with the
 * probe keeps every other shipped row — including the shipped resident-set policy
 * `bin.ts` starts — exactly as a user boots them. Session storage moves to the
 * private root so no ambient transcript is read or written.
 *
 * @param sessions - private Session store for this child.
 * @returns the overlay document (JSON is valid YAML, as the shipped overlay loader expects).
 */
function patchDocument(sessions: string): string {
  return `${JSON.stringify([
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
    { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'zstd' } },
    { insert: [
      { id: 'memory-posture-benchmark-model', name: join(WORKERS, 'memory-posture.model.js') },
      { id: 'memory-posture-probe', name: join(WORKERS, 'memory-posture.probe.js') },
    ] },
  ], null, 2)}\n`
}


interface Metric {
  readonly min: number
  readonly median: number
  readonly max: number
  readonly samples: readonly number[]
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function metric(values: readonly number[]): Metric {
  return {
    min: rounded(Math.min(...values)),
    median: rounded(median(values)),
    max: rounded(Math.max(...values)),
    samples: values.map(rounded),
  }
}

function assertIdleWithinBudget(value: number, budgetMb: number): void {
  expect(value).toBeLessThanOrEqual(budgetMb)
}

function assertPerSessionWithinBudget(value: number, budgetMb: number): void {
  expect(value).toBeLessThanOrEqual(budgetMb)
}

function assertIdleCpuWithinBudget(value: number, budgetMs: number): void {
  expect(value).toBeLessThanOrEqual(budgetMs)
}

/** Owns one private root, the benchmark-owned patch overlay, and the memoized children. */
class MemoryPostureSuite {
  private scratch = ''
  private workspace = ''
  private home = ''
  private agentsHome = ''
  private pending: Promise<readonly MemoryPostureReport[]> | undefined

  async prepare(): Promise<void> {
    this.scratch = await mkdtemp(join(tmpdir(), 'dsh-memory-posture-'))
    this.workspace = join(this.scratch, 'workspace')
    this.home = join(this.scratch, 'home')
    this.agentsHome = join(this.scratch, 'agents')
    for (const directory of [this.workspace, this.home, this.agentsHome]) {
      await mkdir(directory, { recursive: true })
    }
  }

  async dispose(): Promise<void> {
    await rm(this.scratch, { recursive: true, force: true })
  }

  /** Sample every child once per run; later calls reuse the first sampling. */
  reports(): Promise<readonly MemoryPostureReport[]> {
    return this.pending ??= this.sampleAll()
  }

  private async sampleAll(): Promise<readonly MemoryPostureReport[]> {
    // One unmeasured boot primes the private home — the profile directory and
    // Node's compile cache — so every sample measures the same warm posture the
    // decision record's steady-state numbers describe, instead of paying for the
    // first-ever boot inside one arbitrary sample.
    await this.runChild('prime')
    const reports: MemoryPostureReport[] = []
    for (let index = 0; index < SAMPLES; index += 1) {
      reports.push(await this.runChild(`sample-${String(index)}`))
    }
    return reports
  }

  private async runChild(label: string): Promise<MemoryPostureReport> {
    // Every child gets its own Session store: the probe seeds stable identities,
    // so a shared root would make the second sample collide with the first.
    const root = join(this.scratch, label)
    const sessions = join(root, 'sessions')
    await mkdir(sessions, { recursive: true })
    const patchPath = join(root, 'memory-posture.patch.yml')
    await writeFile(patchPath, patchDocument(sessions))
    const run = await runMemoryPostureChild<MemoryPostureReport>({
      cliBin: CLI_BIN,
      patchPath,
      cwd: this.workspace,
      home: this.home,
      agentsHome: this.agentsHome,
      timeoutMs: CHILD_TIMEOUT_MS,
    })
    if (run.report === undefined) {
      throw new Error(
        `memory-posture ${label} child produced no report: exit=${String(run.exitCode)}, `
        + `signal=${String(run.signal)}, timedOut=${String(run.timedOut)}\n`
        + `${boundedStderr(run.stderr) || boundedStderr(run.stdout)}`,
      )
    }
    return run.report
  }
}

function requireSessionMeasurement(report: MemoryPostureReport): PostureSessionMeasurement {
  if (report.sessionsMeasurement === undefined) {
    throw new Error(`per-session phase failed: ${report.sessionsError ?? 'no reason reported'}`)
  }
  return report.sessionsMeasurement
}

describe('built headless CLI memory posture', () => {
  const suite = new MemoryPostureSuite()

  beforeAll(async () => { await suite.prepare() })
  afterAll(async () => { await suite.dispose() })

  it(`holds an idle resident set at or below ${String(RSS_CEILING_MB)} MB`, async () => {
    const reports = await suite.reports()
    const result = metric(reports.map(report => report.idle.rssMb))
    console.log(JSON.stringify({
      benchmark: 'memory-posture/idle-resident-set',
      profile: 'headless',
      result,
      budgetMb: RSS_CEILING_MB,
      settleMs: SETTLE_MS,
      readyMs: metric(reports.map(report => report.readyMs)).median,
      heapUsedMb: metric(reports.map(report => report.idle.heapUsedMb)).median,
      peakRssMb: metric(reports.map(report => report.idle.peakRssMb)).median,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      availableParallelism: availableParallelism(),
      node: process.version,
      v8: process.versions.v8,
    }))
    assertIdleWithinBudget(result.median, RSS_CEILING_MB)
  })

  it(`retains at most ${String(PER_SESSION_CEILING_MB)} MB of resident set per opened Session`, async () => {
    const reports = await suite.reports()
    const result = metric(reports.map(report => requireSessionMeasurement(report).perSessionRssMb))
    console.log(JSON.stringify({
      benchmark: 'memory-posture/per-session-resident-set',
      profile: 'headless',
      result,
      aggregate: 'maximum of the samples decides the verdict',
      budgetMb: PER_SESSION_CEILING_MB,
      sessions: SESSIONS,
      historyTurns: HISTORY.turns,
      promptChars: HISTORY.promptChars,
      deltaRssMb: metric(reports.map(report => requireSessionMeasurement(report).deltaRssMb)).median,
      perSessionHeapMb: metric(reports.map(report => requireSessionMeasurement(report).perSessionHeapMb)).median,
      node: process.version,
    }))
    // A single resident-set delta can under-report: the collector may hand freed
    // pages back to the OS inside the resume phase, so one child can show a
    // fraction of the retained growth. The ceiling is therefore checked against
    // the largest sample; the median and the retained-heap median stay in the log.
    assertPerSessionWithinBudget(result.max, PER_SESSION_CEILING_MB)
  })

  it(`spends at most ${String(IDLE_CPU_BUDGET_MS)} ms of CPU over a ${String(CPU_WINDOW_MS)} ms idle window`, async () => {
    const reports = await suite.reports()
    const result = metric(reports.map(report => report.idle.idleCpuMs))
    console.log(JSON.stringify({
      benchmark: 'memory-posture/idle-cpu',
      profile: 'headless',
      result,
      jiffies: metric(reports.map(report => report.idle.idleJiffies)).median,
      budgetMs: IDLE_CPU_BUDGET_MS,
      budgetPercentOfOneCore: IDLE_CPU_PERCENT,
      cpuWindowMs: CPU_WINDOW_MS,
      cpuUserMs: metric(reports.map(report => report.idle.cpuUserMs)).median,
      cpuSystemMs: metric(reports.map(report => report.idle.cpuSystemMs)).median,
      node: process.version,
    }))
    assertIdleCpuWithinBudget(result.median, IDLE_CPU_BUDGET_MS)
  })
})

describe('memory posture budget calibration', () => {
  it('accepts the recorded reference posture at the reviewed ceilings', () => {
    // Reference machine, built CLI: 152-240 MB idle across the lazy-loading and
    // on-demand client-bundle work, measured at 197.6 MB by this benchmark; the
    // memory workstream's own synthetic per-session probe measured ~9 MB, this
    // benchmark measures 11-16 MB, and 26.1 MB of retained heap belonged to one
    // resumed Agent over a 127,400-event Session; idle CPU was ~1 jiffy per 10 s.
    assertIdleWithinBudget(152, RSS_CEILING_MB)
    assertIdleWithinBudget(197.6, RSS_CEILING_MB)
    assertIdleWithinBudget(240, RSS_CEILING_MB)
    assertPerSessionWithinBudget(9, PER_SESSION_CEILING_MB)
    assertPerSessionWithinBudget(16.2, PER_SESSION_CEILING_MB)
    assertPerSessionWithinBudget(26.1, PER_SESSION_CEILING_MB)
    assertIdleCpuWithinBudget(10, IDLE_CPU_BUDGET_MS)
  })

  it('rejects a material regression outside the reviewed ceilings', () => {
    expect(RSS_CEILING_MB).toBe(400)
    expect(PER_SESSION_CEILING_MB).toBe(64)
    expect(IDLE_CPU_BUDGET_MS).toBe(500)
    assertIdleWithinBudget(197.6, RSS_CEILING_MB)
    expect(() => assertIdleWithinBudget(700, RSS_CEILING_MB)).toThrow()
    expect(() => assertPerSessionWithinBudget(200, PER_SESSION_CEILING_MB)).toThrow()
    expect(() => assertIdleCpuWithinBudget(3_000, IDLE_CPU_BUDGET_MS)).toThrow()
  })

  it('leaves the recorded +40 MB lazy-loading regression inside the reviewed ceiling by design', () => {
    // The pre-lazy-loading posture (266-275 MB idle) sits under the reviewed
    // ceiling on purpose: a shared CI runner varies more than that between
    // machines, so the ceiling is a tripwire for a lost order of magnitude. The
    // tighter machine-class readings are the ones a review compares by hand.
    assertIdleWithinBudget(275, RSS_CEILING_MB)
    expect(() => assertIdleWithinBudget(275, 250)).toThrow()
  })
})
