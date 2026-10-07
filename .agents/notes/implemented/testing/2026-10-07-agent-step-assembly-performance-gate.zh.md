# Agent Note: 每步提示词与工具装配的性能门禁

Status: implemented

[English](2026-10-07-agent-step-assembly-performance-gate.md) | 中文

## Problem

一个 Agent 步骤由一次 `systemPrompt.assemble()` 打开：框架合并作用域链上的 section、变量、动态上下文与工具 provider，对每个 provider 的工具参数做深克隆，排序工具目录，再跑一遍 `system-prompt/assemble` waterfall。tools 注册表则在每次读取时重建整个作用域视图——装配自身的 provider 重建一次，而每个"工具可见才渲染"的插件 section（`tool-fs`、`file-reference-local` 等用于只对存在的工具渲染指引的模式）在文本里调用 `ctx.tools.get(name, scope)` 时又各重建一次。

一条 CPU 工作流原计划对其中两处读取做记忆化——工具 schema 投影与提示词装配——但完全没有这条每步路径的测量。它自己的证据缺口明确写着收益"取决于每步携带多少工具与 section"，而现有基准都没有给这条路径定价：[memory-posture](2026-10-06-memory-posture-performance-gate.zh.md) 测的是启动后的常驻集与空闲 CPU，[session-open](2026-09-04-session-open-performance-gate.zh.md) 测会话准备与恢复，`agent-continuation` 测整段请求/工具续跑。没有数字，这两处记忆化可能被设计、评审并合入，只为一份用户根本感知不到的 CPU；或者被跳过，而真正的热点留在原地。

## Decision

必需的基准流水线运行 `benchmarks/agent-step/agent-step.bench.ts`。现有的 `test:bench` 命令会构建它：`benchmarks/tsdown.config.ts` 新增一个条目，把 `agent-step.worker.ts` 编译进 `benchmarks/.dsh-build/agent-step/`，与工作区库和该流水线已有的其它编译 worker 并列。[Session-opening 性能门禁](2026-09-04-session-open-performance-gate.zh.md) 拥有这条流水线、它的 `node 24 / benchmarks` job 与外层 job 超时；本次改动是给该流水线增加一条被测路径，而不是新增一个 job。

### The measured subject

被测主体是普通 Node 子进程里的构建产物装配路径：编译后的 `agent-step.worker.ts` 从 `lib/` 入口挂载真实的 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools` 包——与发行 profile 挂载它们的方式完全一致——然后计时 `agent-loop` 每步调用一次的 `systemPrompt.assemble()`。

真实的部分：两个注册表、作用域上下文机制（`createScope`），以及生产在 Agent 作用域上安装的三种 `system-prompt/assemble` listener 形态——记录装配路由的 prepend 观察者（[`session-reference`](../../../../packages/context/session-reference/src/index.ts)）、写入 provider 与 model 的变量覆盖（[`model-selection`](../../../../packages/core/agent/src/model-selection.ts)）、按 agent 丢弃某个 section 的过滤器（[`browser-use-runtime`](../../../../packages/experimental/browser-use-runtime/src/mcp.ts)）。若某个 listener 没有对每一次被测装配生效，场景会直接报错而不是照常出报告：一个悄悄停止派发 listener 的组合测的是错误的路径。

合成的是**工作负载**，取自 [agent-step.constants.ts](../../../../benchmarks/agent-step/agent-step.constants.ts) 里的受评审常量：工具集（通过生产用 `defineTool` helper 注册，参数形状、嵌套对象、数组与描述长度固定）、提示词 section（静态文本 + 调用 `ctx.tools.get()` 的工具门控 section）、提示词变量与动态上下文。规模对齐发行 `standard` preset——16 个工具包、约两打模型可见工具——并且有意取在其上：主组合是 24 个工具、40 个 section、其中 15 个工具门控，而该 preset 的插件只注册了少量工具门控 section。

每个场景都在自己的全新子进程里构建自己的 `Context`，因此一个样本不会与其它场景或先前样本共享注册表、缓存或 JIT 状态。六十次被测装配之前有十次预热装配，父进程按中位数判定。worker 报告原始样本、分位数、每次装配的进程 CPU、序列化后的 schema 字节与装配后的 section 字节，使判定无需重跑即可解释。

### The budget

只有主场景进门禁；梯度场景只报告，除"是一次可用测量"外不做断言。

| 预算 | 上限 | 判定聚合 | 采样 |
|---|---|---|---|
| 主场景每步装配 | 2 ms | 中位数 | 一个全新子进程，10 次预热后的 60 次装配 |

上限是 `agent-step.constants.ts` 里的受评审源码常量，不允许环境变量覆盖，这是[基准树规则](../../../../benchmarks/AGENTS.md)的要求。它是回归绊线而非性能目标：实测参考中位数是 0.48 ms，上限约是四倍包络——宽到容得下 CI 机器抖动，紧到能拒绝"开始按 section 或按工具重建输入"的路径。

### Reference run and attribution

在开发机（x64 Linux、Node v24.18.0、已构建工作区）上整文件的一次运行：

| 场景 | 工具 | section | 其中工具门控 | 中位数 | p10–p90 |
|---|---:|---:|---:|---:|---:|
| `bare` | 0 | 0 | 0 | 0.016 ms | 0.015–0.017 ms |
| `gated-0` | 24 | 40 | 0 | 0.196 ms | 0.192–0.224 ms |
| **`primary`** | **24** | **40** | **15** | **0.480 ms** | **0.456–0.620 ms** |
| `gated-30` | 24 | 40 | 30 | 0.661 ms | 0.648–0.812 ms |
| `tools-8` | 8 | 40 | 15 | 0.334 ms | 0.312–0.466 ms |
| `tools-48` | 48 | 40 | 15 | 0.689 ms | 0.656–0.900 ms |
| `sections-16` | 24 | 16 | 6 | 0.299 ms | 0.287–0.334 ms |
| `sections-64` | 24 | 64 | 24 | 0.604 ms | 0.571–0.723 ms |

梯度把成本归因如下：

- **工具门控 section 占主导。** 15 个这样的 section 给主装配加上 0.28 ms——总量的 59%——每个 16–19 µs，因为每次 `ctx.tools.get()` 都重建作用域的工具视图。30 个则在 `gated-0` 之上加了 0.47 ms；`sections-16`/`sections-64` 一对只按门控差额移动。
- **静态 section 免费。** 两个 section 场景相差 48 个 section *以及*其中 18 个门控（0.31 ms）；那 48 个静态 section 的贡献测不出来。
- **工具数每多一个约 8.9 µs**（provider 的重建，加上每次门控读取多复制的条目），其下还压着每个 provider 参数的 `structuredClone`。

同一子进程的 CPU profile 与之吻合：自时间集中在 `structuredClone`（样本中 12.3 ms）、tools `view()` 重建（4.9 ms）与每个 section 访问 `ctx.tools` 所经过的 Cordis 服务代理 `get`（4.0 ms），垃圾回收（7.8 ms）由这三者制造的分配驱动。

**这次测量关闭了原计划的两处记忆化，并记录在此以免重复分析。** 每步 0.48 ms——若组合接近发行 `standard` preset 而非这个有意更重的主场景，则约 0.2–0.3 ms——绝对收益远低于任何用户可感知的阈值：一百步的会话相对以秒计的模型延迟只省下几十毫秒。按原形态缓存整体装配也并不可靠：生产 listener 读取环境可变状态（按 agent 的路由选择、浏览器客户端状态），而装配上下文里没有任何 generation 可作键，要做得正确就需要新增插件可见的声明。

## Consequences

- 每步装配路径首次被门禁定价。任何"开始按 section 重建工具视图、多克隆一次 schema、或逐步求值 section"的改动都会触发主预算，且梯度报告会指出是哪个维度在动。
- 产品代码零改动。CPU 工作流原计划的两处记忆化（工具 schema 记忆化；带键的装配缓存）据此证据被否决，而不是未经测量地搁置；如果未来某种负载让每步 CPU 变得重要——大得多的工具目录、亚秒级步骤、或单主机跑很多 agent——候选已被记录：`tools.get()` 的视图重建（每次约 16–19 µs，且是其它插件也会调用的公开 API）与逐 provider 的 `structuredClone`。
- 基准自身的成本很小：整文件在开发机上不到一秒跑完，不会明显拉长流水线。

## Alternatives considered

- **先做工具 schema 投影记忆化（工作流的 B2）。** 否决它作为起手式：测量显示占主导的是工具门控的视图重建而非 schema 投影，而且两者都只有在绝对收益重要时才值得做——在这个规模上并不重要。梯度矩阵保留了归因，若该判断被重新审视即可复用。
- **缓存整体提示词装配（工作流的 B3）。** 否决：没有新增声明它在语义上不成立。生产 `system-prompt/assemble` listener 读取环境可变状态，而 `AssembleContext` 只携带作用域、可选 signal 与插件自定义字段——没有任何内容 generation 可作键；而"只要有 listener 注册就不缓存"会在每一个发行组合里把它关掉（每个 agent 都装了三个 listener）。
- **扩展 `benchmarks/agent-continuation` 加一个每步场景，而不是新建目录。** 否决：装配耗时会淹没在模型与持久化时间里，而用于归因的规模梯度需要一个基准自己拥有的组合。
- **测整个 `agent/pre-step` 而不是 `assemble()`。** 否决为第一刀：那会把渲染、上下文投影与第二个 waterfall 加进来，让判定变成对一个混合体的判定，而计划中的优化针对的是装配本身。步骤的其余部分仍未定价（见排除项）。

## Deliberate exclusions

- 进程级姿态——常驻集与空闲 CPU——仍归 [memory-posture](2026-10-06-memory-posture-performance-gate.zh.md)；这条门禁计时的是工作，不是姿态。
- `assemble()` 之外的步骤其余部分——上下文 section 渲染、运行时上下文投影、`agent/pre-step` waterfall、请求头比较与会话持久化——不在此测量。若未来发现这些占主导，需要的是它自己的场景，而不是把预算放宽。
- 浏览器与桌面面，以及任何真实 provider：被测路径仅为 Host 侧装配。
- 发行工具 schema 的精确体积：合成 schema 是固定的受评审形状，不是任何 preset 的录制；worker 会报告由此得到的字节总量，因此合成规模的漂移在每份报告里都可见。
