---
description: "面向 Host 包的、由 Chokidar 支撑的 watcher 生命周期：在一处创建每个文件系统 watcher、对其就绪状态把关、路由其失败并关闭它。"
kind: "package-library"
---

# @deepseek-ai/dsh-fs-watcher

[English](README.md) | 中文

## 概述

`dsh-fs-watcher` 让 Host 包无需依赖 watcher 库、也无需各自重新推导其生命周期规则，即可监听文件和目录。调用方保留自己的路径与选项——过滤、深度、写入稳定化、轮询——并订阅后端实际发出的事件。HMR 服务、本地文件系统、本地凭证存储和文件系统技能提供方都使用它。本库负责创建、就绪把关、失败路由与关闭；变更意味着什么仍由各消费方决定。

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

### 何时使用

当 Host 包需要监听文件系统，并且必须报告就绪状态、暴露后端失败、按确定顺序释放原生句柄时，使用 `createWatcher()`。当消费方必须先完成自身准备工作才能处理事件时，使用 `waitForReady()`。只读取一次路径的调用方则两者都不需要。

### 入口

用调用方自己的选项创建 watcher，订阅事件，然后等待初次扫描完成：

```ts
import { createWatcher, waitForReady } from '@deepseek-ai/dsh-fs-watcher'

declare const root: string

const watcher = createWatcher(root, {
  ignoreInitial: true,
  depth: 0,
  ignored: entry => entry.endsWith('.tmp'),
})
watcher.on('all', (event, path) => { console.log(event, path) })
watcher.on('error', (error) => { console.error(error) })
await waitForReady(watcher, { onError: (error) => { console.error(error) } })

// At teardown, and safe to call more than once:
await watcher.close()
```

`waitForReady()` 在初次扫描完成后 resolve，以第一个失败——或可选 signal 的中止原因——reject，并把之后的失败继续路由给 `onError`。准确的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

如果消费方监听的 Chokidar 大版本与本包自带的不同，把自己的模块作为可选的第三个参数传入，实例就来自它自己依赖的那个 Chokidar：

```ts
import * as chokidar from 'chokidar'
import { createWatcher } from '@deepseek-ai/dsh-fs-watcher'

declare const root: string

const watcher = createWatcher(root, { ignoreInitial: true }, chokidar)
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`createWatcher()` 从已加载的后端模块读取 watcher 工厂——具名导出或默认导出，取决于该模块携带哪一个——并把返回的实例包进一个门面，将 `on`、`once`、`off`、`close` 原样转发给它。因此监听器顺序、事件参数和 emitter 的错误语义完全保持后端本身的行为：门面增加的是生命周期，而不是转译。

`waitForReady()` 只让调用方的就绪状态结算一次。等待期间的第一个失败会 reject 返回的 promise；此后每一次失败都交给 `onError`，因此启动失败仍然只 reject 一次，而 watcher 之后的中断仍会被报告。就绪与失败监听器会在 watcher 的整个生命周期内保持挂载，而中止监听器在就绪结算后立即移除。

门面会计数自己未关闭的 watcher。该注册表是将来实施句柄或内存上限的唯一落点；目前它只做报告。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | watcher 创建、事件转发、就绪把关与存活 watcher 计数 |
| [`tests/fs-watcher.spec.ts`](tests/fs-watcher.spec.ts) | 以伪造后端覆盖创建、转发、就绪、中止、关闭与模块形状 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——本组中其他共享原语。
- [`packages/boot/hmr`](../../boot/hmr/README.zh.md)——决定模块变更意味着什么的模块与配置重载器。
- [`packages/fs/fs-local`](../../fs/fs-local/README.zh.md)——其 watch 只观察单个目标或其父目录的本地文件系统后端。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本库只管理 watcher 生命周期，自身不注册任何面向模型的内容。

#### KV Cache 影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每次调用一个后端实例**——`createWatcher()` 不会合并选项恰好一致的调用方。各消费方在深度、过滤器、路径拼写、轮询和写入稳定化上各不相同，共享实例会改变各自看到的事件；因此共享仍延期。
- **没有句柄上限**——`liveWatcherCount()` 报告未关闭的 watcher，但不会拒绝新的创建；容量策略仍属于各调用方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
