---
kind: upgrade-guide
description: "终端控制器现在强制 256 MiB 的宿主级缓冲上限，超过后拒绝新屏幕或订阅者。"
---

# 终端缓冲共享宿主级上限

[English](guide.md) | 中文

## 变更

`TerminalController` 过去只按订阅者和 Session 计费终端缓冲，多个并发 Session 可以无上限地预留屏幕和订阅者队列。现在每个屏幕按最坏尺寸、每个订阅者按完整队列计入 `terminal-controller` 行的 `maxTotalBufferedBytes`，默认 268435456 字节（256 MiB）。会越过上限的请求以 `terminal/capacity-reached` 拒绝，且不会回收任何已在运行的终端。把该键设为 `0` 可恢复旧的无上限行为。

并发终端很多、或 `scrollback`/`maxCols` 很大的部署，可能看到新终端或附件被拒绝，而不是成功创建。

## 迁移

1. 在配置 `terminal-controller` 的 profile patch 中保留默认值，或显式设置字节上限：

   ```yaml
   - id: terminal-controller
     config:
       maxTotalBufferedBytes: 536870912
   ```

2. 如果负载确实需要更多，调高 `maxTotalBufferedBytes`；如果只是持有被遗弃的屏幕，改为调低 `scrollback`、`maxCols` 或 `maxBufferedBytes`。只有在其他层已经限制终端内存时才使用 `0`。

3. 重启受影响的 profile，打开与之前相同数量的终端或附件。确认上限内的请求成功，越过上限的请求报告 `terminal/capacity-reached`，并带有 `limit`、`used`、`requested` 和 `purpose` 详情。
