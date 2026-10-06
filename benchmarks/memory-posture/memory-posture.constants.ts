/**
 * Reviewed memory-posture budgets and workload constants for the built headless
 * CLI host.
 *
 * Every number here is a source constant: `benchmarks/AGENTS.md` requires
 * budgets to be enforced from reviewed constants, never from environment
 * overrides, and the workload to be synthesized from fixed inputs. A reviewer
 * changing a budget changes this file, so the diff shows the decision.
 *
 * The reference posture these budgets trip on is recorded in
 * [memory-posture.bench.ts](memory-posture.bench.ts) and in the owning Agent
 * Note.
 *
 * @module benchmarks/memory-posture/constants
 */

/** Reviewed ceiling for the idle resident set of the built headless CLI host, in whole megabytes. */
export const RSS_CEILING_MB = 400
/**
 * Reviewed ceiling for the resident set one opened Session adds, in whole
 * megabytes. Recorded references: ~26.1 MB of retained heap for one resumed
 * Agent over a 127,400-event Session, and ~9 MB of resident set per Session for
 * the memory workstream's own synthetic probe. The reviewed workload below
 * measures ~11-16 MB per Session on the reference machine, so 64 MB is a
 * roughly fourfold envelope: loose enough for machine noise and history-size
 * drift, tight enough to reject an unbounded per-session cache.
 */
export const PER_SESSION_CEILING_MB = 64
/** Reviewed ceiling for idle CPU as a percentage of one core over the sampling window. */
export const IDLE_CPU_PERCENT = 5
/** Fresh children sampled per run; the median decides each verdict when more than one is taken. */
export const SAMPLES = 3
/** Delay after host readiness before the idle sample: the shipped policy collects once after 10 s. */
export const SETTLE_MS = 15_000
/** Length of the idle CPU window. */
export const CPU_WINDOW_MS = 10_000
/** Idle CPU allowance in milliseconds, derived from {@link IDLE_CPU_PERCENT} and {@link CPU_WINDOW_MS}. */
export const IDLE_CPU_BUDGET_MS = Math.round(CPU_WINDOW_MS * IDLE_CPU_PERCENT) / 100
/** Sessions opened by the per-session phase. */
export const SESSIONS = 4
/**
 * Reviewed synthetic history every opened Session carries. The per-session
 * budget only means something next to this size: 600 completed turns of
 * 3,000 characters is ~1.8 MB of authored log per Session, near a medium real
 * conversation.
 */
export const HISTORY = {
  /** Completed turns in one synthetic Session. */
  turns: 600,
  /** UTF-16 characters in each user prompt, so the parsed graph is not a shared constant. */
  promptChars: 3_000,
  /** Fixed clock for authored input only. */
  timeZero: 1_700_000_000_000,
} as const
/** Wall-clock bound for one child; a stuck boot is reaped well before the outer test deadline. */
export const CHILD_TIMEOUT_MS = 120_000

/** Identity prefix of the Sessions the probe opens, kept stable so repeated samples stay comparable. */
export const PROBE_SESSION_PREFIX = 'bench-memory-posture'
/** Provider route the benchmark-owned model adapter registers for Session opens. */
export const BENCH_PROVIDER = 'bench'
/** Model id the benchmark-owned model adapter answers to. */
export const BENCH_MODEL = 'bench'
