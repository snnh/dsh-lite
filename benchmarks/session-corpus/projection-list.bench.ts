/** Session-list Host queue responsiveness; no browser input, transport, or paint is measured. */

import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import type { ProjectionListReport } from './projection-list.worker.ts'

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-corpus', 'projection-list.worker.js')
const ATTEMPTS = 3
const WORKER_TIMEOUT_MS = 120_000
/**
 * Coarse reference-machine throughput allowances, before CI scaling and
 * variance headroom.
 *
 * The `modest` and `cheap` allowances predate the projection cache's lazy
 * storage domain. The `tail` allowance prices it: `session_projcache` no longer
 * materializes its table at open, so the read and validation of every stored
 * record — which that domain used to pay while the host booted, outside this
 * file — is now paid by the listing that meets those records, one durable point
 * read per listed row the cache's bounded resident copy does not hold. That is
 * the intended trade: a listing reads only the rows it touches instead of every
 * record on the medium at boot, and a deployment whose copy covers its working
 * set pays the read once per Session rather than once per process.
 *
 * Measured on the x64 CI-class runner this lane's scale was calibrated against
 * (Node v24.18.0, 16 vCPU), median of three fresh children, on the asserted
 * list + JSON figure:
 *
 * | Workload | First list | Repeat list |
 * |---|---:|---:|
 * | modest | 100 ms | 23 ms |
 * | tail | 3,211 ms | 3,109 ms |
 * | cheap | 83 ms | 75 ms |
 *
 * Arithmetic for the one allowance that changed: `tail` first list 3,211 ms and
 * repeat 3,109 ms with the listing's two-row read window (3,262 ms / 3,183 ms
 * with the reads strictly one at a time). 3,211 ms ÷ the shared scale 2 =
 * 1,606 → 1,600 reference, so the budget is ceil(1,600 × 2 × 1.25) = 4,000 ms —
 * 1.25× the measured first list and 1.29× the measured repeat, the same
 * headroom the `modest` allowance carries (100 ms measured against its 125 ms
 * bound). The same derivation reproduces the unchanged allowances: 100 ms ÷ 2 =
 * 50 for `modest`, and `cheap` keeps its looser 150 ms ceiling.
 */
const LIST_REFERENCE_MS = { modest: 50, tail: 1_600, cheap: 150 } as const
/**
 * Queue-delay reference allowance above the measured 16 ms work slices and the
 * overshoot of one row — one cold read window for the persisted workloads.
 * Measured worst queue delay per workload: 7.2 ms (modest), 4.8 ms (tail, whose
 * rows block for the parse and validation of one stored record), and 16.0 ms
 * (cheap, which only has live rows).
 */
const CALLBACK_REFERENCE_MS = 30
/** Reference retained-heap allowance; memory receives variance headroom but no CPU scaling. */
const RETAINED_HEAP_REFERENCE_BYTES = 240 * 1024 * 1024

function median(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] as number
}

async function run(workload: ProjectionListReport['workload']): Promise<ProjectionListReport> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-projection-list-bench-'))
  try {
    const outcome = await runBuiltBenchmarkWorker<ProjectionListReport>({
      worker: WORKER, args: [root, workload], timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
    })
    if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
      throw new Error(`projection-list ${workload} failed: exit=${String(outcome.exitCode)}, signal=${String(outcome.signal)}, `
        + `timedOut=${String(outcome.timedOut)}\n${outcome.stderr.trim().split('\n').slice(-20).join('\n')}`)
    }
    return outcome.report
  } finally {
    // The shared launcher resolves only after child close, including timeout kills.
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['modest', 'tail', 'cheap'] as const)('serves the %s projection list without monopolizing the Host queue', async (workload) => {
  const reports: ProjectionListReport[] = []
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) reports.push(await run(workload))
  const firstMs = reports.map(report => report.samples[0]!.listAndJsonMs)
  const repeatMs = reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonMs)))
  const heapBytes = reports.map(report => Math.max(...[...report.samples, report.responsiveness].map(sample => sample.memory.heapUsedBytes)))
  const medians = {
    firstListAndJsonMs: median(firstMs),
    repeatListAndJsonMs: median(repeatMs),
    firstListMs: median(reports.map(report => report.samples[0]!.listMs)),
    repeatListMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listMs)))),
    firstListAndJsonCpuMs: median(reports.map(report => report.samples[0]!.listAndJsonCpuMs)),
    repeatListAndJsonCpuMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.listAndJsonCpuMs)))),
    retainedHeapBytes: median(heapBytes),
    worstCallbackDelayMs: median(reports.map(report => report.responsiveness.maxCallbackDelayMs)),
    repeatYieldCalls: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.yieldCalls)))),
    firstCallbackDelayMs: median(reports.map(report => report.samples[0]!.callbackDelayMs)),
    repeatCallbackDelayMs: median(reports.map(report => median(report.samples.slice(1).map(sample => sample.callbackDelayMs)))),
    firstEventLoopMaxMs: median(reports.map(report => report.samples[0]!.eventLoopMaxMs)),
    repeatEventLoopMaxMs: median(reports.map(report => Math.max(...report.samples.slice(1).map(sample => sample.eventLoopMaxMs)))),
  }
  const budgets = {
    listAndJsonMs: ciTimeBudget(LIST_REFERENCE_MS[workload]),
    callbackDelayMs: ciTimeBudget(CALLBACK_REFERENCE_MS),
    retainedHeapBytes: Math.ceil(RETAINED_HEAP_REFERENCE_BYTES * PERFORMANCE_BUDGET_HEADROOM),
  }
  console.log(JSON.stringify({ benchmark: `session-corpus/projection-list-${workload}`,
    reports, medians, budgets, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model } }))

  for (const report of reports) {
    expect(report.workload).toBe(workload)
    expect(report.fixture.sessions).toBe({ modest: 50, tail: 300, cheap: 3_000 }[workload])
    expect(report.fixture.baseRows).toBe({ modest: 100, tail: 1_000, cheap: 0 }[workload])
    expect(report.samples).toHaveLength(4)
    for (const sample of [...report.samples, report.responsiveness]) {
      expect(sample.items).toBe(report.fixture.sessions)
      expect(sample.wireViews).toBe(report.fixture.sessions)
    }
  }
  expect(medians.worstCallbackDelayMs).toBeLessThanOrEqual(budgets.callbackDelayMs)
  expect(medians.firstListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.repeatListAndJsonMs).toBeLessThanOrEqual(budgets.listAndJsonMs)
  expect(medians.retainedHeapBytes).toBeLessThanOrEqual(budgets.retainedHeapBytes)
}, ATTEMPTS * WORKER_TIMEOUT_MS + 30_000)
