# Agent Note: 领域延迟驻留为 opt-in，以及它所需的点读 seam

Status: implemented

[English](2026-10-06-domain-lazy-residency.md) | 中文

## 问题

打开一个存储领域会调用 `KvUnit.loadAll()` 并物化每一张已声明的表，领域在其存活期间从这份内存回答读取（[storage](../../../../docs/subsystems/storage.zh.md)）。对需要扫描或比对整张表的领域，这是对的；对只按键读取记录的领域，则是错的。`session_projcache` 是最极端的情形：它在存储树的整个生命周期内为每个已检查点化的 Session 保留一行，因此一个只列出几百个 Session 的宿主，仍然持有着它曾经写过的每一个检查点。投影缓存已经用自己的 `residentMaxEntries`/`residentMaxBytes` 约束了自己的副本，于是领域物化的表成了同一批字节的第二个、无上限的持有者——而[常驻集性能门槛](../testing/2026-10-06-memory-posture-performance-gate.zh.md)只给宿主的常驻集定价、并不归因，所以这笔开销只能被去掉，而不是被挪走。

seam 无法表达另一种做法。`KvUnit` 只暴露 `loadAll` 与各写入原语，因此一个什么都不持有的领域没有任何原语可以回答一次查找：读取单条记录这件事并不存在。

## 决策

### `residency` 是 spec 字段，默认行为不变

`DomainSpec.residency?: 'eager' | 'lazy'`（[spec.ts](../../../../packages/storage/storage-domain/src/spec.ts)）；缺省即 `'eager'`，也就是所有既有领域保持的行为。`defineDomain` 在模块加载时拒绝其他取值，正如它对 `layout` 与 `invalidRecords` 的做法。

`'lazy'` 改变两件事。`open` 只经 `KvUnit.readGlobal` 读取 global slot，绝不调用 `KvUnit.loadAll`，因此逐记录的 schema 校验从 open 移到遇到该记录的那次读取，并沿用 spec 现有的 `invalidRecords` 策略。`domain.table(name)` 交出的是 `LazyKvTable`——`read`/`put`/`delete`/`update`（[domain.ts](../../../../packages/storage/storage-domain/src/domain.ts)）。领域的其余一切不变：逐领域唯一的写链、可读状态改变前先完成持久化、`domain/changed` 事件、`missing-key`，以及 `delete` 对此前是否存在的回答。`Domain.table` 的类型随 spec 变化，因此 lazy 领域不会被误交予常驻句柄；形状错误是编译错误，而不是运行时检查。面向消费方的迁移见 [lazy-domain-residency 升级说明](../../../../docs/upgrade-guide/v0.2.0-rc.2/lazy-domain-residency/guide.zh.md)。

### seam 新增的是点读，而不是缓存

`KvUnit.readRecord(table, key): Promise<unknown | undefined>` 与 `KvUnit.readGlobal(): Promise<unknown>` 是新增的（[backend.ts](../../../../packages/storage/storage/src/backend.ts)），由 json 单单元、json 逐记录单元、sqlite 单元与 storage-domain 测试替身实现，并带有共享契约条款，覆盖命中、键缺失、表未声明、键不安全、版本未被接受、单元已关闭以及 global 语义。`readRecord` resolve 的正是 `loadAll()` 对该键报告的值，因此两条路径不会对介质持有什么产生分歧。lazy 表没有可查的记录 map，因此 `read` 每次调用都直达介质；`delete` 以原始存在性判定，因为不符合 schema 的记录依然存在；`update` 在自己的写链 slot 上重新读取。

### lazy 表刻意没有同步读取

`LazyKvTable` 不提供 `get`、`entries`、`keys` 或 `size`。对领域并不持有的记录做同步读取只能是撒谎：它能给出的答案只有 `undefined`，而调用方无法把它与真正不存在的记录区分开。整表遍历是同一个问题高一层的形式，因为 `entries`/`keys`/`size` 承诺的成员关系，领域不读遍每份文档就无从知晓。点读之所以异步，是因为答案住在介质上；需要扫描自己那张表的包就声明 eager 领域，句柄形状在声明处就把这项要求讲清楚，而不是在第一次扫描时失败。

### 投影缓存的读取面随它的表变化

`session_projcache` 声明 `residency: 'lazy'`（[spec.ts](../../../../packages/session/session-projection-cache/src/spec.ts)），因此缓存的读取面是异步的：`cachedSnapshot`、`cachedPredecessorTitle`、`hydratePrepared` 与 `coldSnapshot`（[index.ts](../../../../packages/session/session-projection-cache/src/index.ts)）。本服务自己的常驻副本仍是快路径：副本持有的 Session 在同一 tick 内得到回答，被副本淘汰的 Session 则付出对它自己文档的一次点读，这次读取把记录重新纳入副本。读取会在点读之前抓取写入序号，并且只在期间没有任何检查点使副本失效时才纳入取回的内容——这正是阻止一次与检查点赛跑的读取发布该检查点已替换掉的记录的原因。`list.ts` 相应拆分它的摘要路径：已附加 Session 的行仍从投影注册表同步生成摘要，冷行则 await 缓存（[list.ts](../../../../packages/api/session-controller/src/list.ts)）。记录、水位、身份匹配、`compatibleVersions` 以及持久化的逐会话文档布局都不变；该布局决策归[每会话缓存文件 note](../../archived/architecture/2026-08-19-projection-cache-per-session-files.md) 所有，而它早于本决策，因此它关于该表读取同步且完全常驻的描述属于历史，而不是当前行为。

### 列表付出 open 不再付出的那部分代价

这些读取工作并没有从系统中消失：`session_projcache` 过去在 Host 启动时为每一条已存储记录所做的读取与校验，如今由遇到这些记录的列表来付——每个列表行一次持久化点读（[list.ts](../../../../packages/api/session-controller/src/list.ts)）。这正是驻留模式取舍所换取的东西：列表只读取它触及的行，而不是在启动时读取整张表；这一点是可测量的，并非附带效果。在 x64 CI 级机器上对 [projection-list 基准](../../../../benchmarks/session-corpus/projection-list.bench.ts) 的一次 `tail` 列表（300 个列表行、254 MB 已存储记录文档、每条约 883 KB）做 CPU profiling，其 3,318 ms 的列表 + JSON 耗时分布如下：

| 时间去向 | ms | 占比 |
|---|---:|---:|
| 领域的持久化点读，全部花在它的记录 schema 校验上 | 1,905 | 57 % |
| ——其中检查点 schema 的 `isJsonValue` 遍历 | 1,619 | 49 % |
| 文档读取本身（`readFile`、UTF-8 解码、`JSON.parse`） | 406 | 12 % |
| 常驻副本对每条纳入记录所做的字节计价 | 302 | 9 % |
| 垃圾回收 | 157 | 5 % |

列表对每个行恰好发起一次记录读取，且不访问该领域的其他介质：对同一次列表运行 `strace` 可以看到每个列表行一次记录文档的 `openat`，而 `session_projcache` 之下一次 `getdents64` 都没有——因为逐记录单元的 legacy 引导闸门（唯一会列出目录的路径）只在文档不存在时才走到，而存取记录的列表永远不会走到那里。因此可重叠的只有介质的延迟，而冷行阶段确实重叠了它：它同时保持 `COLD_READ_WINDOW`（两个）次点读在途，并仍按行序发出这些行，使首次列表从 3,262 ms 降至 3,211 ms、重复列表从 3,183 ms 降至 3,109 ms。一行的其余部分——解码、解析、校验、字节计价——无论是否重叠都要在 Host 线程上运行，这正是该重叠只值列表约 2 % 的原因。

基准的 `tail` 吞吐量参考余量随这些数据重新校准：从 500 ms 改为 1,600 ms（实测 3,211 ms ÷ 共享的 CI 系数 2，取整），其预算随之为 1,250 ms → 4,000 ms，即实测首次列表的 1.25 倍。`modest` 与 `cheap` 保持原有余量，且同一算法能由其测量值复现 `modest` 参考值，因此这次改动是这笔开销的移动，而不是放宽闸门。

## 考虑过的替代方案

**让每个领域都 lazy。** 否决：整表遍历是 eager 领域确实拥有的需求——工作区注册表从 `entries()`、`keys()` 与 `size` 重建其实体顺序，schedule 存储也列举它的任务——把这些读取改走介质，会把一次内存读取变成每次调用的整表扫描。它还会把权威数据的校验，从一次响亮的启动失败挪到碰巧遇到坏记录的那次读取。驻留跟随访问形状，而访问形状是声明方自己的事实。

**在 lazy 表上提供同步 `get`，命中不到常驻记录时返回 `undefined`。** 否决：对并不驻留的记录做同步读取只能是撒谎。`undefined` 正是「没有记录」的答案，因此第一次冷列表会静默丢掉它的缓存列，读作一个没有元数据的 Session。改成阻塞或抛错，则是另一种谎言或更差的 API，两者也都免不掉调用方真正使用的异步 `read`。

**保持领域 eager，只依赖归档清除。** 否决：只有在 Session 被归档时记录才会离开介质，而启动仍会为每个已检查点化的 Session 物化一行，因此常驻集仍随会话目录增长。请用户去归档 Session 并不是内存上限。

**在存储领域内部再加一层常驻缓存。** 否决：那会是同一批记录的第二份受预算约束的副本，带着自己的淘汰策略、大小计价与一致性规则，与投影缓存已拥有的副本相互竞争。同一批字节会在同一份预算里被计两次，而「一次写入之后读取可以信任哪份副本」——缓存用写入序号回答的问题——会在下一层里多出一个时序不同的答案。

## 后果

打开 `session_projcache` 不读取任何记录，因此缓存的启动开销不再随已检查点化的 Session 数量增长，而投影缓存自己的副本是这一对中唯一的常驻状态。

lazy 领域放弃了 open 时的校验。不符合 schema 的已存储记录不再让 open 失败，而是让遇到它的那次读取按 `invalidRecords` 失败（`invalid-record`，或在 `'backup-and-skip'` 下备份挪走后读作不存在）。没有任何读取触碰的记录就无人校验，这不过是同一笔取舍的另一种说法。

冷读取面是异步的，其调用方要 await：常驻副本没有持有的 Session，其列表行如今要付一次文档读取，而过去一次都不付，因此 Session 列表带上了一项它此前没有的逐行 I/O 开销，而树内未加 await 的调用方无法通过编译。写入、持久化先后顺序与变更事件不受驻留模式影响。

这项读取开销由副本而非列表划定上界：只要记录留在常驻副本中，这笔取舍就按 Session 计价，而列表没有触及的记录则完全不必付费。比 `residentMaxBytes` 更大的集合（projection-list 基准的 `tail` 集合为 254 MB，而默认上界为 64 MiB）展示的是最坏情形——每次列表都要回填上一次淘汰掉的行，因此它的首次与重复列表耗时相同（3.2 s），节奏由介质而非副本决定。该上界属于内存策略，会话目录超过它的部署应把重复列表的数据读作一次完整重读。

## 测试

- [lazy-residency.spec.ts](../../../../packages/storage/storage-domain/tests/lazy-residency.spec.ts)：lazy open 不物化任何东西（不调用 `loadAll`、不读取任何表），每次读取都直达介质，写入按序串行并发出事件，`delete` 以原始存在性判定，两种 `invalidRecords` 策略都在读取时生效，close 先排空已排队写入再拒绝。
- [resident-budget.spec.ts](../../../../packages/session/session-projection-cache/tests/resident-budget.spec.ts)：各读取面由常驻副本服务、由一次点读回填，且绝不纳入被并发写入替换掉的记录。
- [list-scheduling.host.spec.ts](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts)：冷行会 await 它的缓存读取，因此两个冷行之间会落入一个 microtask，而低开销的 live 行仍留在同一个同步时间片内。
