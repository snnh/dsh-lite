---
kind: upgrade-guide
description: "Web profile 用 `webStartup` 与暴露行发布的 `lanAccess` 服务取代 `webRuntime` 服务以及 `web-runtime` 行的 `trustedHosts` 配置。"
---

# Web 监听与信任配置改由 `webStartup` 与 `lanAccess` 提供

[English](guide.md) | 中文

## 变更

Web profile 不再提供 `webRuntime` 服务，`web-runtime` 行也不再声明 `trustedHosts` 配置值。仍注入 `webRuntime` 的 profile、overlay 或 `--patch` 文件会等待一个永不挂载的服务，读取 `ctx.webRuntime.trustedHosts` 的表达式则会求值失败，导致必需的 Connection 无法启动。

取代它的是两行：`web-startup` 行提供一个 `webStartup` 服务，承载本次调用的各个 flag（含 `--trusted-host` 权威标识）；本 bundle 默认启用并挂载的 `lan-access` 行决定 Web 服务器绑定的地址并发布 `lanAccess` —— `webserver` 行读取其中的 `host`，URL 行把 `lanAddresses` 点名在本地 URL 旁边，`connection` 行把 `trustedHosts`（本次绑定发布的字面量加上 `--trusted-host` 取值）交给 `/api` 围栏。

绑定 host 的唯一权威是 `lan-access` 行的语法：回环拼写、本机某个接口的一个 IPv4 字面量、或表示所有 IPv4 接口的 `0.0.0.0` —— 后者仍是本 bundle 的随附姿态，且必须先取得持久访问令牌才会绑定。语法之外的 host 会让启动失败而不是回退，也不会有任何行去绑定操作者没有声明的地址。

## 迁移

1. 把所有需要调用信任的行上的 `inject: [webRuntime]` 换成 `inject: [webStartup, lanAccess]`。
2. 把 `ctx.webRuntime.trustedHosts` 表达式换成 `ctx.lanAccess.trustedHosts`，并删除已不存在的 `ctx.webRuntime.lanAddresses`。只需要本次调用自身权威标识的部署，改读 `ctx.webStartup.trustedHosts`。
3. 按这两个服务重写 `connection` overlay，并把原先放在 `web-runtime` 行上的 `trustedHosts` 值并入其表达式。patch 会替换目标行的整个 `config`，因此要完整重述该 config；数组取值的 `!!js` 表达式要写成带引号的标量：

   ```yaml
   # before
   - id: connection
     inject: [webRuntime]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webRuntime.trustedHosts]"
   # after
   - id: connection
     inject: [webStartup, lanAccess]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.lanAccess.trustedHosts]"
   ```

4. 保留暴露行能绑定的 `host`。`0.0.0.0` 仍是随附姿态，发布所有 IPv4 接口，由持久访问令牌认证；写成 `127.0.0.1` 则仅本机可达，写成本机某个接口的地址则只发布那一个网络。监听器自身的地址无需 `--trusted-host` 就被 Host 围栏接受；代理或 DNS authority 仍需要它。
5. 用迁移后的 overlay 启动：`dsh --profile web --patch ./extra.yml --no-open` 必须打印 `dsh web:` URL 行并正常服务。仍在等待 `webRuntime` 的行会让必需的 Connection 保持 pending 并报告激活失败；暴露行语法之外的 host 会让启动失败。`dsh --profile web --patch ./extra.yml --dump-config` 可在启动前打印组合后的 patch。[Web 组合包 README](../../../../packages/bundle/web-app/README.zh.md)说明这些行，[暴露行的 README](../../../../packages/host/lan-access/README.zh.md)说明绑定语法。
