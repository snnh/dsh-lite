---
description: "长跑的 DeepSeek Harness 宿主启动时采用的常驻集策略，以及各包在策略之外释放内存时共用的收集器入口。"
kind: "package-library"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 摘要

`@deepseek-ai/dsh-memory` 只负责长跑宿主需要的三件事：触达运行时垃圾收集器的查找、它外面的节流窗口，以及常驻集看门狗——后者在启动后收集一次，其后仅在超过阈值时再收集，并按自己的间隔输出内存指标行。**查找本身才是杠杆**：没有 `--expose-gc` 启动的构建根本没有收集器，所以查找会设置该 flag 并在新 context 里读出 `gc`，而创建这个 context 同时把空闲页归还给操作系统。每个旋钮都有环境变量覆盖，`DSH_GC=0` 关闭整个策略；它是直接的库依赖，而不是 `cordis.yml` 里的一行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 启动策略

在繁重的 profile 工作开始之前调用一次 `startMemoryPolicy`，并传入报告行的落点：

```ts
import { policyOptionsFromEnv, startMemoryPolicy } from '@deepseek-ai/dsh-memory'

const options = policyOptionsFromEnv()
if (options !== undefined) {
  startMemoryPolicy({ ...options, log: line => { process.stderr.write(`${line}\n`) } })
}
```

策略安排三个 `unref` 过的定时器：一个在 `initialDelayMs` 之后收集一次；一个是每 `sampleIntervalMs` 一次的采样器——仅当读数达到或超过 `thresholdBytes`、且距上次收集已超过最小间隔时才收集；还有一个每 `metricsIntervalMs` 一次的内存指标行。`stop()` 清除三者，且可安全地多次调用；被清除的定时器不会再触发回调，因此每个回调都不需要检查某种 stopped 标志。

指标行报告的是收集报告给不出的东西：**没有任何收集发生时，内存正在做什么**。它沿用收集报告的前缀，保持单行，便于 grep 与 awk：

```text
memory policy: metrics at 2026-10-03T21:14:11.482Z, rss 152.3 MB, heap 45.6/48.0 MB, external 1.2 MB, collections 3, last collection 295s ago
memory policy: metrics at 2026-10-03T21:19:11.483Z, rss 154.1 MB, heap 47.2/49.0 MB, external 1.2 MB, collections 3, last collection 595s ago
```

时间戳为 ISO 8601 UTC，读的是挂钟，而不是调用方可能指向单调时钟的 `now`。`heap` 为已用/总量。`external` 是 C++ 对象持有的原生内存；由于它已包含 `arrayBuffers`，这里只报告这个超集。`collections` 统计本策略完成的收集次数（不含进程内别处调用的 `maybeGc`），`last collection` 是最近一次收集距今的整秒数——首次收集之前为 `never`。

### 在策略之外释放内存

那些一次性丢弃大对象图的包——缓存淘汰、会话拆除、终端缓冲释放——调用共用入口，而不是去够 `globalThis.gc`：

```ts
import { maybeGc } from '@deepseek-ai/dsh-memory'

maybeGc()        // collects unless the shared window is still open
maybeGc(true)    // collects now
```

`maybeGc` 在首次使用时建立**一个进程级**节流窗口，因此调用方无需各自维护间隔记账。需要独立窗口的调用方用 `createCollector` 自建。

### 调优

| 变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_GC` | 未设置 | `0` 关闭整个策略 |
| `DSH_GC_THRESHOLD_MB` | 256 | 常驻集阈值；`0` 关闭阈值采样，但启动收集仍然运行 |
| `DSH_GC_MIN_INTERVAL_MS` | 300000 | 两次收集之间的最小间隔 |
| `DSH_GC_SAMPLE_INTERVAL_MS` | 60000 | 常驻集采样间隔 |
| `DSH_GC_INITIAL_DELAY_MS` | 10000 | 启动收集前的延迟 |
| `DSH_GC_METRICS_INTERVAL_MS` | 300000 | 内存指标行的间隔；`0` 保留收集报告，关闭周期行 |

格式非法的值会保留默认值，而不是让启动失败。

## 理解实现

### 收集器查找就是杠杆

若运行时已暴露 `globalThis.gc`，`resolveCollectGarbage` 直接返回它；否则它设置 `--expose-gc`，并在一个新 context 里读出 `gc`。支撑这一形态的 A/B（构建产物 Web profile，就绪 14 秒后由外部采样器测量）：

| 启动形态 | 常驻集 |
|---|---|
| 无策略 | 255.8 MB |
| 使用默认阈值的策略 | 154.8 MB |
| 只做收集器查找、从不调用它 | 154.8 MB |
| 只做 `setFlagsFromString('--expose-gc')` | 260.8 MB |
| 新 context 里看不到 `gc` | 152.3 MB |

由此得到两个结论。下降来自**创建那个新 context**——显式收集报告的是已经降下来的常驻集，所以它提供的是可观测性并约束长跑宿主，而不是制造了这次下降。而查找的两半都不可省：只设 flag 毫无变化，而一个看不到 `gc` 的 context 仍会收集。

### 没有收集器时保持惰性

拒绝该 flag 钩子的运行时会得到一个惰性策略：它只打印一行，不做任何采样。本包其余部分照常工作——`maybeGc` 返回 `false`，`createCollector().collect()` 永不执行收集。

## 延伸阅读

- 仓库根目录的 `docs/` 描述了本包不得破坏的 Harness 契约。
- 常驻集工作的测量设施与其启动宿主放在一起；本包刻意不自带基准。

## 已知限制与后续工作

- **分代大小只能在启动时设置。** 堆已存在后再设置 `--max-semi-space-size` 毫无效果：同一个值传给 `node` 时实测 164.5 MB，而运行时设置器实测 256.3 MB。`dsh` 发布的是 `env node` 入口，无法携带 node 参数，所以想要那约 90 MB 的用户需自行设置 `NODE_OPTIONS=--max-semi-space-size=2`。与本策略叠加时实测 152 MB 对 153 MB——这正是 CLI 不去接管它的原因。
- **阈值看不到按会话的增长。** 常驻集始终低于阈值的宿主永不收集，即使它的堆在缓慢增长。会反复更替的缓存应当在自己的淘汰路径上调用 `maybeGc`。
- **本包不设置 `--max-semi-space-size`、GC 节流参数或 `MALLOC_ARENA_MAX`。** 节流常量需要一次真实会话负载下的测量，才能成为默认值。

## 开发说明

### 覆盖率

`packages/*/*/src` 带有逐文件 100% 的语句、分支与函数门禁。查找的失败路径——flag 钩子抛错的运行时，以及新 context 里看不到 `gc` 的情况——由 mock `node:v8` 与 `node:vm` 的测试覆盖。测试进程无法触达的那一条分支（没有收集器的运行时返回的惰性策略）带有内联原因的 `v8 ignore` 注释。

### 测试

`tests/memory.spec.ts` 用假定时器、注入的收集器与时钟驱动策略，因此不会真的执行收集，也不会等待任何挂钟间隔。查找本身既通过 stub 过的 `globalThis.gc` 覆盖，也走它自己的 flag 路径。指标行同样由假定时器驱动，其断言钉住该行的确切形态（含时间戳），而不是钉某个测试无法预测的内存读数。
