# 发布说明 — 0.2.1-alpha.1-lite.1

[English](RELEASE_NOTES.md) | 中文

DeepSeek Harness 的 `dsh-lite` fork 的首个版本。它在上游 `0.2.1-alpha.1` 之上承载本仓库的内存、网络暴露与性能工作——共 72 个提交。`packages/` 与 `apps/` 下全部 325 个发布成员共享这一个版本号；发布 tag 为 `dsh-v0.2.1-alpha.1-lite.1`。既有安装升级后的行为变更，以[升级指南](docs/upgrade-guide/)为准。

## 内存与长跑稳定性

- **每次 `dsh` profile 启动都运行常驻集策略**（`@deepseek-ai/dsh-memory`）。它在没有 `--expose-gc` 的构建里也能拿到回收器，启动 10 s 后回收一次，之后仅在常驻集超过 256 MB 且距上次回收不短于 300 s 时回收。空闲的已构建 Web profile 常驻 147–153 MB，此前为 243–254 MB。六个 `DSH_GC_*` 变量可调参，`DSH_GC=0` 关闭（[指南](docs/upgrade-guide/v0.2.1-alpha.1/memory-policy/guide.zh.md)）。
- **闲置的客户端 Session 实例在 60 分钟后释放**（[指南](docs/upgrade-guide/v0.2.0-rc.2/session-idle-eviction/guide.zh.md)）。
- **所有原本无上限增长的缓存都有预算**：会话投影缓存保留 5000 行 / 64 MiB 并在归档时清空，session-query 的冷观测缓存按字节数与空闲租约设限，workspace 会忘记已归档的 Session，会话列表条目缓存改为 LRU。
- **点读可直接取回单条存储记录**——`KvUnit.readRecord`/`readGlobal`——领域也可声明 `residency: 'lazy'`，使 `open` 不物化任何内容。`session_projcache` 就是该领域，因此投影缓存的读取面改为异步，同一个 Session 的第一次列表读取比第二次慢（[指南](docs/upgrade-guide/v0.2.0-rc.2/lazy-domain-residency/guide.zh.md)）。
- **缓冲字节数设上限**：终端输出按会话设限并随会话释放；gateway 限制下行帧大小与停滞时间，并为落后的客户端提供 opt-in 的下行重同步。

## 网络暴露与认证

- **Web profile 默认发布全部 IPv4 网卡**，它是 `lan-access` 行的 schema 默认值，而不是任何一次启动写入的行。`--host`、组合后的行配置，以及通用设置页里"重启生效"的监听地址行都可以收窄它；绑定前由同一套语法校验主机名。
- **非回环绑定要求持久访问令牌**，位于 `$DSH_HOME/access-token`（`0600`，可用 `DSH_ACCESS_TOKEN` 覆盖）；拿不到令牌的主机会让启动失败，而不是无认证地监听。绑定会通过 logger 与 console 各写一条暴露警告，因为 Web exporter 会过滤 `warn`（[指南](docs/upgrade-guide/v0.2.0-rc.2/web-lan-exposure/guide.zh.md)）。

## 性能与启动

- CLI 自身模块使用 Node 编译缓存；重量级可选依赖首次使用时才加载；遍历目录列表改为有界并发；不透明标识符按码元排序而非 ICU 排序；客户端产物在组合已构建时复用；文件系统监听只有一套 Chokidar 生命周期；Session 句柄不再钉住已解析的历史。

## 门禁

- `benchmarks/memory-posture` 对已构建宿主设限：空闲常驻集、每 Session 增长量、空闲 CPU。
- `benchmarks/agent-step` 为每步提示词与工具装配定价（基于已构建注册表）：24 个工具、40 个节的场景下每步 0.48 ms，预算为 2 ms 中位数。

## 修复

- `office-to-pdf` 每个 provider 生命周期只导入一次 kit，并在模块加载被拒后重试；JSONL 持久化只保留已准备的读取视图，并再次提供已准备的历史代；文件系统监听接受使用方自己的 Chokidar 主版本；Web 地址行给出服务器实际绑定的 URL；若干 e2e 与 golden 期望值跟随当前输出与配置目录。

## 升级

1. 先读上面链接的四份指南；每份都列出要改的确切文件、键、命令或符号，以及如何确认。
2. 其余无需动作：上游 `0.2.1-alpha.1` 的 CLI 参数、profile 名称、`cordis.yml` 键与已存储的 Session 数据继续可用。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm run test:expected` | 19 个文件、109 个用例通过 |
| `pnpm run test:e2e` | 51 个文件通过、42 个跳过；183 个用例通过、113 个跳过、0 失败 |
| `pnpm run test:snapshot` | 4 个文件、181 个用例通过、2 个跳过 |
| `pnpm exec tsx scripts/release/verify.ts --family dsh` | 325 个成员、同一版本 `0.2.1-alpha.1-lite.1`、发布顺序可解 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-quick` | 干净 |
