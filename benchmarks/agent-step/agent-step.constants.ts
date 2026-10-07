/**
 * Reviewed workload scales and budgets for the per-step prompt and tool
 * assembly benchmark.
 *
 * Every number here is a source constant: `benchmarks/AGENTS.md` requires
 * budgets to be enforced from reviewed constants, never from environment
 * overrides, and inputs to be synthesized from fixed inputs. The synthetic
 * composition is sized against the shipped `standard` preset (16 tool packages
 * registering roughly two dozen model-facing tools, tens of prompt sections),
 * and the parameter/section text lengths are fixed so the JSON schema and
 * section byte totals the worker reports stay comparable between runs.
 *
 * The scenario matrix exists to attribute cost, not to gate it: only the
 * `primary` scenario carries a budget, while the gradients let the report
 * separate view/schema projection, deep cloning, and section text evaluation
 * by their slopes in tool count, section count, and the number of sections
 * that read the live tool view.
 *
 * @module benchmarks/agent-step/constants
 */

/** Fixed shapes every synthetic tool and section is built from. */
export const WORKLOAD = {
  /** Description characters on each synthetic tool. Shipped tool descriptions run to hundreds of characters. */
  toolDescriptionChars: 320,
  /** Declared parameter properties on each synthetic tool. */
  toolParameters: 6,
  /** Characters in one static (context-independent) section. */
  staticSectionChars: 640,
  /** Characters in one tool-gated section, whose text reads the live tool view. */
  gatedSectionChars: 480,
  /** Registered prompt variables. The shipped composition registers a handful per scope. */
  variables: 3,
  /** Registered dynamic context entries. */
  contexts: 2,
  /** Warmup assemblies before any sample. Also pays the first-call JIT inside the measured path. */
  warmups: 10,
  /** Measured assemblies per scenario. */
  iterations: 60,
} as const

/** One measured composition. */
export interface AssemblyScenarioSpec {
  /** Scenario identity carried into the report. */
  readonly name: string
  /** Registered model-facing tools. */
  readonly tools: number
  /** Registered prompt sections, excluding the never-rendered filter probe. */
  readonly sections: number
  /** Of `sections`, how many read the live tool view (the `tool-fs` availability-gate pattern). */
  readonly gatedSections: number
  /** Assembly waterfall listeners installed on the Agent scope, up to the three production shapes. */
  readonly listeners: number
}

/**
 * The gated-every-render probe section the third listener filters out. Kept
 * outside {@link AssemblyScenarioSpec.sections}: it must never reach a model,
 * and its only job is to prove the sections-filter listener ran.
 */
export const FILTER_PROBE_SECTION = 'bench:never-rendered'

/** Standard-like composition: the scale a shipped preset assembles for one step. */
export const PRIMARY_SCENARIO: AssemblyScenarioSpec = {
  name: 'primary',
  tools: 24,
  sections: 40,
  gatedSections: 15,
  listeners: 3,
}

/** Gradients around the primary composition, one dimension at a time. */
export const GRADIENT_SCENARIOS: readonly AssemblyScenarioSpec[] = [
  { name: 'tools-8', tools: 8, sections: 40, gatedSections: 15, listeners: 3 },
  { name: 'tools-48', tools: 48, sections: 40, gatedSections: 15, listeners: 3 },
  { name: 'sections-16', tools: 24, sections: 16, gatedSections: 6, listeners: 3 },
  { name: 'sections-64', tools: 24, sections: 64, gatedSections: 24, listeners: 3 },
  { name: 'gated-0', tools: 24, sections: 40, gatedSections: 0, listeners: 3 },
  { name: 'gated-30', tools: 24, sections: 40, gatedSections: 30, listeners: 3 },
  { name: 'bare', tools: 0, sections: 0, gatedSections: 0, listeners: 0 },
]

/**
 * Reviewed reference median for the primary scenario on the development
 * machine (x64 Linux, Node v24.18.0) — see the owning Agent Note for the
 * recorded run and the raw samples. The number is a regression tripwire's
 * anchor, not a claim about the reference arm64 machine.
 */
export const EXPECTED_PRIMARY_MEDIAN_MS = 0.5
/** Reviewed regression ceiling for the primary scenario's median, in milliseconds. */
export const PRIMARY_BUDGET_MS = 2
/** Fresh-child deadline; a stuck worker is reaped well before the outer test deadline. */
export const CHILD_TIMEOUT_MS = 120_000
