---
kind: upgrade-guide
description: "The projection cache's four read faces return promises, and a storage domain can now declare `residency: 'lazy'`, whose table handle has no synchronous reads."
---

# Projection-cache read faces are asynchronous

English | [中文](guide.zh.md)

## Change

`ctx.sessionProjectionCache` used to answer its read faces synchronously, because `session_projcache` was table-resident: opening the domain materialized every stored checkpoint. The domain now declares `residency: 'lazy'`, so `open` reads no record and every read is one durable point read of that Session's document. Four faces return promises: `cachedSnapshot(meta, keys?)`, `cachedPredecessorTitle(meta)`, `hydratePrepared(session, events)`, and `coldSnapshot(meta, inheritedEventCount, events)`. A caller that does not await now holds a `Promise`, so TypeScript call sites fail to compile.

Unchanged: the blocks each face returns, their `kind: 'cached'` and `asOfSeq` semantics, the stored format, and the service's own read copy (`residentMaxEntries`, `residentMaxBytes`) — that copy is now the cache's only resident state, and it still answers a hot Session without I/O.

`DomainSpec` also gained `residency?: 'eager' | 'lazy'`, and `KvUnit` gained `readRecord(table, key)` and `readGlobal()`. Omitting `residency` keeps today's eager behaviour. `domain.table(name)` of a lazy domain is a `LazyKvTable` — `read`/`put`/`delete`/`update` — with no synchronous `get`/`entries`/`keys`/`size`; and a record that fails its schema is reported by the read that meets it, under the spec's `invalidRecords` policy, instead of failing `open`. Why the flag is opt-in rather than a new default for every domain is recorded in the [lazy domain residency Agent Note](../../../../.agents/notes/implemented/architecture/2026-10-06-domain-lazy-residency.md).

## Migration

1. Await the four cache faces. `packages/api/session-controller/src/list.ts` and `packages/context/session-reference/src/index.ts` are the shipped pattern: a row for an attached Session still summarizes synchronously from the registry, and a cold row awaits its cache read.

   ```ts ignore-check
   const snapshot = await ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])
   ```
2. Declare `residency: 'lazy'` in a `defineDomain` spec you own only when every read of that table is a key lookup; keep the default when you scan or diff it, because a lazy handle has no `entries`/`keys`/`size`. Replace `table.get(key)` with `await table.read(key)`; the type checker names each remaining synchronous use.
3. Confirm: `pnpm run typecheck` reports no error at the old call sites, and after a Host restart `session.list` still fills each cold row's `projections` block — from one point read of `session_projcache/sessions/<id>.json`, so the first listing read of a Session is slower than the second.
