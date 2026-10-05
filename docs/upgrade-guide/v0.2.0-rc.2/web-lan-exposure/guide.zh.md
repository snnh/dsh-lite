---
kind: upgrade-guide
description: "Web profile 默认发布所有 IPv4 接口，而该默认值是这一行的 schema 默认值，不是任何一次启动写下的行。"
---

# Web profile 默认发布所有 IPv4 接口

[English](guide.md) | 中文

## 变更

在此版本之前，`dsh web` 绑定 `127.0.0.1`，因此只有运行它的那台机器能访问 harness。随附的 `lan-access` 行现在在没有声明 host 时发布**所有 IPv4 接口**：`0.0.0.0` 就是这一行的 schema 默认值，任何一次启动都不会把它写到任何地方。本版本的早期草稿会把它持久化进 profile 的 `cordis.patch.yml`，这一做法已回退。profile patch 多出一行会改变该行的组合配置，于是 Loader 会 reconcile 这个条目，而读取 `ctx.lanAccess.host` 的 `webserver` 行随之重载：旧监听关闭、在新端口重新绑定，而本次启动已经打印的 URL 仍然指着旧端口（实测：打印 `127.0.0.1:46455`，实际监听 `0.0.0.0:34421`）。「打印出来的 URL 能连上」与「首次启动写盘」无法并存，因此默认值留在 schema 里。

每个非回环 host 都要求 `$DSH_HOME/access-token` 处的持久访问令牌（权限 `0600`、首次启动时创建、可用 `DSH_ACCESS_TOKEN` 覆盖）；无法建立令牌的 host 会让启动失败，而不会以未认证方式监听——只读的 `DSH_HOME` 现在可能直接让启动中止。

绑定的判定顺序是：`--host`、组合后的行配置，最后是内置的 `0.0.0.0`。非回环绑定会在启动日志中写入一条警告——同时经 logger 与 console，因为默认 Web exporter 会过滤 `warn`——点名所绑定的地址、作为唯一认证者的令牌，以及如何收窄姿态。声明的 host 现在会在绑定之前被校验，校验用的是本行唯一的语法（`classifyBindHost`）：回环拼写（`127.0.0.1`、`localhost`、`::1`、`[::1]`）、`0.0.0.0`，或一个 IPv4 字面量。其余 IPv6 字面量——包括过去会被接受、绑上 IPv6 后让信任围栏对每个请求都回 403 的 `--host ::`——以及任何主机名，现在都会直接让启动失败。

## 迁移

1. **保持仅回环姿态**：显式声明 host——声明的 host 按原样绑定，不会有别的东西替你保存它：

   ```yaml
   - id: lan-access
     name: '@deepseek-ai/dsh-host-lan-access'
     config:
       host: 127.0.0.1
   ```

   放进 profile 的 `cordis.patch.yml`，或用 `--patch` 传入；`dsh web --host 127.0.0.1` 对单次运行等效，「通用」设置页的监听地址行则会为之后每一次启动保存它。删除该行已不再等于回环。

2. **改为只发布一个网络**：在同一行写入该网络的地址，例如 `host: 192.168.1.5`。删掉该行的 `host` 键，就会回落到内置的 `0.0.0.0`。

3. **轮换令牌**：删除 `$DSH_HOME/access-token`（或修改 `DSH_ACCESS_TOKEN`）并重启。此前打印过的所有 URL 随即失效。

4. **确认**：启动日志会带出这条暴露警告，含所绑定的地址与它的 `patchPath`；URL 行会同时给出回环 URL 与局域网 URL——`dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)`。

### 安全边界

服务器不提供 TLS、不设置 `Secure` 属性、也不发送 HSTS 头，因此令牌以明文穿过网络。请把接入的每个网络都视为可信，或在前面挡一层终止 TLS 的反向代理。
