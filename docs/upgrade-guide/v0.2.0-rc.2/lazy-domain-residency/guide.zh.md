---
kind: upgrade-guide
description: "投影缓存的四个读取面改为返回 Promise，且存储领域现在可以声明 `residency: 'lazy'`，其表句柄不提供任何同步读取。"
---

# 投影缓存的读取面改为异步

[English](guide.md) | 中文

## 变更

`ctx.sessionProjectionCache` 以往同步返回其读取面，因为 `session_projcache` 是表常驻领域：打开领域会物化每一条已存储的检查点。现在该领域声明 `residency: 'lazy'`，`open` 不读取任何记录，每次读取都是对该 Session 自身文档的一次持久化点读。四个读取面改为返回 Promise：`cachedSnapshot(meta, keys?)`、`cachedPredecessorTitle(meta)`、`hydratePrepared(session, events)` 与 `coldSnapshot(meta, inheritedEventCount, events)`。不 await 的调用方拿到的是 `Promise`，因此 TypeScript 调用点无法通过编译。

不变的部分：各读取面返回的 block、其 `kind: 'cached'` 与 `asOfSeq` 语义、存储格式，以及该服务自己的读取副本（`residentMaxEntries`、`residentMaxBytes`）——这份副本现在是缓存唯一的常驻状态，并且仍能在无 I/O 的情况下回答热 Session。

`DomainSpec` 新增了 `residency?: 'eager' | 'lazy'`，`KvUnit` 新增了 `readRecord(table, key)` 与 `readGlobal()`。省略 `residency` 仍保持今天的 eager 行为。lazy 领域的 `domain.table(name)` 是 `LazyKvTable`——`read`/`put`/`delete`/`update`——没有同步的 `get`/`entries`/`keys`/`size`；不符合 schema 的记录改由遇到它的那次读取报出，并沿用 spec 的 `invalidRecords` 策略，而不是让 `open` 失败。这个开关为何是 opt-in、而不是所有领域的新默认值，见[领域延迟驻留 Agent Note](../../../../.agents/notes/implemented/architecture/2026-10-06-domain-lazy-residency.zh.md)。

## 迁移

1. 为这四个缓存读取面加 `await`。`packages/api/session-controller/src/list.ts` 与 `packages/context/session-reference/src/index.ts` 是随附的写法：已附加 Session 的行仍从注册表同步生成摘要，冷行则 await 它的缓存读取。

   ```ts ignore-check
   const snapshot = await ctx.sessionProjectionCache.cachedSnapshot(header, ['title'])
   ```
2. 只有当该表的每一次读取都是按键查找时，才在自己拥有的 `defineDomain` spec 中声明 `residency: 'lazy'`；需要扫描或比对整表时保留默认值，因为 lazy 句柄没有 `entries`/`keys`/`size`。把 `table.get(key)` 换成 `await table.read(key)`；类型检查会逐处指出仍然同步的用法。
3. 确认：`pnpm run typecheck` 在旧调用点不再报错；重启 Host 后 `session.list` 仍为每个冷行填充 `projections` block——它来自对 `session_projcache/sessions/<id>.json` 的一次点读，因此同一个 Session 的第一次列表读取比第二次慢。
