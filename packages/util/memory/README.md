---
description: "The resident-set policy a long-running DeepSeek Harness host boots with, plus the shared collector entry point and the cache budget primitives a cache bounds itself with."
kind: "package-library"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-memory` owns three things a long-running host needs: the lookup that reaches the runtime's garbage collector, a throttle window around it, and a resident-set watchdog that collects once after boot, afterwards only above a threshold, and logs a memory-metric line on its own interval. The lookup is the load-bearing part: a build without `--expose-gc` has no collector, so the lookup sets the flag and reads `gc` from a fresh context, which also returns idle pages to the OS. Every knob has an environment override, `DSH_GC=0` turns the policy off, and it is a library dependency, not a `cordis.yml` row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Boot policy

Call `startMemoryPolicy` once, before the heavy profile work begins, and pass a sink for the report lines:

```ts
import { policyOptionsFromEnv, startMemoryPolicy } from '@deepseek-ai/dsh-memory'

const options = policyOptionsFromEnv()
if (options !== undefined) {
  startMemoryPolicy({ ...options, log: line => { process.stderr.write(`${line}\n`) } })
}
```

The policy schedules three `unref`'d timers: one collection after `initialDelayMs`, a sampler every `sampleIntervalMs` that collects only when the reading is at or above `thresholdBytes` and the minimum interval has elapsed, and a memory-metric line every `metricsIntervalMs`. `stop()` clears all three and is safe to call more than once; a cleared timer never fires its callback, which is why no callback checks a stopped flag of its own.

The metric line reports what the collection reports cannot: what memory is doing while nothing collects. It keeps the collection reports' prefix and stays on one line, shaped for grep and for the awk that reads it:

```text
memory policy: metrics at 2026-10-03T21:14:11.482Z, rss 152.3 MB, heap 45.6/48.0 MB, external 1.2 MB, collections 3, last collection 295s ago
memory policy: metrics at 2026-10-03T21:19:11.483Z, rss 154.1 MB, heap 47.2/49.0 MB, external 1.2 MB, collections 3, last collection 595s ago
```

The timestamp is ISO 8601 UTC, read from the wall clock rather than through a `now` a caller may have pointed at a monotonic source. `heap` is used/total. `external` is the native memory held by C++ objects, and since it already includes `arrayBuffers` it is reported once as that superset. `collections` counts the collections this policy ran, `maybeGc` calls elsewhere in the process excepted, and `last collection` is the age of the last of them in whole seconds — `never` before the first one.

### Releasing memory outside a policy

Packages that drop a large object graph — a cache eviction, a session teardown, a released terminal buffer — call the shared entry point instead of reaching for `globalThis.gc`:

```ts
import { maybeGc } from '@deepseek-ai/dsh-memory'

maybeGc()        // collects unless the shared window is still open
maybeGc(true)    // collects now
```

`maybeGc` builds one process-wide throttle window on first use, so callers do not each carry their own interval bookkeeping. A caller that needs an independent window builds one with `createCollector`.

### Cache budgets

A long-running cache states its budget instead of growing with the workload it observes. `createBoundedMap` retains at most `maxEntries` entries and `maxBytes` priced bytes, dropping the least recently used entry after every `set` — entry count first, bytes second, and never the last entry standing, so one value priced above the whole byte budget is still cached rather than evicting itself:

```ts
import { createBoundedMap, createIdleCache, estimateJsonBytes, readHeapUsedBytes } from '@deepseek-ai/dsh-memory'

interface Projection { readonly id: string; readonly body: string }

const cache = createBoundedMap<string, Projection>({
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
  // The default prices the value alone; this one prices the key with it.
  estimateBytes: (value, key) => estimateJsonBytes(value) + estimateJsonBytes(key),
  onEvict: (key, _value, reason) => { process.stderr.write(`${key} left the cache (${reason})\n`) },
})
if (readHeapUsedBytes() > 512 * 1024 * 1024) cache.clear()

const idle = createIdleCache<string, Projection>({ idleTtlMs: 30 * 60 * 1000, maxEntries: 64 })
idle.get('s-1')   // a hit restamps the key's last activity
idle.stop()       // clears the sweep timer; the entries stay readable
```

Iteration is oldest first, matching a `Map`'s insertion order, so a caller that walks `keys()` or `entries()` reclaims in the same order the budgets do. `onEvict` reports one of five reasons: `entries` and `bytes` are the budgets evicting, `delete` and `clear` are the caller asking, and `idle` is the idle window reclaiming an untouched key.

`estimateJsonBytes` prices a value without serializing it: a string by UTF-8 byte length, a number 8 bytes, a boolean, `null`, or `undefined` 4 bytes, a function, symbol, or bigint 32 bytes, a `Uint8Array` or `Buffer` by `byteLength`, a `Date` 24 bytes, and an array, `Map`, `Set`, or object as the sum of its contents. Each object identity is charged once per call, so an alias or a back-reference adds nothing after its first visit — which is also what keeps a cyclic value from spinning the walk. The primitive is an estimate, not a measurement: it prices what a value costs to retain, it serializes nothing, and it is cheap enough to run on every write.

### Tuning

| Variable | Default | Meaning |
|---|---|---|
| `DSH_GC` | unset | `0` disables the whole policy |
| `DSH_GC_THRESHOLD_MB` | 256 | Resident-set threshold; `0` keeps threshold sampling off while the startup collection still runs |
| `DSH_GC_MIN_INTERVAL_MS` | 300000 | Minimum spacing between two collections |
| `DSH_GC_SAMPLE_INTERVAL_MS` | 60000 | Spacing between resident-set samples |
| `DSH_GC_INITIAL_DELAY_MS` | 10000 | Delay before the startup collection |
| `DSH_GC_METRICS_INTERVAL_MS` | 300000 | Interval between memory-metric lines; `0` keeps the collection reports and turns the periodic line off |

A malformed value keeps its default rather than failing a boot.

## Understand the implementation

### The collector lookup is the lever

`resolveCollectGarbage` returns an existing `globalThis.gc` when the runtime exposed one. Otherwise it sets `--expose-gc` and reads `gc` from a fresh context. The A/B behind that shape, measured on a built Web profile by an external sampler fourteen seconds after readiness:

| Launch | Resident set |
|---|---|
| No policy | 255.8 MB |
| Policy with the default threshold | 154.8 MB |
| Collector lookup only, never calling it | 154.8 MB |
| `setFlagsFromString('--expose-gc')` alone | 260.8 MB |
| Fresh context whose `gc` is absent | 152.3 MB |

Two conclusions follow. The drop belongs to creating the fresh context — the explicit collection reports a resident set that is already reduced, so it adds observability and bounds a long-running host rather than making the initial drop. And neither half of the lookup is optional: the flag alone changes nothing, and a context that cannot see `gc` still collects.

### Inert when there is no collector

A runtime that refuses the flag hook yields an inert policy: it logs one line and samples nothing. The rest of this package keeps working — `maybeGc` answers `false` and `createCollector().collect()` never runs a collection.

## Further Exploration

- `docs/` in the repository root describes the harness contracts this package must not break.
- The measurement harness for resident-set work lives beside the host that boots it; this package deliberately ships no benchmark of its own.

<a id="model-experience"></a>
## Model Experience

None, as the collector lookup, the throttle window, and the cache budgets only shape host resident-set behavior; no knob or reading enters a model request.

#### KV Cache effect

None; a collection or an eviction rewrites nothing in a request, so a prefix that was already reusable stays reusable.

## Known Limitations and Deferred Work

- **Generation sizes are startup-only.** Setting `--max-semi-space-size` after the heap exists changes nothing: the same value passed to `node` measured 164.5 MB where the runtime setter measured 256.3 MB. `dsh` publishes an `env node` entry point that cannot carry node arguments, so an operator who wants that ~90 MB sets `NODE_OPTIONS=--max-semi-space-size=2`. Stacked with this policy it measured 152 MB against 153 MB, which is why the CLI does not try to own it.
- **The threshold cannot see per-session growth.** A host whose resident set stays under the threshold never collects, even while its heap grows slowly. Caches that churn are expected to call `maybeGc` from their own eviction paths.
- **`--max-semi-space-size`, GC pacing, and `MALLOC_ARENA_MAX` are not set by this package.** Pacing constants need a measurement pass on a real session load before they become defaults.

### Dev Note

#### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. The lookup's refusal paths — a runtime whose flag hook throws, and a fresh context that exposes no `gc` — are covered by tests that mock `node:v8` and `node:vm`. The branch a test process cannot reach, the inert policy a runtime with no collector returns, carries a `v8 ignore` comment with the reason inline.

#### Tests

`tests/memory.spec.ts` drives the policy with fake timers and an injected collector and clock, so no collection actually runs and no wall-clock interval is waited. The lookup itself is exercised both through a stubbed `globalThis.gc` and through its own flag path. The metric line is driven the same way, and its assertions pin the exact shape of the line — timestamp included — instead of a memory reading that no test can predict. `tests/cache-budget.spec.ts` pins the estimator's per-type prices, the two budgets and the order they settle in, and the idle sweep, which it drives with fake timers and an injected clock; the one value it cannot predict, the heap reading, it compares against the live counter rather than a fixed number.
