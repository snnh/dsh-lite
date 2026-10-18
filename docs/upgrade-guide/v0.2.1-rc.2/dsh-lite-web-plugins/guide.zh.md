---
kind: upgrade-guide
description: "dsh-lite Web profile 现在默认包含 @snnh/dsh-lite 覆盖层，挂载 llm-service-lite 与 price-stats 两个插件。"
---

# dsh-lite Web profile 插件

[English](guide.md) | 中文

## 变更

新建的 Web profile 会额外初始化一个 bundle：`@snnh/dsh-lite`。该覆盖层依赖并挂载两个社区插件：

- `@snnh/dsh-llm-service-lite`：第三方 LLM 适配器。它休眠挂载，在 profile 声明服务商档案之前不注册任何路由。
- `@snnh/dsh-price-stats`：会话费用面板、费用胶囊与预算提醒。

已有 profile 的 bundle 列表不会自动变化。新 bundle 已作为 harness 的依赖安装，因此 profile 只需把它加入自己的列表，不需要再装一次包。

第一方的 `deepseek-official` 与 `deepseek-account` 路由名仍归内置 DeepSeek 适配器所有，覆盖层不会替换它们。

## 迁移

1. 已有 Web profile 要启用覆盖层时，在 profile 的 `package.json` 中把它加入 `dsh.profile.bundles`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@snnh/dsh-lite"
         ]
       }
     }
   }
   ```

   从模板重新初始化 shipped profile 也会加入它。重新初始化会替换整个 profile 目录，请先备份本地 patch 文件与会话。

2. 重启 profile。Plugins 页会列出两个插件 bundle。第三方服务商在 **Plugins → llm-service-lite → Configure** 中配置，或把 `providers` 字典写到 `cordis.patch.yml` 的对应行。

3. `price-stats` 无需配置，设置位于 **Settings → price stats**。
