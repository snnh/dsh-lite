# Agent Note: Required memory-posture performance gate for the built headless CLI host

Status: implemented

English | [中文](2026-10-06-memory-posture-performance-gate.zh.md)

## Problem

The resident set and the idle CPU of a booted Harness host were measured by hand several times and guarded by nothing. The lazy-loading and on-demand client-bundle work moved the idle resident set from 266–275 MB to 236–240 MB; `--max-semi-space-size=4` moved the same host from 255.8 MB to 164.5 MB; one resumed Agent over a 127,400-event Session retained 26.1 MB of heap; idle CPU sat at about one 10 ms jiffy per 10 s. Every figure came from a manual run recorded in the memory workstream's plan, so an ordinary change — a new eager import, an unbounded cache, a timer that never stops — could give all of it back with every functional test green, because no check reads a process's resident set or its idle CPU.

The test process cannot supply that reading. Vitest's loader, its instrumentation, the parent's own heap and history, and the plugin rows the test harness mounts all belong to a resident set measured inside it, and a per-session figure needs a booted host that opens several Sessions and then keeps running. A delta also needs a collection on both sides of the measured interval: without one, the reading mixes what a Session retains with whatever the most recent operation allocated and had not released yet.

## Decision

The required benchmark lane runs `benchmarks/memory-posture/memory-posture.bench.ts`. The existing `test:bench` command builds it: `benchmarks/tsdown.config.ts` gained one entry that compiles `memory-posture.probe.ts` and `memory-posture.model.ts` into `benchmarks/.dsh-build/memory-posture/`, beside the workspace libraries and other compiled workers the lane already produces. The [Session-opening performance gate](2026-09-04-session-open-performance-gate.md) owns this lane, its `node 24 / benchmarks` job, and its outer job timeout; this change adds a measured path to that lane rather than a second job.

### The measured subject

The subject is the shipped built `apps/cli` entry point (`apps/cli/lib/bin.js`) booting the shipped `headless` profile — the keyless one — under plain Node in a fresh child process, never inside the Vitest process. One benchmark-owned `--patch` overlay shapes the boot instead of re-composing it:

- It disables the two one-shot runner rows, `headless-startup` and `headless-runner`, which own a task and exit with it; the probe replaces them as the owner of the process lifetime.
- It routes `session-persistence-jsonl` at the child's private Session root with Zstandard compression, so no ambient transcript is read or written.
- It inserts the compiled probe plugin and a benchmark-owned model adapter. The adapter registers the provider route a Session open needs and throws if a measured host ever asks it for a completion, so a profile change that starts running turns fails loudly instead of silently measuring a different path.

Every other shipped row mounts exactly as a user's boot mounts it, including the [resident-set policy](../../../../packages/util/memory/README.md) that `apps/cli/src/bin.ts` starts before the profile work. Both compiled plugins call `assertBuiltBenchmarkRuntime`, so a run reached through a TypeScript loader or from source is rejected instead of measuring a different runtime. Inside the child the probe waits for the launcher's committed readiness signal (`appReady`), settles, observes the idle resident set, spends one idle CPU window, opens the Sessions, writes one JSON line on stdout, and exits; the parent owns the deadline and the verdict.

Each child receives private `mkdtemp` home, workspace, and agents-home roots plus its own Session store, and the suite boots those roots once without measuring before it samples them. That priming is load-bearing: the first-ever boot of a profile creates the profile directories and pays Node's compile cache, so paying it inside one arbitrary sample would describe the machine's first run instead of the posture every later boot holds.

### The three budgets

| Budget | Ceiling | Verdict aggregate | Sampling |
|---|---|---|---|
| Idle resident set | 400 MB | Median of the samples | 3 fresh children, each sampled after a 15 s settle past the readiness signal |
| Per-session resident set | 64 MB | Maximum of the samples | 4 Sessions per child, each carrying 600 completed turns of 3,000 characters (~1.8 MB of persisted log) |
| Idle CPU | 500 ms (5 % of one core over 10 s) | Median of the samples | The idle window that precedes the Session phase |

The ceilings are reviewed source constants in `benchmarks/memory-posture/memory-posture.constants.ts`, with no environment override, because the [benchmark tree rules](../../../../benchmarks/AGENTS.md) require budgets to be enforced from reviewed constants; a budget change is a source diff a reviewer sees. The workload is fixed for the same reason: the synthetic history is authored through the production Session append path and the production assistant-stream compaction from reviewed constants, and no recorded transcript, user material, or ambient repository is read.

The idle sample waits out the shipped policy. `SETTLE_MS` is 15 s because the policy collects once 10 s after it starts, and a reading taken across that collection would price the transient a boot leaves rather than the posture a long-running host holds. Readiness anchors the wait, and `readyMs` is reported, but nothing enforces it: readiness is a boot-time quantity, and the timing lane owns boot time.

The per-session phase seeds its Sessions first and then prices the production `ctx.agents.resume()` open of each, so the measured path is the one a user's Session open takes — log parse, Session restore, Agent mount over the shipped profile's own preset rows. Seeding is fixture work outside the measured interval: the "before" snapshot is taken after the last seeded log has been closed, with two explicit collections around an event-loop yield under `--expose-gc`, so the delta is what the live host retains per opened Session rather than what authoring the logs cost. The verdict uses the maximum of the samples, not the median, because a child can hand freed pages back to the operating system inside its resume phase and a median would then under-report the resident set one Session holds. A per-session phase that throws fails its case with the recorded reason and the number of Sessions that had opened, rather than passing on a partial reading.

Idle CPU is process CPU — user plus system — over a 10 s window, decided on the median and reported both in milliseconds and in the 10 ms jiffies the memory workstream's decision record used, alongside the window length, the budget as a percentage of one core, and the user and system parts.

### Reference posture

One run of the whole file, on this development machine (Node v24.18.0, 16 CPUs, built CLI), reproduced across two full runs:

| Measurement | Observed | Budget |
|---|---:|---:|
| Idle resident set, median of 3 | 197.6 / 197.7 MB (samples 194.2–198.1 MB) | 400 MB |
| Idle `heapUsed` | 42.2 MB | — |
| Idle peak RSS (`maxRSS`) | ≈198 MB | — |
| Readiness (`readyMs`) | ≈443 ms | not enforced |
| Per-session resident set, median | 10.9–12.2 MB | 64 MB |
| Per-session resident set, maximum | 11.1–16.2 MB | 64 MB |
| Retained heap per Session | ≈3.3–3.4 MB | — |
| Resident-set delta for 4 Sessions | 43.6–48.7 MB | — |
| Idle CPU over 10 s | 0.5–0.8 ms, i.e. 0 whole jiffies | 500 ms |
| Whole file runtime | ≈104 s | job timeout |

Each verdict's log line reports the raw samples with their minimum, median, and maximum, and the aggregate it decides on, plus the platform, architecture, CPU count, available parallelism, and Node and V8 versions, so a reading can be placed against the machine that produced it. The reference figures above are a machine-class baseline for review, not a CI expectation: no budget multiplies or scales them.

## Calibration evidence

The ceilings are regression tripwires, not tight budgets, and the recorded reference posture sits far below each of them. A shared CI runner varies between machines by more than the roughly 40 MB the lazy-loading work won, so a ceiling tight enough to protect that difference would flake and would then be widened by habit. A reviewed ceiling can still fail a lost order of magnitude — an idle resident set climbing into the hundreds of megabytes, one Session retaining a large fraction of its own log — while a reviewer compares the tighter machine-class readings by hand: 266–275 MB idle before the lazy-loading work against 236–240 MB after, 164.5 MB with `--max-semi-space-size=4` against 255.8 MB without, and 26.1 MB of retained heap for one resumed Agent over a 127,400-event Session, all quoted from the memory workstream's manual measurements in the benchmark's own calibration block.

The benchmark carries a calibration `describe` block that pins the decision rather than a measurement: it asserts that the recorded reference posture (152 MB, 197.6 MB, and 240 MB idle; 9 MB, 16.2 MB, and 26.1 MB per Session; 10 ms of idle CPU) passes at the reviewed ceilings, that a material regression (700 MB idle, 200 MB per Session, 3,000 ms of idle CPU over 10 s) fails, and that the recorded +40 MB lazy-loading regression remains inside the reviewed ceiling by design. A future change to a ceiling or to a budget's aggregate has to touch those assertions too.

## Deliberate exclusions

- **Long-run drift.** The gate measures a settled posture once, in a bounded sample. A slow leak, or a cache that crosses a threshold after hours, is not in scope, and a passing reading here never claims the absence of one.
- **The browser face.** A browser's memory belongs to the [frontend performance budgets](2026-09-06-frontend-performance-budgets.md).
- **Model generation.** The per-session phase never asks a provider for a completion; the benchmark-owned adapter exists only so the production Session open resolves a route, and it throws if generation is ever attempted.
- **Readiness time.** `readyMs` is reported at about 443 ms and is not enforced, because boot time is the timing lane's subject and a posture ceiling must not quietly become a boot-time budget.

## Alternatives considered

**Add these cases to the Session-opening benchmark.** Rejected because that file measures cold Session-open latency through its own compiled workers and fixture roots, while posture belongs to a booted host's steady state; folding both into one file would make a single verdict line own two unrelated subjects, and the posture path would still have to boot the shipped CLI.

**Launch the host with a benchmark-owned minimal profile instead of the shipped `headless` profile.** Rejected because the resident set of a re-composed approximation is not the resident set of the shipped boot. The regression class this gate guards lives in which shipped rows load eagerly, so replacing them would measure around the thing that moved.

**Measure the boot in-process, inside the Vitest worker.** Rejected because the loader, the instrumentation, the parent's heap and history, and the harness's own mounted rows all enter the reading; a fresh child running built JavaScript is the only way the number describes the shipped host.

**Sample one long-lived child repeatedly.** Rejected because consecutive samples share one heap, allocator arena, and compilation state, so they cannot report sample-to-sample variance, and one bad boot would contaminate every verdict instead of one sample. Fresh children with private roots also keep ambient profiles and transcripts out of the reading.

**Enforce a tight ceiling near the reference posture.** Rejected because a shared CI runner's machine-to-machine variation exceeds the ~40 MB the lazy-loading work won, so a tight ceiling would either flake or be relaxed without evidence. The reviewed ceiling catches a lost order of magnitude; machine-class comparison stays a review act.

**Compare against a historical checkout in CI.** Rejected because a historical revision needs its own install and pins its own runner and Node version, so the comparison measures the environment change as much as the code change. Fixed workload plus reviewed constants reproduces without the extra install.

**Decide every budget on the median.** Rejected for the per-session reading: one child can return pages to the operating system inside its resume phase, so the median can under-report a real retained set; that budget uses the maximum, and the median stays in the log.

**Take the idle sample immediately after readiness.** Rejected because readiness fires while boot-time work is still draining and the shipped policy's own collection lands 10 s in, so an immediate reading prices a transient. The 15 s settle past readiness reads the posture a host actually holds.

**Allow an environment override so a debug run can relax a budget.** Rejected because the [benchmark tree rules](../../../../benchmarks/AGENTS.md) forbid environment overrides for performance budgets; a relaxed run would also make "passes in CI" and "passes locally" two different claims.

**Also gate long-run drift in the same file.** Rejected because hours-long soaks do not fit a bounded job, and a bounded sample cannot establish the absence of a leak; the memory workstream's threshold policy remains the drift mechanism.

## Consequences

Every pull request's benchmark job boots the built CLI four times — one priming boot plus three samples — and runs the whole file in about 104 s inside a 20-minute job. In exchange the lane gains an executable tripwire on the posture a long-running host holds, a per-session retention figure priced against a stated history size, and idle CPU in the unit the memory workstream used, all on the shipped boot rather than on a benchmark-shaped approximation.

The verdict is a tripwire, not a promise: a reading between the reference posture and the ceiling is a review signal about the machine or the change, and passing the ceiling never certifies that the posture is good. The reference figures are a machine-class baseline for review; with no time scale applied, they are not a CI expectation.

The workload, the settle, the sample count, and the aggregate each verdict uses are part of the decision, not incidental setup: changing the history size or the Session count silently moves what a per-session budget means, and changing the settle or the aggregate changes which reading is certified. Node, runner, or workload change requires resampling the same path and reviewing the constants in the same change; a business-implementation change must not relax a ceiling without new calibration data.

The gate deliberately does not measure long-run drift, the browser face, model generation, or readiness time, and it adds no production export: the probe and the model adapter are compiled benchmark-owned plugins mounted through the shipped overlay loader, and they reach product services only through built package exports.
