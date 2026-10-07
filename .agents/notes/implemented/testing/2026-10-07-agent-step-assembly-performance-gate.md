# Agent Note: Per-step prompt-and-tool assembly performance gate

Status: implemented

English | [中文](2026-10-07-agent-step-assembly-performance-gate.zh.md)

## Problem

An Agent step opens with one `systemPrompt.assemble()` call: the framework merges the scope chain's sections, variables, dynamic contexts, and tool providers, deep-clones every provider's tool parameters, orders the catalog, and runs the `system-prompt/assemble` waterfall. The tools registry rebuilds its whole scope view on every read — one rebuild for the assembly's own provider, and one more inside each tool plugin section whose text asks `ctx.tools.get(name, scope)` whether its tool is visible (the pattern `tool-fs`, `file-reference-local`, and others use to render guidance only for tools that exist).

A CPU workstream wanted to memoize two of those reads — the tool schema projection and the assembled prompt — but had no measurement of the per-step path. Its own evidence gap said the payoff "depends on how many tools and sections one step carries", and nothing in the lane priced the path: [memory-posture](2026-10-06-memory-posture-performance-gate.md) measures a booted host's resident set and idle CPU, [session-open](2026-09-04-session-open-performance-gate.md) measures Session preparation and resume, and `agent-continuation` measures whole request/tool continuations. Without a number, the memoizations could have been designed, reviewed, and shipped for an amount of CPU no user can perceive — or skipped while a real hotspot stayed.

## Decision

The required benchmark lane runs `benchmarks/agent-step/agent-step.bench.ts`. The existing `test:bench` command builds it: `benchmarks/tsdown.config.ts` gained one entry that compiles `agent-step.worker.ts` into `benchmarks/.dsh-build/agent-step/`, beside the workspace libraries and the other compiled workers the lane already produces. The [Session-opening performance gate](2026-09-04-session-open-performance-gate.md) owns this lane, its `node 24 / benchmarks` job, and its outer job timeout; this change adds a measured path rather than a second job.

### The measured subject

The subject is the built production assembly path under plain Node in a fresh child process: the compiled `agent-step.worker.ts` mounts the real `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/dsh-tools` packages from their `lib/` entries, exactly as a shipped profile mounts them, and then times the call `agent-loop` makes once per step, `systemPrompt.assemble()`.

What is real: the two registries, the scoped-context machinery (`createScope`), and the three `system-prompt/assemble` listener shapes production installs on an Agent scope — the prepended observer that records the assembled route ([`session-reference`](../../../../packages/context/session-reference/src/index.ts)), the variables override that stamps provider and model ([`model-selection`](../../../../packages/core/agent/src/model-selection.ts)), and the sections filter that drops a section per agent ([`browser-use-runtime`](../../../../packages/experimental/browser-use-runtime/src/mcp.ts)). Each scenario fails rather than reports if a listener did not run for every measured assembly: a composition that quietly stopped dispatching listeners would measure the wrong path.

What is synthesized, from reviewed constants in [agent-step.constants.ts](../../../../benchmarks/agent-step/agent-step.constants.ts): the tool set (registered through the production `defineTool` helper, with fixed parameter shapes, nested objects, arrays, and fixed description lengths), the prompt sections (static text plus tool-gated sections that call `ctx.tools.get()`), and the prompt variables and dynamic contexts. The scales are sized against the shipped `standard` preset — 16 tool packages registering roughly two dozen model-facing tools — and deliberately sit at or above it: the primary composition is 24 tools, 40 sections, 15 of them tool-gated, while the preset's plugins register only a handful of tool-gated sections.

Each scenario builds its own `Context` inside its own fresh child, so a sample never shares registries, caches, or JIT state with another scenario or with a previous sample. Ten warmup assemblies precede the sixty measured ones, and the parent decides on the median. The worker reports the raw samples, the percentiles, process CPU per assembly, the serialized schema bytes, and the assembled section bytes, so a verdict can be explained without a rerun.

### The budget

Only the primary scenario is gated; the gradient scenarios are reported, never asserted beyond being a usable measurement.

| Budget | Ceiling | Verdict aggregate | Sampling |
|---|---|---|---|
| Primary per-step assembly | 2 ms | Median | One fresh child, 60 assemblies after 10 warmups |

The ceiling is a reviewed source constant in `agent-step.constants.ts` with no environment override, as the [benchmark tree rules](../../../../benchmarks/AGENTS.md) require. It is a regression tripwire, not a performance target: the recorded reference median is 0.48 ms, so the ceiling is a roughly fourfold envelope — loose enough for CI machine variance, tight enough to reject a path that starts rebuilding its inputs per section or per tool.

### Reference run and attribution

One run of the whole file on the development machine (x64 Linux, Node v24.18.0, built workspace):

| Scenario | tools | sections | of them tool-gated | Median | p10–p90 |
|---|---:|---:|---:|---:|---:|
| `bare` | 0 | 0 | 0 | 0.016 ms | 0.015–0.017 ms |
| `gated-0` | 24 | 40 | 0 | 0.196 ms | 0.192–0.224 ms |
| **`primary`** | **24** | **40** | **15** | **0.480 ms** | **0.456–0.620 ms** |
| `gated-30` | 24 | 40 | 30 | 0.661 ms | 0.648–0.812 ms |
| `tools-8` | 8 | 40 | 15 | 0.334 ms | 0.312–0.466 ms |
| `tools-48` | 48 | 40 | 15 | 0.689 ms | 0.656–0.900 ms |
| `sections-16` | 24 | 16 | 6 | 0.299 ms | 0.287–0.334 ms |
| `sections-64` | 24 | 64 | 24 | 0.604 ms | 0.571–0.723 ms |

The gradients attribute the cost:

- **Tool-gated sections dominate.** Fifteen of them add 0.28 ms to the primary assembly — 59% of the total — at 16–19 µs each, because every `ctx.tools.get()` rebuilds the scope's tool view. Thirty of them add 0.47 ms over `gated-0`; the `sections-16`/`sections-64` pair moves only by the gated difference.
- **Static sections are free.** The two section scenarios differ by 48 sections *and* 18 gated ones (0.31 ms); the 48 static sections contributes nothing measurable.
- **Tool count costs ~8.9 µs per tool** across the whole assembly (the provider's rebuild plus the extra entries every gated read copies), and `structuredClone` of each provider's parameters sits underneath it.

A CPU profile of the same child agrees: self time concentrates in `structuredClone` (12.3 ms of samples), the tools `view()` rebuild (4.9 ms) and the Cordis service-proxy `get` that each section's `ctx.tools` access goes through (4.0 ms), with garbage collection (7.8 ms) driven by the allocations those three make.

**The measurement closed the two planned memoizations, and that is recorded here so the analysis is not repeated.** At 0.48 ms per step — and closer to 0.2–0.3 ms for a composition shaped like the shipped `standard` preset rather than the deliberately heavier primary — the absolute saving is far below any user-perceptible threshold: a hundred-step Session would save tens of milliseconds against model latency measured in seconds. Memoizing the assembled prompt is also not safely possible as planned: the production listeners read ambient mutable state (a per-agent route selection, a browser client's status) and the assembly context carries no generation to key on, so a cache would need a new plugin-facing declaration to be sound.

## Consequences

- The per-step assembly path is priced by a gate for the first time. A change that starts rebuilding the tool view per section, re-cloning schemas more than once, or evaluating sections per step trips the primary budget, and the gradient report says which dimension moved.
- No product code changed. The memoizations the CPU workstream had planned (tool schema memoization; a keyed assembly cache) are declined on this evidence rather than left unmeasured; if a future workload makes per-step CPU matter — a much larger tool catalog, sub-second steps, or a host running many agents — the first candidates are recorded: the `tools.get()` view rebuild (~16–19 µs per call, a public API other plugins call too) and the per-provider `structuredClone`.
- The benchmark's own cost is small: the whole file runs in under a second on the development machine, so it does not lengthen the lane meaningfully.

## Alternatives considered

- **Memoize the tool schema projection first (the workstream's B2).** Rejected as the opening move: the measurement showed the tool-gated view rebuilds, not schema projection, to be the dominant term, and both are only worth doing if the absolute save matters — which it does not at this scale. The gradient matrix keeps the attribution available if that judgment is revisited.
- **Cache the assembled prompt (the workstream's B3).** Rejected as unsound without a new declaration: production `system-prompt/assemble` listeners read ambient mutable state and `AssembleContext` carries only the scope, an optional signal, and plugin-defined fields — there is no content generation to key on, and "skip the cache while any listener is registered" would disable it in every shipped composition (three listeners are installed per agent).
- **Extend `benchmarks/agent-continuation` with a per-step scenario instead of a new directory.** Rejected because the assembly would be buried inside model and persistence time, and the scale gradients — the part that attributes the cost — need a composition the benchmark owns.
- **Measure the whole `agent/pre-step` instead of `assemble()`.** Rejected as the first cut: it would add rendering, context projection, and a second waterfall, making the verdict about a mixture while the planned optimizations target the assembly. The rest of the step remains unpriced (see exclusions).

## Deliberate exclusions

- Process-level posture — resident set and idle CPU — stays with [memory-posture](2026-10-06-memory-posture-performance-gate.md); this gate times work, not posture.
- The rest of the step outside `assemble()` — context-section rendering, runtime-context projection, the `agent/pre-step` waterfall, request-header comparison, and Session persistence — is not measured here. A future finding that these dominate would need its own scenario, not a wider budget.
- Browser and desktop faces, and any real provider: the measured path is Host assembly only.
- Exact shipped tool schema sizes: the synthetic schemas are fixed reviewed shapes, not a recording of any preset, and the worker reports the resulting byte totals so a drift in the synthetic scale is visible in every report.
