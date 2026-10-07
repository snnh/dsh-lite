/**
 * Compiled plain-Node worker for one Agent step's prompt and tool assembly.
 *
 * The measured subject is the built production assembly path: the real
 * `system-prompt` registry and the real `tools` registry mounted exactly as a
 * shipped profile mounts them, one Agent scope, and the assembly waterfall
 * listeners production installs on that scope. What is synthesized is the
 * *workload* — tool count, parameter schema shape, section count, and the share
 * of sections that read the live tool view through `ctx.tools.get()`, the
 * `tool-fs` availability-gate pattern — from the reviewed constants in
 * [agent-step.constants.ts](agent-step.constants.ts).
 *
 * Each scenario assembles in its own fresh `Context` inside its own process, so
 * a sample never shares registries, caches, or JIT state with another scenario.
 * The worker reports one JSON line on stdout; the parent owns the deadline and
 * the budget.
 *
 * @module benchmarks/agent-step/worker
 */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import {
  FILTER_PROBE_SECTION,
  GRADIENT_SCENARIOS,
  PRIMARY_SCENARIO,
  WORKLOAD,
  type AssemblyScenarioSpec,
} from './agent-step.constants.ts'

/** Provider route the variables-override listener reports, mirroring `model-selection`. */
const BENCH_PROVIDER = 'bench'
/** Model id the variables-override listener reports. */
const BENCH_MODEL = 'bench'

/** Which scenarios one child process measures. */
export type AssemblyBenchmarkMode = 'primary' | 'gradients'

/** One scenario's raw and aggregate measurement. */
export interface AssemblyScenarioReport {
  readonly scenario: string
  readonly tools: number
  readonly sections: number
  readonly gatedSections: number
  readonly listeners: number
  readonly iterations: number
  readonly medianMs: number
  readonly p10Ms: number
  readonly p90Ms: number
  readonly minMs: number
  readonly maxMs: number
  /** Process CPU (user + system) per assembly, in milliseconds. */
  readonly cpuPerIterationMs: number
  /** Serialized bytes of the assembled tool schemas. */
  readonly schemaBytes: number
  /** Bytes of all assembled section texts before interpolation. */
  readonly sectionBytes: number
  /** Every measured assembly's wall time, in milliseconds. */
  readonly sampleMs: readonly number[]
  /** Times each production listener shape actually ran; a scenario that skipped one is invalid. */
  readonly observations: {
    readonly observer: number
    readonly variables: number
    readonly filter: number
  }
}

/** Counters the installed listeners bump, so the report proves they ran. */
interface ListenerObservations {
  observer: number
  variables: number
  filter: number
}

/** Repeat `seed` until exactly `chars` characters, deterministically. */
function fill(seed: string, chars: number): string {
  return `${seed} `.repeat(Math.ceil(chars / (seed.length + 1))).slice(0, chars)
}

/**
 * One synthetic tool's parameter schema. Index-derived so repeated runs build
 * byte-identical schemas: scalar properties plus one nested object and one
 * array, the shapes shipped tool schemas are dominated by.
 * @param index - tool ordinal used inside descriptions.
 * @returns the reviewed parameter map, key order included.
 */
function syntheticParameters(index: number): ParameterSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (let property = 0; property < WORKLOAD.toolParameters; property++) {
    const description = fill(`Parameter ${property} of synthetic tool ${index}`, 60)
    if (property % 3 === 2) {
      properties[`entry_${property}`] = {
        type: 'object',
        additionalProperties: false,
        description,
        properties: {
          start: { type: 'integer', description: fill(`Start offset for tool ${index}`, 40) },
          end: { type: 'integer', description: fill(`End offset for tool ${index}`, 40) },
          mode: { type: 'string', enum: ['read', 'write'], description: fill(`Mode for tool ${index}`, 40) },
        },
      }
    } else if (property % 3 === 1) {
      properties[`items_${property}`] = { type: 'array', items: { type: 'string' }, description }
    } else {
      properties[`text_${property}`] = { type: 'string', required: true, description }
    }
  }
  return properties
}

/**
 * One registered tool definition, built through the production `defineTool`
 * helper so the JSON schema is the registry's own projection.
 * @param index - tool ordinal; also the global name suffix.
 * @returns a definition whose model-facing schema is representative in size.
 */
function syntheticTool(index: number): ToolDefinition {
  return defineTool({
    name: `bench_tool_${index}`,
    description: fill(`Synthetic tool ${index} exists so one assembled step carries a realistic schema.`, WORKLOAD.toolDescriptionChars),
    parameters: syntheticParameters(index),
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute() { return 'ok' },
  })
}

/**
 * Install the production `system-prompt/assemble` listener shapes on one scope.
 *
 * Shapes mirror the three shipped listeners, in the order they wrap the
 * waterfall: the prepended observer that records the assembled route
 * (`session-reference`), the variables override that stamps provider/model
 * (`model-selection`), and the sections filter that drops a section when a
 * per-agent condition holds (`browser-use-runtime`). The filter always fires
 * here — its condition is "this benchmark composition", not a browser status —
 * so the report can prove it participated.
 *
 * @param scopeCtx - the Agent scope's context, exactly where production installs them.
 * @param count - how many shapes to install (0-3).
 * @param observations - mutable counters proving each shape ran.
 */
function installListeners(scopeCtx: Context, count: number, observations: ListenerObservations): void {
  if (count >= 1) {
    scopeCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (context.agent !== undefined) observations.observer += 1
      return assembled
    }, { prepend: true })
  }
  if (count >= 2) {
    scopeCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      observations.variables += 1
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: BENCH_PROVIDER, model: BENCH_MODEL },
      }
    })
  }
  if (count >= 3) {
    scopeCtx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembled = await next()
      if (agent === undefined) return assembled
      observations.filter += 1
      return { ...assembled, sections: assembled.sections.filter(section => section.name !== FILTER_PROBE_SECTION) }
    })
  }
}

/**
 * Register one scenario's sections, variables, contexts, and tools.
 * @param ctx - context holding the real production registries.
 * @param spec - the scenario's reviewed composition.
 */
function registerWorkload(ctx: Context, spec: AssemblyScenarioSpec): void {
  for (let index = 0; index < spec.tools; index++) ctx.tools.register(syntheticTool(index))
  for (let index = 0; index < spec.sections; index++) {
    const name = `bench:section-${index}`
    if (index < spec.gatedSections && spec.tools > 0) {
      const toolName = `bench_tool_${index % spec.tools}`
      ctx.systemPrompt.section({
        name,
        order: index,
        text: ({ scope }) => ctx.tools.get(toolName, scope) === undefined
          ? ''
          : fill(`Guidance for ${toolName} assembled at ${name}.`, WORKLOAD.gatedSectionChars),
      })
      continue
    }
    ctx.systemPrompt.section({ name, order: index, text: fill(`Static section ${name}.`, WORKLOAD.staticSectionChars) })
  }
  ctx.systemPrompt.section({ name: FILTER_PROBE_SECTION, order: spec.sections, text: fill('Filter probe.', 64) })
  for (let index = 0; index < WORKLOAD.variables; index++) {
    ctx.systemPrompt.variable(`bench_variable_${index}`, () => fill(`variable ${index}`, 24))
  }
  for (let index = 0; index < WORKLOAD.contexts; index++) {
    ctx.systemPrompt.context({ name: `bench:context-${index}`, order: index, text: fill(`Context ${index}.`, 120) })
  }
}

/** Median of a non-empty sample set. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/** Round to three decimals (microsecond resolution). */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Measure one scenario: build its composition, warm up, then time each
 * `systemPrompt.assemble()` call — the exact per-step production entry point.
 * @param spec - reviewed composition for this scenario.
 * @returns the raw samples and the aggregates the parent decides on.
 */
async function runScenario(spec: AssemblyScenarioSpec): Promise<AssemblyScenarioReport> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const key: Record<string, unknown> = { id: 'agent-step-benchmark-agent' }
  const scope = createScope(ctx, key)
  try {
    const observations: ListenerObservations = { observer: 0, variables: 0, filter: 0 }
    installListeners(scope.ctx, spec.listeners, observations)
    registerWorkload(ctx, spec)
    // `agent` is the Agent scope key on the production path (`assembleContextFor`);
    // the augmentation lives in @deepseek-ai/dsh-agent, so the literal is widened here.
    const context = { scope: key, agent: key } as unknown as AssembleContext
    let assembly: PromptAssembly | undefined
    for (let warmup = 0; warmup < WORKLOAD.warmups; warmup++) assembly = await ctx.systemPrompt.assemble(context)
    // Warmups also run the listeners; only the measured phase counts observations.
    observations.observer = 0
    observations.variables = 0
    observations.filter = 0
    const samples: number[] = []
    const cpuStarted = process.cpuUsage()
    for (let iteration = 0; iteration < WORKLOAD.iterations; iteration++) {
      const started = performance.now()
      assembly = await ctx.systemPrompt.assemble(context)
      samples.push(performance.now() - started)
    }
    const cpu = process.cpuUsage(cpuStarted)
    if (assembly === undefined) throw new Error(`scenario ${spec.name} produced no assembly`)
    if (spec.listeners >= 1 && observations.observer !== WORKLOAD.iterations) {
      throw new Error(`scenario ${spec.name}: observer listener ran ${String(observations.observer)}/${String(WORKLOAD.iterations)} assemblies`)
    }
    if (spec.listeners >= 2 && assembly.variables['provider'] !== BENCH_PROVIDER) {
      throw new Error(`scenario ${spec.name}: variables listener did not stamp the assembled route`)
    }
    if (spec.listeners >= 3 && observations.filter !== WORKLOAD.iterations) {
      throw new Error(`scenario ${spec.name}: sections filter listener ran ${String(observations.filter)}/${String(WORKLOAD.iterations)} assemblies`)
    }
    if (spec.listeners >= 3 && assembly.sections.some(section => section.name === FILTER_PROBE_SECTION)) {
      throw new Error(`scenario ${spec.name}: the filtered probe section survived into the assembly`)
    }
    return {
      scenario: spec.name,
      tools: spec.tools,
      sections: spec.sections,
      gatedSections: spec.gatedSections,
      listeners: spec.listeners,
      iterations: WORKLOAD.iterations,
      medianMs: round3(median(samples)),
      p10Ms: round3([...samples].sort((left, right) => left - right)[Math.floor(samples.length * 0.1)] as number),
      p90Ms: round3([...samples].sort((left, right) => left - right)[Math.floor(samples.length * 0.9)] as number),
      minMs: round3(Math.min(...samples)),
      maxMs: round3(Math.max(...samples)),
      cpuPerIterationMs: round3((cpu.user + cpu.system) / 1000 / WORKLOAD.iterations),
      schemaBytes: Buffer.byteLength(JSON.stringify(assembly.tools)),
      sectionBytes: assembly.sections.reduce((total, section) => total + Buffer.byteLength(section.text), 0),
      sampleMs: samples.map(round3),
      observations,
    }
  } finally {
    await scope.dispose()
    await ctx.fiber.dispose()
  }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-tools': import.meta.resolve('@deepseek-ai/dsh-tools'),
  '@deepseek-ai/dsh-system-prompt': import.meta.resolve('@deepseek-ai/dsh-system-prompt'),
})

const mode = process.argv[2]
if (mode !== 'primary' && mode !== 'gradients') {
  process.stderr.write(`agent-step worker: expected mode "primary" or "gradients", got ${JSON.stringify(mode ?? '')}\n`)
  process.exit(1)
}

const specs = mode === 'primary' ? [PRIMARY_SCENARIO] : GRADIENT_SCENARIOS

const scenarios: AssemblyScenarioReport[] = []
for (const spec of specs) scenarios.push(await runScenario(spec))
// One JSON object (not a bare array) so the shared worker launcher, which reads
// the last line starting with `{`, can parse the report.
process.stdout.write(`${JSON.stringify({ scenarios })}\n`)
