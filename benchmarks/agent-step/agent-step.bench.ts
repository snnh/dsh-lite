/**
 * Required regression tripwire for the built per-step prompt and tool assembly
 * path, plus the gradients that attribute its cost.
 *
 * The measured subject is one Agent step's assembly — `systemPrompt.assemble()`
 * over the real prompt and tool registries, the call `agent-loop` issues once
 * per step — composed at the scale of the shipped `standard` preset and shaped
 * by the three production waterfall listeners. The workload and the budget are
 * reviewed constants in [agent-step.constants.ts](agent-step.constants.ts);
 * the recorded reference run and every deliberate exclusion live in the owning
 * Agent Note.
 *
 * Only the primary scenario is gated. The gradient scenarios exist so a
 * regression report can say *which* dimension grew — tools, sections, or the
 * tool-gated sections that rebuild the tool view — instead of only that the
 * total moved; their numbers are reported, never asserted beyond being a
 * usable measurement.
 *
 * @module benchmarks/agent-step/bench
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import {
  CHILD_TIMEOUT_MS,
  EXPECTED_PRIMARY_MEDIAN_MS,
  PRIMARY_BUDGET_MS,
} from './agent-step.constants.ts'
import type { AssemblyBenchmarkMode, AssemblyScenarioReport } from './agent-step.worker.ts'

/** Compiled worker directory; `test:bench` builds every entry before this file runs. */
const WORKERS = join(import.meta.dirname, '..', '.dsh-build', 'agent-step')

/** Median of a non-empty sample set. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/**
 * Run one child that measures the requested scenarios, under plain Node.
 * @param mode - which scenario set this child measures.
 * @returns the scenario reports in declaration order.
 */
async function run(mode: AssemblyBenchmarkMode): Promise<AssemblyScenarioReport[]> {
  const outcome = await runBuiltBenchmarkWorker<{ scenarios: AssemblyScenarioReport[] }>({
    worker: join(WORKERS, 'agent-step.worker.js'),
    args: [mode],
    timeoutMs: CHILD_TIMEOUT_MS,
  })
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error(`agent-step worker (${mode}) failed: ${JSON.stringify({
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr.split('\n').slice(-10).join('\n'),
    })}`)
  }
  return outcome.report.scenarios
}

describe('per-step prompt and tool assembly', () => {
  it('keeps the standard-like step assembly inside the reviewed budget', async () => {
    const [primary] = await run('primary')
    if (primary === undefined) throw new Error('primary scenario produced no report')
    console.log(JSON.stringify({
      benchmark: 'agent-step/primary',
      scenario: primary.scenario,
      tools: primary.tools,
      sections: primary.sections,
      gatedSections: primary.gatedSections,
      listeners: primary.listeners,
      iterations: primary.iterations,
      medianMs: primary.medianMs,
      p10Ms: primary.p10Ms,
      p90Ms: primary.p90Ms,
      minMs: primary.minMs,
      maxMs: primary.maxMs,
      cpuPerIterationMs: primary.cpuPerIterationMs,
      schemaBytes: primary.schemaBytes,
      sectionBytes: primary.sectionBytes,
      expectedMedianMs: EXPECTED_PRIMARY_MEDIAN_MS,
      budgetMs: PRIMARY_BUDGET_MS,
      samples: primary.sampleMs,
      observations: primary.observations,
    }))
    expect(primary.medianMs).toBeLessThanOrEqual(PRIMARY_BUDGET_MS)
  })

  it('reports the tool, section, and gated-section gradients that attribute the cost', async () => {
    const gradients = await run('gradients')
    console.log(JSON.stringify({ benchmark: 'agent-step/gradients', scenarios: gradients }))
    for (const scenario of gradients) {
      expect(Number.isFinite(scenario.medianMs)).toBe(true)
      expect(scenario.medianMs).toBeGreaterThan(0)
      expect(scenario.medianMs).toBeLessThanOrEqual(PRIMARY_BUDGET_MS)
    }
    const bare = gradients.find(scenario => scenario.scenario === 'bare')
    const primary = gradients.find(scenario => scenario.scenario === 'tools-48')
    if (bare === undefined || primary === undefined) throw new Error('gradient scenarios missing from the report')
    // The composition must actually dominate the fixed per-assembly overhead,
    // or the gradients would attribute noise.
    expect(primary.medianMs).toBeGreaterThan(bare.medianMs)
  })
})

describe('agent-step budget calibration', () => {
  it('accepts a recorded reference sample set', () => {
    // Recorded on the development machine; the owning Agent Note carries the run.
    const recorded = [0.587, 0.459, 0.603, 0.512, 0.754]
    expect(median(recorded)).toBeLessThanOrEqual(PRIMARY_BUDGET_MS)
    expect(median(recorded)).toBeLessThanOrEqual(EXPECTED_PRIMARY_MEDIAN_MS * 2)
  })

  it('rejects a synthetic regression over the budget', () => {
    const regression = [2.4, 2.6, 2.5, 2.7, 2.3]
    expect(median(regression)).toBeGreaterThan(PRIMARY_BUDGET_MS)
  })
})
