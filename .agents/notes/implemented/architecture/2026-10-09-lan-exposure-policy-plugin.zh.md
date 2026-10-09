# Agent Note: LAN 暴露策略只属于一个插件

Status: implemented

[English](2026-10-09-lan-exposure-policy-plugin.md) | 中文

## Problem

本 fork 把网络暴露当作产品特性交付：`dsh web` 默认发布所有 IPv4 接口，在本地 URL 旁打印排名最高的局域网地址，把持久访问令牌作为可达绑定上唯一的认证者，并把该绑定发布的字面量纳入 `/api` Host 围栏。

这份策略此前分散在三个所有者手里。`packages/bundle/web-app/src/index.ts` 计算局域网快照（`resolveLanTrust`、`printableLanAddresses`），把它作为 `webRuntime` 服务提供，并在 URL 行追加 `(LAN: …)` 后缀；`packages/host/webserver` 在自己的 `Config.host` 文档里把暴露行称作其 host 语法的权威，却接受任何非空取值；`packages/bundle/web-app/src/startup.ts` 只负责把 `--host` 发布出去交给消费者决定。随后上游重设计了同一片区域——只允许一个具体绑定字面量、未指定地址在加载时被拒、删除 `webRuntime` 服务与局域网采样——于是每次合并上游都要在同一批文件上重开争论，而这个特性还依赖着上游正在删除的载体代码。

## Decision

由 Web bundle patch 挂载、默认启用的 `@deepseek-ai/dsh-host-lan-access` 端到端拥有一切暴露策略：按操作者权威顺序（`--host`，其次自己组合出的 `host`，最后随附的 `0.0.0.0`）解析绑定地址，语法之外的取值直接拒绝而不是回退，非回环绑定先要求持久访问令牌，通过 `ctx.logger.warn` 与 `console.warn` 各警告一次，并发布唯一一个服务：

```ts
interface LanAccessValues extends LanRuntimeValues {
  readonly host: string
}
interface LanRuntimeValues {
  readonly lanAddresses: string[]
  readonly trustedHosts: string[]
}
```

`lanAddresses` 是排名后的展示选择（物理接口优先，剔除链路本地与无地址记录），`trustedHosts` 是围栏的准入列表——本机持有的每个非 internal IPv4 字面量，加上 `--trusted-host` 取值。两者都在本行解析 host 时采样一次。

载体不判任何语法。`webserver.config.host` 接受任意非空字符串并交给 `listen`；暴露行的 `classifyBindHost` 是「可以声明什么」的唯一权威，设置页共用同一个函数，因此保存下来的姿态一定是可以绑定的姿态。回环由取值所指的**地址**判定而非拼写：插件复用载体导出的 `isLoopbackHost`（解析映射形式、点分四段尾式、zone 与 127/8 的字面量解析器），因此映射写法的回环仍然只绑定本机，而非回环的 IPv6 字面量依旧被拒绝。

bundle 改为读取该服务而不是自己计算：`web-app` 的 URL 行在本地 URL 旁点名 `ctx.lanAccess.lanAddresses[0]`，`connection` 行注入 `lanAccess` 并把 `ctx.lanAccess.trustedHosts` 交给它的 `/api` 围栏，`webRuntime` 服务不复存在。与这些不冲突的上游传输层工作全部保留：去 zone 且 IPv4 规范化的 URL 文本、带方括号的 IPv6 绑定、`--public-url` 与原生 TLS。

## Alternatives considered

**沿用上游「只允许具体绑定」的设计。** 它在加载时拒绝一切未指定地址并彻底删除局域网采样，等于删掉本 fork 已交付的特性（默认可达的局域网、`(LAN: …)` 链接、派生的围栏字面量）——设置页、文档与升级指南都在描述它们；而且这样仍需从一个没有载体可发布通配绑定的插件里重新实现它们。

**把局域网代码继续留在 web-app bundle 里。** 那是合并前的形态：bundle 拥有一份与浏览器粘合层无关的网络策略，`webRuntime` 成为它的第二个 bundle 级服务，每次合并上游都会在 URL 行与 bundle 服务清单上冲突；而且 bundle 没有操作者可以编辑的行，得不到可配置的姿态。

**在插件里重复实现回环字面量解析。** 插件本可自己解析映射形式与 zone，而不复用载体的判定函数，但那是同一套地址语法的两个解析器：去重门禁存在的意义正是阻止这种漂移——同一个取值对绑定算回环、对选择器不算，或者反过来。

**让载体保留一套校验语法，再由插件绕过它。** 只有宽容的载体才能让暴露行发布 `0.0.0.0`；一个独立于该行做校验的载体会拒绝该行认可的合法姿态。语法所有权跟随决策权，因此它属于做决定的那一行。

## Consequences

关闭暴露只需一行：给 `lan-access` 行写 `host: 127.0.0.1`（单次运行用 `--host 127.0.0.1`）。该行也可以整行移除——bundle 的 `webserver` 行读取 `ctx.lanAccess.host`，没有该行时回落到它自身的 config，同时不会再有派生字面量进入围栏。

载体的宽容是刻意的取舍：一个挂载了 `webserver` 却没有暴露行的组合，可以声明操作系统接受的任何 host（包括通配地址），没有行会警告或索取令牌。这是「把安全决策留在交付它的那一行」的已知代价；而发行组合的 Web bundle 始终挂载该行。

上游合并现在落在插件与一行 patch 配置上。载体只保留一处通用的单行 schema 偏差（任意非空 host）与 URL 格式化，而这两处上游自己的改动本来就已触碰过。

暴露行的 README、Web bundle README 与[web 监听升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.zh.md)是本笔记面向读者的另一半：它们说明姿态、语法，以及从 `webRuntime` 迁移到 `webStartup` 加 `lanAccess` 的路径。

## Testing

`packages/host/lan-access/tests/lan-access-bind-host.spec.ts` 钉住语法（所有回环拼写被接受；非回环 IPv6、映射写法下的通配地址、带空白与超长取值被拒绝）与拒绝消息；`lan-access-posture.spec.ts` 钉住姿态解析、令牌创建与警告文本；`lan-access-selection.spec.ts` 与候选排序用例钉住排名与展示选择。`packages/host/webserver/tests/webserver.spec.ts` 钉住载体的宽容与其地址判定。`packages/bundle/web-app/tests/lan-url-print.spec.ts` 针对该服务钉住打印的 LAN 链接，`container-publish-trust.spec.ts` 钉住围栏接缝，`packages/api/settings-controller/tests/web-host-bind-grammar.host.spec.ts` 钉住设置页与同一套语法一致。`apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`、`web-failure-matrix.expected.e2e.ts` 与 `apps/cli/tests/web-host-settings.e2e.ts` 在回环、映射回环与非回环绑定上启动构建后的 profile。
