# Agent Note：可选的远程操作面

Status: implemented

[English](2026-10-07-remote-operator-surface-opt-in.md) | 中文

## Problem

通过 LAN 访问的部署能跑会话，却无法被管理。设置文档、插件配置与提供商凭据都在 `ctx.remote.$host.isLoopback` 之后（[ui-settings](../../../../packages/client/ui-settings/src/client/index.ts)），而 Connection 服务是从页面自身的 authority 推出该值的：`ownsHost`、非浏览器上下文，或 `isLoopbackHostname(location.hostname)`（[connection 客户端](../../../../packages/client/connection/src/client/index.ts)）。以 `http://192.168.1.5:3080` 提供服务的页面三者皆非，于是设置镜像以 `memory` 持久化构造，报 `settings are unavailable in this browser`，所有挂在 `configForms` 上的插件页面也永不出现。远程操作者只剩下读与对话的表面，无法在真正使用的地址上配置任何东西。

而本可让该页面安全的那些围栏其实都已通过：每个 `/api` 请求都先过 Host/Origin 信任围栏（接纳回环、`trustedHosts`，以及 Web 运行时从全接口绑定派生的 LAN 字面量），每个 RPC 处理器都在绑定持久访问令牌的浏览器会话之后（[浏览器认证](../../../../packages/client/connection/src/browser-auth.ts)）。令牌就是那一面唯一的认证者，而被冻结的 `memory` 模式是静默丢弃写入而不是拒绝——这是两种姿态里更糟的一半：既不能管理，也没有任何错误解释原因。

## Decision

### 由拥有该行的插件声明姿态

`client-connection` 行新增 `operatorSurface?: 'loopback' | 'trusted'`，默认 `'loopback'`（[schema](../../../../packages/client/connection/src/index.ts)）。默认值让所有既有部署保持原样。`'trusted'` 表示本 Host 提供的页面同时也是操作面：Host 解析一次，并把它与 recovery 全局并列注入为 `__DSH_OPERATOR_SURFACE__`，Connection 句柄再把它带进浏览器半区。

### 被提供的文档本身就是令牌已校验的证明

特权标志是**同步**授予的，不等待任何连接 generation，也不需要等：Host 自己的文档路由就在访问令牌闸之后——`GET /` 交换时写 `set-cookie` 并重定向，其余一律经 `writeUnauthorized` 返回 `401`——因此一个能存在的页面必定已经出示过有效令牌。它发起的读写仍然每次都要过信任围栏与会话检查，所以该姿态只放宽"页面被提供哪种 UI"，从不放宽未认证请求能触及的范围。

早先的修订版把该标志门控在"已认证的 connection generation"上，并从设置插件的 `apply` 里 await 它。那会让整个应用死锁：连接循环在客户端挂载之后才启动，activation 里 await 它就永不结算，被提供的应用在回环与 LAN 下都停在 `Loading plugins…`。

### `isLoopback` 保留名字与全部读取点

`$host.isLoopback` 是所有特权消费方已经在读的那一个事实（[gateway 客户端](../../../../packages/api/gateway/src/client/index.ts)），因此姿态并入该处，而不是新开一个每个消费方都得学的标志。这个名字现在的含义是"该页面可达特权面"，也正是它的读取方一直在问的问题。

## Consequences

- LAN 部署从此在它被提供服务的地址上自我管理：设置、插件清单，以及某个 profile 安装的 bundle 自带的设置页（例如 Role Config）在 `http://<lan-ip>:<port>/?token=…` 全部可用。
- 默认仍是 `loopback`，因此没有随包预设、golden 或既有 profile 改变行为：`test:expected`（109）、`test:e2e`（183）、`test:snapshot`（181）全部原样通过。
- 操作者选择的是真实的放宽：`operatorSurface: trusted` 下，任何持有访问令牌且能通过围栏的位置都可以写设置文档与插件配置——这与令牌对会话和工具已有的暴露相同。希望管理只限本机的部署保持默认，用隧道访问回环地址。
- `ConnectionHandle.operatorSurface` 是新增的必填字段，测试中手工构造的 Connection 替身必须声明它；本 fork 的 `job-controller` 替身已补。
- 相对上游的分叉是一个 schema 字段、一个注入全局与一个判定式；本 fork 将其作为有意偏离承载，上游默认值仍取保守一侧。
