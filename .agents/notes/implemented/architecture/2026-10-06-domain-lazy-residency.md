# Agent Note: Opt-in lazy domain residency, and the point-read seam it needs

Status: implemented

English | [中文](2026-10-06-domain-lazy-residency.zh.md)

## Problem

Opening a storage domain calls `KvUnit.loadAll()` and materializes every declared table, and the domain answers reads from that memory for as long as it stays open ([storage](../../../../docs/subsystems/storage.md)). That is right for a domain that scans or diffs its tables, and wrong for one that reads records by key alone. `session_projcache` is the extreme case: it keeps one row per checkpointed Session for the lifetime of the storage tree, so a host that lists a few hundred Sessions still held every checkpoint it had ever written. The projection cache had already bounded its own copy with `residentMaxEntries`/`residentMaxBytes`, which left the domain's materialized table as the second, unbounded holder of the same bytes — and the [memory-posture gate](../testing/2026-10-06-memory-posture-performance-gate.md) prices a host's resident set without attributing it, so the cost had to go rather than move.

The seam could not express the alternative. `KvUnit` exposed `loadAll` and the write primitives, so a domain that holds nothing had no primitive with which to answer one lookup: reading a single record did not exist.

## Decision

### `residency` is a spec field whose default is unchanged

`DomainSpec.residency?: 'eager' | 'lazy'` ([spec.ts](../../../../packages/storage/storage-domain/src/spec.ts)); absent means `'eager'`, which is the behaviour every existing domain keeps. `defineDomain` rejects any other value at module load, as it already does for `layout` and `invalidRecords`.

`'lazy'` changes two things. `open` reads the global slot alone through `KvUnit.readGlobal` and never calls `KvUnit.loadAll`, so per-record schema validation moves from open to the read that meets the record, under the spec's existing `invalidRecords` policy. And `domain.table(name)` yields a `LazyKvTable` — `read`/`put`/`delete`/`update` ([domain.ts](../../../../packages/storage/storage-domain/src/domain.ts)). Everything else about a domain is unchanged: the single per-domain write chain, durability before the readable state changes, `domain/changed` events, `missing-key`, and `delete`'s answer about prior existence. `Domain.table` is conditional on the spec, so a lazy domain cannot be handed the resident handle by mistake; the wrong shape is a compile error, not a runtime check. The consumer-facing migration is the [lazy-domain-residency guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/lazy-domain-residency/guide.md).

### The seam gained point reads, not a cache

`KvUnit.readRecord(table, key): Promise<unknown | undefined>` and `KvUnit.readGlobal(): Promise<unknown>` are new ([backend.ts](../../../../packages/storage/storage/src/backend.ts)), implemented by the json single-unit, the json per-record unit, the sqlite unit, and the storage-domain test double, with shared contract clauses covering the hit, an absent key, an absent table, an unsafe key, an unaccepted version, a closed unit, and the global. `readRecord` resolves exactly the value `loadAll()` reports for that key, so the two paths cannot disagree about what a medium holds. A lazy table has no record map to consult, so `read` reaches the medium on every call; `delete` decides existence on raw presence, because a record that fails its schema still exists; `update` re-reads at its own chain slot.

### A lazy table has no synchronous read on purpose

`LazyKvTable` carries no `get`, `entries`, `keys`, or `size`. A synchronous read of a record the domain does not hold can only lie: the only answer available to it is `undefined`, which a caller cannot tell from a genuinely absent record. Whole-table iteration is the same problem one level up, since `entries`/`keys`/`size` promise membership the domain cannot know without reading every document. Point reads are asynchronous because the answer lives on the medium; a package that scans its table declares an eager domain, and the handle shape states that requirement at the declaration instead of failing at the first scan.

### The projection cache's read faces follow its table

`session_projcache` declares `residency: 'lazy'` ([spec.ts](../../../../packages/session/session-projection-cache/src/spec.ts)), so the cache's read faces are asynchronous: `cachedSnapshot`, `cachedPredecessorTitle`, `hydratePrepared`, and `coldSnapshot` ([index.ts](../../../../packages/session/session-projection-cache/src/index.ts)). The service's own resident copy stays the fast path: a Session that copy holds is answered in the same tick, and a Session it dropped costs one point read of that Session's document, which admits the record back into the copy. A read captures the write serial before its point read and admits what it fetched only when no checkpoint invalidated the copy meanwhile, which is what stops a read that raced a checkpoint from publishing the record that checkpoint replaced. `list.ts` splits its summary path accordingly: a row for an attached Session still summarizes synchronously from the projection registry, and a cold row awaits the cache ([list.ts](../../../../packages/api/session-controller/src/list.ts)). Records, watermarks, identity matching, `compatibleVersions`, and the durable per-session document layout are unchanged; the [per-session files note](../../archived/architecture/2026-08-19-projection-cache-per-session-files.md) owns that layout decision and predates this one, so its description of the table read as synchronous and fully resident is history rather than current behaviour.

### The listing pays what the open no longer does

None of the read work left the system: what `session_projcache` used to read and validate for every stored record while a host booted, the listing that meets those records now pays, one durable point read per listed row ([list.ts](../../../../packages/api/session-controller/src/list.ts)). That is the trade the residency choice buys — a listing reads the rows it touches instead of the whole table at boot — and it is measurable rather than incidental. One [projection-list benchmark](../../../../benchmarks/session-corpus/projection-list.bench.ts) `tail` listing on the x64 CI-class runner (300 listed rows, 254 MB of stored record documents, ~883 KB each), CPU-profiled, spends its 3,318 ms of list + JSON time like this:

| Where the time goes | ms | Share |
|---|---:|---:|
| The domain's durable point read, entirely its record-schema validation | 1,905 | 57 % |
| — of which the checkpoint schema's `isJsonValue` walk | 1,619 | 49 % |
| The document read itself (`readFile`, UTF-8 decode, `JSON.parse`) | 406 | 12 % |
| The resident copy's byte pricing of each admitted record | 302 | 9 % |
| Garbage collection | 157 | 5 % |

The listing issues exactly one record read per row and no other access to that domain's medium: `strace` over the same listing shows one `openat` of a record document per listed row and not one `getdents64` under `session_projcache`, because the per-record unit's legacy-bootstrap gate — the only path that lists a directory — is reached when a document is absent, and a listing of stored rows never is. What can be overlapped is therefore the medium's latency alone, and the cold phase does overlap it: it holds `COLD_READ_WINDOW` (two) point reads in flight and still emits its rows in order, worth 3,262 ms → 3,211 ms on the first list and 3,183 ms → 3,109 ms on a repeat. The rest of a row — decode, parse, validation, byte pricing — runs on the host's thread either way, which is why that overlap is worth about 2 % of the listing and no more.

The benchmark's `tail` throughput allowance was recalibrated with those figures: 500 ms → 1,600 ms (3,211 ms measured ÷ the shared CI scale 2, rounded), so its budget moved from 1,250 ms to 4,000 ms, which is 1.25× the measured first list. `modest` and `cheap` keep their allowances, and the same arithmetic reproduces the `modest` reference from its measurement, so the change is the movement of this cost rather than a loosened gate.

## Alternatives considered

**Make every domain lazy.** Rejected: whole-table iteration is a requirement the eager domains actually have — the workspace registry rebuilds its entity order from `entries()`, `keys()`, and `size`, and the schedule store lists its tasks — and routing those reads to the medium would turn one memory read into a full scan per call. It would also move validation of authoritative data from a loud failed boot to whichever read happens to meet a bad record. Residency follows the access shape, and the access shape is the declaring package's own fact.

**A synchronous `get` on the lazy table that returns `undefined` on a resident miss.** Rejected: a synchronous read of a non-resident record can only lie. `undefined` is the answer for "no record", so the first cold listing would silently lose its cached columns and read as a Session with no metadata. Blocking or throwing instead would be a different falsehood or a worse API, and neither removes the need for the asynchronous `read` the callers use.

**Keep the domain eager and rely on archive-and-clear.** Rejected: a record leaves the medium only when the Session is archived, and boot still materializes one row per checkpointed Session, so the resident set keeps growing with the session directory. Asking users to archive Sessions is not a memory bound.

**Add a resident cache inside the storage domain.** Rejected: it would be a second budgeted copy of the same records, with its own eviction policy, size accounting, and coherence rules, competing with the copy the projection cache already owns. The same bytes would be counted twice against the same budget, and "which copy may a read trust after a write" — a question the cache answers with its write serial — would acquire a second, differently timed answer in the layer below.

## Consequences

Opening `session_projcache` reads no record, so the boot cost of the cache no longer grows with the number of checkpointed Sessions, and the projection cache's own copy is the only resident state of the pair.

A lazy domain gives up open-time validation. A stored record that fails its schema no longer fails the open; it fails the read that meets it under `invalidRecords` (`invalid-record`, or backed up aside and read as absent under `'backup-and-skip'`). Nothing validates the records no read touches, which is the same trade stated the other way.

Cold read faces are asynchronous and their callers await: a listing row for a Session the resident copy does not hold now costs one document read where it previously cost none, so the Session list carries a per-row I/O cost it did not have, and an in-tree caller that did not await does not compile. Writes, durability ordering, and change events are untouched by residency.

That read cost is bounded by the copy, not by the listing: the trade pays per Session for the Sessions a host re-lists while their records stay resident, and it does not pay at all for the records no listing touches. A corpus larger than `residentMaxBytes` (the projection-list benchmark's `tail` corpus is 254 MB against a 64 MiB default) shows the worst case instead — every listing refills the rows the previous one evicted, so its first and repeat lists cost the same 3.2 s, and the medium, not the copy, sets the pace. The bound is the memory policy's, and a deployment whose session directory exceeds it should read the repeat figure as a full re-read.

## Testing

- [lazy-residency.spec.ts](../../../../packages/storage/storage-domain/tests/lazy-residency.spec.ts): a lazy open materializes nothing (no `loadAll`, no table read), each read hits the medium, writes serialize and emit in order, `delete` decides on raw presence, both `invalidRecords` policies apply at read time, and close drains queued writes before it refuses.
- [resident-budget.spec.ts](../../../../packages/session/session-projection-cache/tests/resident-budget.spec.ts): the read faces serve from the resident copy, refill from one point read, and never admit a record a concurrent write replaced.
- [list-scheduling.host.spec.ts](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts): a cold row awaits its cache read, so a microtask lands between two cold rows, while cheap live rows stay in one synchronous slice.
