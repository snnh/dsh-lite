---
description: "面向部署方与维护者的持久会话投影缓存说明，用于选择、配置或排查持久检查点、常驻副本列表读取与加速的冷投影折叠。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

## 概述

本包保存持久的逐会话投影检查点，让历史列表、统计信息与 goal 快照无需加载每个会话日志即可读取缓存值。冷投影折叠可从已检查点化的前缀之后继续，从而减少重启后的工作量。会话日志始终是权威：崩溃可能使检查点陈旧，但不会使其领先于已提交事件；不兼容记录会被忽略或备份。当重启的会话需要频繁读取投影时选择本包；当投影只服务活会话，或额外存储写入与无限增长的检查点保留成本超过节省的工作量时跳过本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当客户端应在不加载日志的情况下列出冷会话投影值时，把本包与投影注册表及存储栈一起挂载。没有它时，消费方必须先取得日志，才能重建冷投影值。

### 何时选择

当部署会重启会话，并需要为历史列表、统计信息或 goal 快照提供持久投影值时，选择本包。当投影只服务活会话，或额外存储写入的成本高于所节省的投影工作时，跳过本包。

### 最小配置

两个节流字段均必填——写入节奏是部署选择，没有普适正确值：

缓存通过存储栈打开自己的域，因此 base 先挂 `storage`、`storage-json`（根 `dshHomePath('storages')`）与 `storage-domain`（`backend: json`）：

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `writeEveryEvents` | 必填 | 在各必写点之间强制一次持久检查点写入的每会话已提交事件数 |
| `writeIntervalMs` | 必填 | 各必写点之间脏检查点最长可保持未写入的时间 |
| `residentMaxEntries` | `5000` | 常驻读取副本在淘汰最久未服务记录前保留的会话记录数；`0` 表示该维度不设上限 |
| `residentMaxBytes` | `67108864` | 常驻读取副本在淘汰最久未服务记录前保留的估算字节数；`0` 表示该维度不设上限 |

本插件注入 `storageDomain`、`sessionProjections` 与 `sessions`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-projection-cache)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 检查点如何写入

三个必写点总是写入：会话创建保存由种子派生的切面，`turn/end` 保存列表读取所需的轮次终值，会话释放保存活会话的最终切面。其间，配置的条数与间隔节流随事件累积写入。每次写入通过领域写入链以原子方式替换该会话的完整记录；失败会记录警告并让缓存保持陈旧，后续写入会自行修复。

### 读取缓存值

`cachedSnapshot(meta, keys?)` 是只读面。它是异步的，且从不读取日志：它从本服务自己的、受预算约束的存量记录常驻副本提供客户端值，热会话在同一 tick 内得到回答；副本中已被淘汰的记录则由对该会话文档的一次持久点读回填——这正是冷会话付出的那一次读取，也是把取回的记录重新纳入副本的那一次读取，因此该会话随后的列表读取重新变热。它接受生命周期身份（`formatVersion`、`createdAt`、`cwd`、`isSeeded`）与 header 匹配的记录，把其中版本和 schema 均匹配的 key 作为一个 block 提供，其 `asOfSeq` 是所服务各行中最低的水位。这个水位是存储记录自己的：header 作证不了 inherited cut，也作证不了行序号与消费者稍后打开的日志可比，因此 Session list 把该 block 标为 `cached`，客户端让建连后的 Session 产出的任何值覆盖它。在同一格式代内，cut 在 fork 时写死，不能区分其他字段区分不了的生命周期，而只读视图也从不播种 fold，所以 seeded（fork 出来的）会话与 unseeded 会话被同样地提供。`cachedPredecessorTitle(meta)` 是跨 Session 格式 edge 的更窄列表专用例外：生命周期匹配且已通过结构准入的 predecessor record 只能公开与当前版本兼容的 `title` row，因为 title 文本在相邻 edge 之间保持不变。其他 predecessor row 仍不可用。`cachedPredecessorTitle(meta)` 与各 fold 面（`hydratePrepared`、`coldSnapshot`）遵循同一代价模型：会话热时用副本，冷时读一次它的缓存文档。`coldSnapshot(meta, inheritedEventCount, events)` 接受精确切点与完整有序日志，在折叠时跳过已检查点化的前缀，并在自身不读取持久化层的情况下刷新记录——这些路径上唯一的日志读取来自调用方提供的日志。

### 缓存保证什么

日志领先，缓存跟随：活会话检查点先把会话的缓冲事件持久化，然后才保存缓存记录。因此崩溃可能让缓存落后于日志，但绝不会让缓存领先。读取和写入共享存储域内一致的状态：每次写入都在持久化成功之后落在逐单元写入链上，而每次读取都是对某个会话文档的一次点读。该域声明 `residency: 'lazy'` 并不常驻任何记录，因此本服务自己的副本是这份持久缓存唯一的常驻状态。每个带版本戳的记录必须匹配当前运行单元的 schema 与生命周期身份（`formatVersion`、`createdAt`、`cwd`、`isSeeded`）；fold 面（`hydratePrepared`、`coldSnapshot` 与检查点写入）还要求精确的 `inheritedEventCount`，因此从另一会话格式代或 fork 切点折叠出的行不能播种调用方。JSON 后端把每条记录存于仅所有者可访问的 `<root>/session_projcache/sessions/<id>.json` 目录树中。Domain 读取校验保留检查点值中的所有自有 JSON 键，包括不透明元数据中的 `__proto__` 与 `constructor`。它拒绝无法无损完成 JSON 往返的值，并与检查点写入使用相同规则。随后，每个 projection 用自己的 `stateSchema` 校验 hydration 状态；承载不透明 JSON 的字段需要使用保留其键的校验器。

常驻副本是内存上限，而不是保留策略。它最多保留 `residentMaxEntries` 条记录以及这些记录被计价的 `residentMaxBytes` 字节，优先淘汰最久未被服务的记录；一次淘汰的代价只是对该会话文档的一次点读——它同时把记录重新纳入副本——绝不触碰持久文档，因此读取会话数远多于其所保留数量的主机自身不会持有无界结构。真正删除记录的是归档：被 Workspace 注册表归档的会话，其记录会从常驻副本与域中持久删除，因为归档集合会把它从所有读取缓存行的界面隐藏起来。释放则不会：活转冷的时刻写入最终检查点，因此已分离的会话仍继续提供其缓存值。清理是 fail-soft 的，其触发条件是结构化读取的（`workspace` 域上的 `domain/changed`），因此在没有挂载注册表、或面对它无法识别的快照时，缓存只是保留所有记录。

升级绝不拖垮启动，也不会暴露未经证明的折叠结果。版本戳落在 spec `compatibleVersions` 集合内的记录仍可被结构化读取并等待当前检查点重写，但缺失或更旧的 `formatVersion` 绝不匹配当前 Session，因此不能作为 hydrate seed。生命周期匹配的 predecessor title 只能通过上述列表 hint 读取，因为 title 文本在相邻 Session format edge 之间保持不变，并且该 row 仍须通过当前 projection `stateVersion` 与 schema。格式匹配后，缺失的 lineage 字段解码为 unseeded lineage——对非 fork 会话精确无误，seeded 调用方则通不过身份比对、回落冷折叠。仍然通不过 schema 校验的存量记录会按域的 `invalidRecords: 'backup-and-skip'` 策略移出为 `<id>.json.bak.<时间戳>`、连同原因写入日志，并由下一次检查点重建。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明缓存的持久性与存储所有权；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

缓存是投影注册表检查点接口上的折叠捷径，存于 `per-record` 领域数据表中。它带来六项后果：读取绝不绕过领域写入链；每次后台写入都 fail-soft；`ver` 不匹配时丢弃而不迁移记录；记录必须通过当前运行单元的 `stateSchema`；写入通过无损 JSON 边界替换一份完整会话记录；日志领先，缓存跟随。

### 读写所有权

缓存在 `session_projcache` 领域中为每个会话保存一份带版本戳的文档。它不依赖会话持久化后端，不调用 `locate`，也不检查逐会话目录。畸形或陈旧的记录读作不存在；需要冷值的消费方负责提供日志以重新折叠。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SessionProjectionCache` 服务、后台写入监听器、缓存读取 |
| [`src/spec.ts`](src/spec.ts) | `session_projcache` 域 spec 与记录身份类型 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从缓存逐步进入它检查点化的注册表与保存其记录的存储域。

- [会话投影子系统](../../../docs/subsystems/session-projection.zh.md)——本缓存检查点化的投影单元约定与驱动语义。
- [会话投影注册表](../session-projection/README.zh.md)——本缓存持久化其检查点的 `ctx.sessionProjections` 服务。
- [存储子系统](../../../docs/subsystems/storage.zh.md)——保存缓存记录的领域路由与后端行为。
- [会话包映射](../README.zh.md)——相邻的持久化、标题与遥测包。
- [会话投影 RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)——持久投影缓存的设计理由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为持久缓存只加速主机侧的投影状态读取，不注册任何模型可见内容。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明缓存何时需要运维注意。它们是当前包约束，不是任务积压。

- **一个冷读取面就是一次文档读取**——域不常驻任何记录，本服务的副本最多保留配置允许的数量，因此读取一个已被副本淘汰的会话要付出对该会话文档的一次点读（各 fold 面也因此是异步的）。重复读取由副本服务；归档会话会删除其记录，所以这棵树只随仍被列出的会话增长。
- **间隔节流采用按会话的粗粒度控制**——一次无脏数据的写入完成后，计时器在首个脏事件到达时启动；持续但低于条数阈值的事件流每间隔写入一次，而非滑动窗口。
- **缓存侧不做冷重折叠**——缓存只服务并刷新自己的记录，从不读取会话日志，因为它不依赖持久化层；需要保证冷快照的消费方自行从日志重新折叠。
- **每次 schema 或域版本变更都必须论证升级路径**——改动存储记录 schema 或域版本时，同一 PR 必须在 `tests/fixtures/` 下归档此前已发布磁盘格式的 fixture（测试前置数据），并在 `tests/fixtures.spec.ts` 中用测试论证所选的处置方式：读兼容恢复（`compatibleVersions`）、当前版本重写，或 backup-and-skip 抢救。即便选择直接丢弃旧记录的 bump，也要证明丢弃既不会导致启动失败，也不会污染缓存树。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
