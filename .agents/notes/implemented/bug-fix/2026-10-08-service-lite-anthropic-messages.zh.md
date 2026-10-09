# Agent Note: 本地 LLM 服务现在会说 Anthropic Messages 协议

Status: implemented

[English](2026-10-08-service-lite-anthropic-messages.md) | 中文

## Problem

一个 Anthropic Messages 请求若为同一个 `tool_use` id 回答两次，会被直接拒绝——`each tool_use must have a single result. Found multiple tool_result blocks with id: …`（2026-10-08）。产生这条错误的校验器属于 Messages 协议，而该协议恰恰是本分支自己的服务插件 `dsh-llm-service-lite` 够不到的：对它做探针，在协议边界上暴露出三个缺陷。

其一，`interfaceType: 'anthropic-messages'` 与 `'openai-responses'` 能解析成功，随后却被按 chat-completions 线上协议承载：指向 Anthropic 端点的档案会发出 `POST https://api.anthropic.com/chat/completions` 和一个 OpenAI 形态的请求体，而插件自己的 README 一直声称这些协议在解析时按名拒绝。其二，chat-completions 转换在一条助手回合重复声明某个调用 id 时会声明两次，为同一个 id 发出两条 `tool_calls` 与两条 `tool` 消息——正是严格端点会拒绝的形态。其三，也是最关键的一点：插件根本没有 Messages 传输，连一段配对良好的历史都无法发出，而该校验器要求的那套配对规则（一个 `tool_use` id 一条结果、消息内 id 唯一、结果必须紧跟在其调用之后的回合里）在插件里没有任何地方被保证。

OpenWebCode——本插件移植其 provider 层——早已遇到同一故障，并在自己的 Messages 序列化器里修好了它。它的修复正是本次改动的参照：持久历史在出门时被修正，而不是被拒绝；同一个调用 id 的首条结果胜出，游离结果被丢弃，重复的调用 id 折叠为首次出现，无人回答的调用补一个占位结果，同一并行批次的结果合并进协议要求的单个 user 回合。它还会回放带签名的思考块，因为该端点拒绝没有签名就回传的 thinking 块。

## Decision

插件现在自带 `anthropic-messages` 传输，未实现的协议仍按名拒绝。

**请求组装**（`src/anthropic-messages.ts`）构造线上请求体：提示词取自 `options.system` 或首条 system 消息；`tools` 为每个声明给出 `input_schema`；`max_tokens` 必发，因为该协议强制要求输出上限；`stream: true`；`stop_sequences`；以及所选推理档位对应的写法——effort 档位变成 `output_config.effort`，模型声明的思考模式变成 `thinking` 块，extended 预算会给正文留出空间而不是吃满整个上限。其后出现的 system 或 developer 消息就地折叠为 user 回合，因为该协议没有会话中途的 system 槽位；把它抬到顶部等于悄悄挪动一条指令。`x-api-key` 与 `authorization: Bearer` 同时发出，因此官方 API 与 Anthropic 兼容网关都能解析同一个凭据；`anthropic-version` 始终发送。

**配对修复**就在这套组装里，按参照实现执行：一个调用 id 只留一条结果（首条胜出）、游离结果丢弃、重复调用 id 只声明一次、无人回答的调用补占位结果、一个批次的结果只产出一个 user 回合。持久日志绝不为了满足请求而被改写——修复后的是投影，不是编辑——因此会话始终与记录时一模一样。

**思考回放**走 harness 的适配器私有回放元数据：流翻译为每个块写一条记录（reasoning 记签名或 redacted 载荷），请求路径只对产生它的 provider 与 model 回传这些块。任何不匹配——别的适配器的 kind、别的版本、别的模型、已经对不上内容的信封——都只把那一个回合降级为纯文本，而不是让整个请求失败。

**流翻译**（`src/anthropic-stream.ts`）把 Messages 事件协议翻成 harness 的分块词汇：块身份与顺序、由 `input_json_delta` 分片拼装工具调用、带签名与 redacted 的思考、从两份用量报告合并出的缓存感知用量、把该协议的停止原因映射到 harness 的停止原因，以及"在块中途断掉的流报为传输失败而不是已完成的回合"。

`SERVED_INTERFACE_TYPES` 现在同时列出两种已实现的传输，拒绝面收窄到 `openai-responses`：声明它的档案会在解析阶段失败并给出点名该路由的诊断，而不是被按它读不懂的线协议承载。该拒绝仍在档案自身的矛盾检查之后执行：那些检查说的是"该改什么"，而这个说的是"为什么这条路由根本无法服务"。

## Alternatives considered

**改 harness：在响应被执行之前拒绝工具调用 id 重复的响应。** 否决：那是 `packages/core/agent-loop`，官方 dsh 主线，本分支不打补丁。由此产生的服务端后果记在 Consequences 里。

**给面向 Anthropic 的主线适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）打配对补丁。** 同因否决：两者都是主线包，且 DeepSeek 那个正是本分支明确保持在上游修订上的包。

**只保留拒绝、不实现传输。** 否决：部署方那些 Anthropic 兼容端点将永远够不到，而一个此后无人解除的拒绝不叫修复。按名拒绝是当时正确的过渡状态（它止住了端点读不懂的请求），而传输才让这个协议真正可用。

**继续把任何被声明的协议都按 chat-completions 承载。** 否决：端点收到它读不懂的请求体，故障会以令人困惑的服务商错误形式出现在远离配置的地方。

**把 OpenWebCode 在 OpenAI 兼容路径上的兜底启发式也移植过来**——让没有自己结果的调用去认领一条未被消费的结果。否决：本插件的 chat-completions 转换会声明每个调用，并用它自己的结果或占位结果回答它，这既守住了"一调用一结果"的不变量，也不必把不相关的 id 配到一起；Messages 侧的修复出于同样理由采用同一规则。

## Consequences

声明 `anthropic-messages` 的档案现在能注册并服务。它的端点默认值改为 `https://api.anthropic.com/v1`（版本段属于档案端点，chat-completions 的默认值同样如此）：旧值不可能被任何部署用到，因为当时没有传输能发出请求。`promptCaching` 在这条传输上开始真正生效——它会为 system 提示与最后一条工具声明打断点——而 chat-completions 路由仍然按名拒绝该声明。`includeUsage` 仍只属于 chat-completions，`openai-responses` 仍未实现。

思考文本只在"产生它的 provider 与 model"上跨请求存活；该元数据不可移植，缺口只把该回合规降级为文本，而不是发出端点会拒绝的块。此前对 chat-completions 转换的重复调用 id 修复仍然保留，因为严格的 OpenAI 兼容端点同样拒绝那种形态。本分支上 harness 的主线 LLM 路径依旧未改：重复工具调用 id 的模型响应仍会被循环执行，而两条传输负责让由此产生的历史不会以重复声明的形态到达端点。

## Testing

`packages/llm/llm-service-lite/tests/anthropic-messages.spec.ts` 钉住请求字段（端点、请求头、必需的输出上限、system 提示、缓存断点、工具、推理档位写法）以及每一种配对情形：游离结果被丢弃、重复结果只留首条、重复调用 id 被折叠、无人回答的调用在批次边界与历史末尾各补一次占位、一个批次合并为一个 user 回合、工具结果里的媒体被内联，以及回放元数据只被写出它的 provider 与 model 接受。`packages/llm/llm-service-lite/tests/anthropic-stream.spec.ts` 钉住翻译本身：文本、带签名与 redacted 的思考、工具调用拼装、用量合并、harness 已知的每一种停止原因、畸形事件、在块中途断掉、在块之间断掉，以及空响应。`packages/llm/llm-service-lite/tests/adapter.spec.ts` 通过真实 HTTP 端到端驱动一条 Messages 路由——它的路径、请求头与请求体，以及"结果从未落盘的调用"被修复后的历史——`tests/profiles.spec.ts` 则钉住剩余的拒绝面与两种已实现协议均可解析。
