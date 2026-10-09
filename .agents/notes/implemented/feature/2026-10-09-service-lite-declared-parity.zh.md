# Agent Note：本地 LLM 服务声明第一方通道所声明的能力

Status: implemented

[English](2026-10-09-service-lite-declared-parity.md) | 中文

## Problem

把本插件放进 base bundle 的那篇 note 说过：第一方通道保持第一方，本适配器服务的是部署自行描述的端点。就它自己掌管的请求路径而言这是真的，就 harness 读取的 seam 元数据而言则不是。第一方 DeepSeek 目录声明了两项本适配器词汇表里根本没有词的能力——`systemPromptUpdate: 'in-history'` 与 `toolUpdate: 'addition-only' | 'in-history'`——于是同一个模型，通过档案走本适配器与走第一方通道会得到两种不同形态的对话：`projectToolUpdates` 读不到任何已声明的模式，每回合重述完整提示词与完整工具列表，会话中途的 system 快照与被推迟的工具无处安放。

同一处缺口还有第二笔代价。`LlmAdapter.imageRequestPricing` 未实现，于是 token meter 对每张图片都退回自己的结构化启发式：会话面上的一张照片，按代表它的那份 JSON 引用计价——几十个 token——而端点实际收取的是数百到数千个视觉 token。上下文压力恰好在最快填满窗口的会话里被低报，而且直到某个回合因请求过长失败之前，这个差异都不可见。

## Decision

三项声明，各自被读取它的代码履行，并在无法被读取的地方被拒绝。

**`systemPromptUpdate: 'in-history'` 与 `toolUpdate: 'addition-only' | 'in-history'`** 以 harness 自己的拼写加入模型能力词汇表，且只在档案声明它们时才被带到 `LlmResolvedModelInfo` 上。声明 `toolUpdate` 正是让循环把 `tool-addition` 与 `tool-removal` 块交给这条路由、而不是重述声明列表的依据；被推迟工具的声明随之带上 `defer_loading`，Messages 传输按本协议的拼写发出它。两项声明在 `openai-chat-completions` 与 `openai-responses` 上都被拒绝：那两条线每回合重述提示词与工具，也没有可供读取的中途部件，接受声明等于往文档里写一条没有任何请求会执行的能力——与 `promptCaching`、`includeUsage` 已有的规则一致。

**Messages 传输现在有了承载这类变更的线上形态。** 在声明了任一能力的路由上，developer 或 system 消息不再折叠进 user 回合，而是成为一条携带提示词快照与工具引用的 `system` 角色历史消息。它会等到它前面是 user 回合才落位，并插在该回合与助手回答之间，因为本协议把 `system` 消息读作回合之间的指令；本会落在更早位置的变更会让请求以 `UNSUPPORTED_CONTENT` 失败并写明原因，而不是被搬走或丢弃。两项都没声明的路由保持原有折叠规则，在其它角色上遇到未知块仍然跳过。

**`imageTokens` 声明端点自己的视觉 token 计价**，采用两种公开拼写：扁平像素网格用 `{ kind: 'area', per: 750 }`，底价加逐方形瓦片计价用 `{ kind: 'tiles', tile, base, perTile }`。`LlmAdapter.imageRequestPricing` 按 `requestImageTarget` 将向附件提供方索取的尺寸——决定端点收费的那一个数字——为每次出现计价；已卸载的出现按请求实际携带的占位文本计价；纯文本路由按运行时执行的替换计价。未声明计价的路由回答 `undefined`，把 meter 自己标注为启发式的估算留在原地：本适配器猜出来的数字会被下游读成一次测量。

**那条渠道拥有的路由名在此处被拒绝。** DeepSeek 保留它的官方模块，因此 `deepseek-official` 与 `deepseek-account`——分别由 `@deepseek-ai/dsh-llm-deepseek-api-key` 与 `@deepseek-ai/dsh-llm-deepseek-account` 注册——在被档案占用时按名拒绝，诊断中写明归属方。已存储且占用其一名的档案保持可寻址、但不可服务，而不会把其它路由一起拖下水；何况真去注册它本就会让插件加载失败：关键在于就地指出这处错误，而不是让它看起来像本插件的 bug。被保留的只是名字，不是服务商——若某部署要通过本适配器接入一个兼容 DeepSeek 的端点，就用自己的路由名，并声明该端点自己的能力。

有三件事是刻意**不**从第一方通道照搬的，README 已逐条写明：中途工具变更所需的 DeepSeek beta 头不会被注入（需要它的档案在 `headers` 里自己写明，因为该头是端点的契约，不是本适配器的知识）；图片字节旁不写任何说明文本（因此被计价的出现次数只计入端点实际收取的部分）；DeepSeek 平台专有能力——Files API 图片通道、账户授权路由、`ctx.deepseekLlmApiExtensions` 请求字段注册表、`x-deepseek-harness-*` 身份头——不进这个以\"档案即全部真相\"为前提的插件。

## Alternatives considered

**继续重述提示词与工具列表。** 否决：这正是本次变更要消除的行为。在已声明能力端点上跑长会话，会为一份根本没变的清单每回合付一次缓存未命中，而 harness 早已知道如何表达这次变更。

**自动注入中途工具变更的 beta 头。** 否决：beta 名是端点的，而本适配器面向任意端点。把某个服务商的私有头写进每个请求，就是把第一方知识塞进第三方路径；需要它的部署可以自己写明。

**在档案未声明时猜一个图片计价。** 否决：这个数字在下游将与实测数字无法区分。未声明的计价保留 meter 自己标注为启发式的估算。

**照搬 DeepSeek 平台特性，让本插件能完全顶替第一方通道。** 否决：会话日志上传、账户授权路由、请求字段扩展都是 DeepSeek 平台契约，不是 LLM seam 能力。实现它们不会让本适配器更可移植，只会让它成为同一栈的第二个副本，只是换了个名字。

## Consequences

声明了 `toolUpdate` 的档案现在会收到 developer 消息与被推迟的声明，因此会话中途的变更以\"变更\"出行，而不是重写整个前缀；声明了 `systemPromptUpdate` 的路由上的中途 system 快照同理。两项都没声明的部署，看到的请求与之前逐字节相同。

`imageTokens` 让声明了它的路由上，上下文压力与图片计价变得可见；调用完成后，harness 自己的用量报告仍是权威，所以该声明只影响估算。

代价是 Messages 传输多出第二种线上形态、多出两条可被拒绝的声明，以及某个档案可能对根本不读中途部件的端点声明该能力的风险。这种失败是响亮的——端点拒绝 `system` 消息，或 beta 缺失——而且诊断会指明这是一处配置错误，这也正是这些声明按模型可选、而不是按协议默认假设的原因。

本次变更的验证：包内 230 项测试通过；逐文件覆盖率相对改动前基线无新增缺口（`anthropic-messages.ts`、`config.ts`、`images.ts` 为 100%，`profiles.ts` 保持原有的 14 处未覆盖）；`tsc -b tsconfig.host.json`、oxlint、doc-quick 与 golden 回放套件均通过。
