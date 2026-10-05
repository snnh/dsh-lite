---
description: "DeepSeek Harness 宿主用于浏览器认证的持久访问令牌：环境变量覆盖、Harness home 文件、以及以属主专用权限生成。"
kind: "package-library"
---

# @deepseek-ai/dsh-access-token

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-access-token` 解析宿主用于浏览器请求认证的令牌，并让它跨重启存活。每个进程新生成的令牌会让网络地址变得无用：用户打开或分享链接、重启 harness，链接随即失效。解析顺序为 `DSH_ACCESS_TOKEN`、Harness home 下的 `access-token` 文件，最后是重新生成的 32 字节 hex 值并以其属主专用权限写回。删除该文件（或改动环境变量）即在下一次启动时轮换令牌。请把它当作直接的库依赖使用，而不是通过 `cordis.yml`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 解析令牌

```ts
import { ACCESS_TOKEN_FILENAME, ensureAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const token = await ensureAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME))
```

### 只读不创建

```ts
import { ACCESS_TOKEN_FILENAME, accessTokenFromEnv, readPersistedAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const configured = accessTokenFromEnv() // undefined, the token, or a throw
const stored = await readPersistedAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME)) // undefined when absent or unusable
```

### 常量

| 导出 | 值 | 含义 |
|---|---|---|
| `ACCESS_TOKEN_ENV` | `DSH_ACCESS_TOKEN` | 环境变量覆盖 |
| `ACCESS_TOKEN_FILENAME` | `access-token` | Harness home 下的文件名 |
| `MIN_ACCESS_TOKEN_LENGTH` | 32 | 配置值的长度下限 |

<a id="understand-the-implementation"></a>
## 理解实现

### 优先级与轮换

环境变量优先于文件，因为设置它的人是在明确声明令牌；空值表示"未设置"而非"不认证"，与 Harness home 对待空 `DSH_HOME` 的方式一致。低于长度下限的配置值会直接报错，而不是静默回退——回退意味着用比用户所要求的更弱的东西去认证。过短或不可读的文件会在下一次解析时被替换，这正是"删除文件即轮换"的实现方式。

### 权限

写入时使用 `mode: 0o600`，随后再对路径做一次 chmod，因为 `writeFile` 只在该调用创建文件时应用 mode——否则一个更早、更宽松的文件会保留自己的权限。没有 POSIX 权限位的文件系统按尽力而为处理。

<a id="further-exploration"></a>
## 延伸阅读

- `@deepseek-ai/dsh-client-connection` 用该令牌换取签名的浏览器 cookie；令牌本身除了那个会话之外不授予任何东西。
- 仓库根目录的 `docs/` 描述了本包不得破坏的 Harness 契约。

<a id="model-experience"></a>
## 模型体验

无，因为该令牌只用于浏览器 HTTP 请求的认证，从不进入模型输入；宿主在组装任何请求之前就已完成解析。

#### KV Cache 影响

无；解析该令牌既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **没有 TLS，也没有 `Secure` 属性。** 令牌会随打印 URL 的查询串出现一次，随后变为 `HttpOnly` cookie。把宿主暴露到可信网络之外，预期经由反向代理或虚拟组网。
- **令牌是唯一的认证输入。** 没有第二因素、没有按用户身份、也没有吊销列表；轮换令牌即吊销。

<a id="dev-note"></a>
### 开发备注

#### 覆盖率

`packages/*/*/src` 带有逐文件 100% 的语句、分支与函数门禁。写入路径的 chmod 失败带有 `v8 ignore` 注释：它需要一种无法承载属主专用权限的文件系统。

#### 测试

`tests/access-token.spec.ts` 覆盖长度边界、两个来源、生成及其文件权限、跨调用复用，以及替换并收紧一个宽松文件。每个用例都在私有的临时 home 上运行。
