# v0.2.1-rc.2-lite.1

本次 dsh-lite 发布保持上游 `0.2.1-rc.2` 包版本线，并通过已发布的覆盖层把两个 snnh 插件加入默认 Web profile。

## 默认 Web profile

- 新 npm 包 `@snnh/dsh-lite@0.2.1-rc.2`：依赖并挂载
  `@snnh/dsh-llm-service-lite@0.1.1` 与 `@snnh/dsh-price-stats@0.2.0` 的 bundle。
- 新建 Web profile 默认初始化为：
  `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@snnh/dsh-lite`。
- `llm-service-lite` 休眠挂载。第三方服务商在 **Plugins → llm-service-lite → Configure** 中配置，或写到 `cordis.patch.yml` 的对应行。
- `price-stats` 默认挂载，包含费用面板、费用胶囊与预算提醒，无需配置。
- 已有 profile 的 bundle 列表不变。要启用时把 `@snnh/dsh-lite` 加入 `dsh.profile.bundles`；迁移步骤见升级指南。

## 性能

本版本还包含已在 `master` 上的 wave-1 内存工作：

- 启动编译与可选模块加载裁剪；
- 有上限的 session-list 条目缓存；
- 宿主级终端缓冲上限；
- 按字节限制的 session-query 冷观察；
- gateway 下行帧大小与写入时间上限；
- 空闲客户端 Session 60 分钟后释放。

## 升级说明

新 bundle 会改变新建 profile 的默认 Web 组合。已有 profile 的迁移与回退见：

- `docs/upgrade-guide/v0.2.1-rc.2/dsh-lite-web-plugins/guide.md`
- `docs/upgrade-guide/v0.2.1-rc.2/dsh-lite-web-plugins/guide.zh.md`

## 验证

- `typecheck`：5/5 门禁
- app-boot profile 测试：40 通过
- CLI profile 初始化/MCP 测试：25 通过
- `test:expected`：20 文件 / 122 通过
- Web 冒烟：新 profile 启动时两个插件的客户端入口都存在，且无重复 factory
