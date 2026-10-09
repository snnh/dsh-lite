# Agent Note: 本地 LLM 服务现在会说 OpenAI Responses API

Status: implemented

[English](2026-10-09-service-lite-responses-transport.md) | 中文

## Problem

上一篇 note 把 `openai-responses` 留在了"按名拒绝"的状态：插件能说出部署方配置了什么，却无法承载它。那是当时诚实的过渡状态——把 chat-completions 的请求体发给 `/responses` 端点比一次点名的拒绝更糟——但它不是修复，而它挡住的这项能力，正是 OpenAI 与若干网关如今对外提供的：一张扁平的 item 清单而不是按角色排列的对话、`function_call`/`function_call_output` 成对而不是 `tool_calls`、必须排在其所属消息之前的 reasoning item、`instructions` 而不是 system 角色，以及无状态请求理应原样交回的逐 item 身份（`msg_`/`rs_`/`fc_`）。

本插件移植其 provider 层的 OpenWebCode 早已有这条传输，并且它记录了两个朴素移植会重演的故障。其一，调用与结果数量配错的输入清单会被拒绝；他们的映射保证一个调用只配一条结果，其余丢弃。其二，没有输出的 `function_call` 会被直接拒绝，而伪造的输出会被严格的网关拒绝——这正是他们的 Responses 路径丢弃"无人回答的调用"、而不是补一个占位结果的原因，与 Messages 路径必须做的恰好相反。

## Decision

插件自带 `openai-responses` 传输，移植自 OpenWebCode 并适配本适配器的声明规则。

**请求组装与输入映射**（`src/openai-responses.ts`）。提示词变成 `instructions`（取自请求自身，否则取自首条 system 消息）；其后出现的 system 或 developer 消息就地折叠为一个 user item。工具按本协议的扁平 `{ type: 'function', name, description, parameters }` 形态发送。`max_output_tokens` 必发，并抬到该 API 的下限 16。推理只在**调用方选了 effort 时**才写成 `reasoning.effort` 加 `summary: 'auto'`——本协议没有"打开思考"的开关写法，因此仅选模式时什么都不发、由端点自身默认决定——而关闭思考对"档案声明了可拼写开关"的模型可用 `effort: 'none'` 表达。采样只在没有推理 effort 时发送，因为该 API 拒绝与推理并存的 temperature。`include: ['reasoning.encrypted_content']` 恰好在模型声明 `responsesEncryptedReplay` 且本次请求了推理时才索要。

**修复。** item 清单在出门时被修正，与其他传输修正各自清单的方式一致：同一个调用 id 的首条结果胜出、游离结果被丢弃、重复声明的调用 id 折叠为首次出现、一个回合内的并行调用被归组——先是全部 `function_call`，再是全部 `function_call_output`——因为该 API 会把连续的 item 折叠进它们所属的助手回合，交错成对会把一个批次拆成好几个回合。有一处差异是刻意的：无人回答的调用被**丢弃**，而不是补占位结果，因为该 API 会校验每个调用都有输出，且严格的网关会拒绝伪造的输出。结果携带的媒体无法放进 `function_call_output`，因此它在批次之后作为一条合成的 user item 跟随。

**推理回放。** 两种形态，各自以一项声明为闸门：`reasoningContent` 把思考文本按 `reasoning_text` 部分回带（无需元数据——本协议接受纯文本），`responsesEncryptedReplay` 则把服务商自己的 reasoning item 原样交回，含 id 与加密载荷。item 身份（`msg_`/`rs_`/`fc_`）走同一份适配器私有信封，并随其所属 item 一起交回。本构建用不了的信封——别的适配器的、别的版本的、已经与内容对不上的——只把该回合降级为纯文本并失去身份，绝不动内容。

**流翻译**（`src/responses-stream.ts`）。增量打开块，逐个收尾的权威 item 补齐增量漏掉的部分，而只发终态事件、完全不流式的端点则直接从该事件的 output 写出。用量按本 API 的报法拆分：提示词总量里内含缓存命中与缓存写入的计数，因此减去它们才得到 harness 要求的"未命中输入"计数。状态映射到 harness 的停止原因；在终态事件之前被截断的流、或结束时未声明结果的流，是传输失败而不是完成的回合。

**每个被声明的协议现在都有传输。** `SERVED_INTERFACE_TYPES` 与词汇表同名同一集合，运行期拒绝被移除，传输表按这些名字定型：往词汇表里加一个协议却不加它的传输，会直接编译失败，而不会以"拒绝"的形态到达部署方。

## Alternatives considered

**继续拒绝 `openai-responses`。** 否决：词汇表条目已存在、参照实现已存在，而一个此后无人解除的拒绝只会让那个端点永远够不到。

**把 Responses 档案按 chat-completions 或 Messages 的线协议承载。** 否决：那些请求体携带的是按角色排列的对话与为各自协议塑形的工具结果，端点两者都读不懂。

**像 Messages 与 chat-completions 路径那样，给无人回答的调用补占位输出。** 本协议上否决：该 API 会校验每个调用都有输出，且参照实现记录了严格网关会拒绝伪造的输出。丢弃调用让请求保持合法；两种做法下持久日志都照样保留那个调用与它缺失的结果。

**移植参照实现的"尾部占位 reasoning item"**（当输入以一条没有推理的助手回合结尾时伪造一个 `reasoning` item）。不移植：它为满足某个端点特有的要求而写入会话从未有过的、模型可见的内容，而本适配器只发送档案声明过的东西。端点自己的报错才是诚实的回答，档案也可以声明 `reasoningContent` 来让真实的推理被回带。

**承载该协议的服务端工具与在线存储的响应。** 不承载：本缝没有服务端工具调用的词汇，而无状态会话把状态保存在持久日志里，因此不发送 `store` 字段，`web_search_call` item 被忽略，而不是被翻译成 harness 无法回放的块。

## Consequences

声明 `openai-responses` 的档案现在能注册并服务；`responsesEncryptedReplay` 被履行而不再被拒绝；`video` 输入与 `imageOutput` 仍被拒绝。这条路由上，调用方的 `stop` 序列被省略，因为该协议没有这个字段。推理只在"产生它的 provider 与 model"上、且只在已声明的形态下跨请求存活；外来信封只损失身份、保住文本。既未声明 `reasoningContent` 也未声明 `responsesEncryptedReplay` 的路由完全不回放推理——这正是那两项声明的含义。

三条传输如今共享同一副骨架——组装、修复、翻译、信封——因此下一个协议是"一条传输加它自己的修复"，而不是一套新架构。官方 dsh 主线未有任何改动：整个改动面都属于本分支的插件。

## Testing

`packages/llm/llm-service-lite/tests/openai-responses.spec.ts` 钉住请求（端点、Bearer 认证、必发的流式开关、输出上限下限、推理旁的采样、`instructions`、扁平工具、推理的各种写法、加密 `include`、extraBody 分层）与映射（user item、被折叠的 system 与 developer 消息、图片与已卸载的图片、游离结果被丢弃、无人回答的调用被丢弃、重复调用 id 被折叠、并行调用归组、媒体合成，以及每一种回放降级）。`packages/llm/llm-service-lite/tests/responses-stream.spec.ts` 钉住翻译本身：带权威后缀的流式文本、与增量不一致的收尾 item、带签名与纯文本的推理、工具调用拼装、从"从未流式"的端点终态写出 item、哨兵收尾、每一种状态映射、用量拆分、畸形用量、被截断的流、空响应与无结果收尾。`packages/llm/llm-service-lite/tests/adapter.spec.ts` 通过真实 HTTP 端到端驱动一条 Responses 路由——路径、请求头、请求体、无人回答的调用被修复后的历史，以及运行期落盘的回放信封——`tests/profiles.spec.ts` 则钉住每个词汇表条目都能解析。
