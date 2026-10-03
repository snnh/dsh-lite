---
description: "DeepSeek Harness Web 服务器的可选网络暴露：一行配置决定绑定地址，而可达网络的绑定必须具备持久访问令牌。"
kind: "bundle-row"
---

# @deepseek-ai/dsh-host-lan-access

[English](README.md) | 中文

## 摘要

`@deepseek-ai/dsh-host-lan-access` 是决定 Web 服务器绑定回环还是全部接口的开关。Web bundle 通过 `ctx.get` 从本行读取绑定地址，因此以默认配置挂载本行的树与不挂载它的行为完全一致。把本行的 `host` 设为 `0.0.0.0` 会把 harness 暴露给机器所连接的所有网络——而可达网络的绑定需要跨进程存活的令牌，本行会在提供服务之前解析它（Harness home 没有时就创建一个）。回到回环只需把该值改回或删除本行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 在局域网内暴露 harness

在 bundle patch 中修改本行的 host，或在 overlay 里覆盖它：

```yaml
- id: lan-access
  name: '@deepseek-ai/dsh-host-lan-access'
  config:
    host: 0.0.0.0
```

随后打印行会在回环地址旁给出局域网地址：

```
dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)
```

### 回到回环

把 `host` 改回 `127.0.0.1`，或整行删除。Web bundle 用 `ctx.get` 读取该值，因此缺少本行时它自己的回环默认值照常生效。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | `127.0.0.1` | Web 服务器绑定的地址 |

## 理解实现

### 为什么是一行配置而不是一个开关

命令行拒绝 `--host 0.0.0.0`，因为开关是每次调用都可做的临时决定，操作者可能在未重新审视姿态的情况下就做出它。配置行则是**声明过的姿态**：它存在于树里、可被审阅，删除它就是一次回滚。本行还拥有让暴露变得安全的那唯一前提——持久令牌——因此姿态与它的要求不会彼此脱节。

### 拒绝覆盖了什么

回环绑定只能从本机访问，所以本行不触碰令牌就提供服务：连接半区已经施加了进程内认证。其它任何绑定都能被可路由到该主机的东西访问，因此本行先解析持久令牌。无法建立令牌时——Harness home 不可写、配置值低于长度下限——本行拒绝激活，于是不会有 Web 服务器绑定一个它无法认证的网络地址。

## 延伸阅读

- `@deepseek-ai/dsh-client-connection` 用该令牌换取签名的浏览器 cookie，并拥有 Host/Origin 围栏。
- `@deepseek-ai/dsh-web-app` 把局域网地址采样进信任面，并打印局域网链接。

## 已知限制与后续工作

- **没有 TLS、没有 `Secure` cookie、没有 HSTS。** 令牌随打印 URL 出现一次，随后在明文 HTTP 上变为 `HttpOnly` cookie。超出可信网络的暴露预期经由反向代理或虚拟组网。
- **`0.0.0.0` 意味着所有接口。** 没有按接口选择，也没有对端白名单：本行放行绑定，而令牌负责把未认证请求挡在外面。
- **信任围栏不是认证层。** 它拒绝跨站与 DNS rebinding 请求；认证由令牌承担。

## 开发说明

### 覆盖率

`packages/*/*/src` 带有逐文件 100% 的语句、分支与函数门禁。本行的四条路径——默认回环、显式回环、放行的网络绑定、拒绝的网络绑定——各由 `tests/lan-access.spec.ts` 中的一个用例钉住，该测试在私有的临时 Harness home 上驱动本行。

### 测试

测试按用例 stub `DSH_HOME`，因此令牌的创建、复用与拒绝都在文件系统上被观察，而不是被假定。
