---
kind: upgrade-guide
description: "新建的 dsh-lite Web profile 现在直接挂载 llm-service-lite 与 price-stats 两个插件 bundle。"
---

# dsh-lite Web profile 插件

[English](guide.md) | 中文

## 变更

新建的 Web profile 会额外初始化两个 bundle：

- `@snnh/dsh-llm-service-lite`：第三方 LLM 适配器。它休眠挂载，在 profile 声明服务商档案之前不注册任何路由。
- `@snnh/dsh-price-stats`：会话费用面板、费用胶囊与预算提醒。

两个包都是发布在 npm 上的普通 bundle，并作为 harness 的依赖安装；profile 只需列出它们，不需要再装一次包。`@snnh/dsh-lite` 覆盖层不属于本版本，也不会出现在默认 profile 中。

已有 profile 的 bundle 列表不会自动变化。第一方的 `deepseek-official` 与 `deepseek-account` 路由名仍归内置 DeepSeek 适配器所有。

## 迁移

1. 已有 Web profile 要启用插件时，在 profile 的 `package.json` 中把两个 bundle 加入 `dsh.profile.bundles`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "@snnh/dsh-llm-service-lite",
           "@snnh/dsh-price-stats"
         ]
       }
     }
   }
   ```

   从模板重新初始化 shipped profile 也会加入它们。重新初始化会替换整个 profile 目录，请先备份本地 patch 文件与会话。

2. 重启 profile。Plugins 页会列出两个插件 bundle。第三方服务商在 **Plugins → llm-service-lite → Configure** 中配置，或把 `providers` 字典写到 `cordis.patch.yml` 的对应行。

3. `price-stats` 无需配置，设置位于 **Settings → price stats**。

回退时从 `dsh.profile.bundles` 中移除这两个 bundle 并重启。它们插入的插件行会随层消失，已有会话数据不会被删除。
