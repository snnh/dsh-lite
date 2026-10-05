---
kind: upgrade-guide
description: "客户端现在会在 60 分钟空闲后释放无人观察、也无回合在跑的会话实例；重新打开时会从宿主重新读取历史。"
---

# 空闲的客户端会话在 60 分钟后被释放

[English](guide.md) | 中文

## 变更

会话一旦被打开过，客户端（Web 页面、桌面应用，以及任何挂载 `@deepseek-ai/dsh-api-session-controller/client` 的嵌入方）此前会在进程存活期间一直保留该会话的实例——它的事件窗口、未结算的回显，以及绑定在其 Agent scope 上的所有插件注册。现在，当一个会话无人观察（会话快照与其事件窗口都没有订阅者）、没有在途工作（无正在跑的回合、无未结算的本地回显、无分页或打开中的历史）、且 60 分钟内没有任何活动落到它上面时，这个实例会被释放。发送提示词、回合状态变化、窗口上的实时事件，以及持久消息（包括另一个客户端发出的）都算活动；被观察或正在忙碌都会重置计时，所以被看着或正在工作的会话永不会被释放。

持久数据没有任何变化。侧栏行保留其标题、工作区与时间戳，宿主上的会话也原封不动。被释放的是客户端这一侧的副本：下次打开会从宿主重新读取历史，实例本地状态（已加载的更早分页、提示词错误横幅、等待中的首个回合）从头开始。

如果某个插件在超过该阈值期间持有 `SessionReference`，却没有观察这个会话，它会看到该引用报告这一代已被销毁——与它在 `release` 之后的表现相同。再次 retain 即可获得新的一代。

## 迁移

1. **保留默认值。** 该阈值是 Client Session Controller 自己的选项 `sessionIdleTtlMs`（`SessionManagerOptions.sessionIdleTtlMs` 与 `ClientSessionsOptions.sessionIdleTtlMs`），默认 `3600000`（60 分钟）。
2. **若不想用内存换这一行为**，把它设为 `0`，即可恢复实例常驻：

   ```ts ignore-check
   new ClientSessions(ctx, remotes, { sessionIdleTtlMs: 0 })
   ```

   自建管理器时用 `new SessionManager(remote, { sessionIdleTtlMs: 0 })`。随附的 Web 与桌面组合挂载 Client Session Controller 时不带按插件的配置，因此它们跟随默认值；要改动的是自行构造客户端会话层的嵌入方。
3. **确认**：打开一个会话，让它无人观察，等过阈值后，`ctx.sessions.binding(id)` 返回 `undefined`，下一次 `retain` 会为它发出新的 `session/follow`，而侧栏行始终不会离开列表。
