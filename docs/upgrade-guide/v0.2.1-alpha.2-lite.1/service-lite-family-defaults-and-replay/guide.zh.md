---
kind: upgrade-guide
description: "llm-service-lite 从模型家族表补齐手写模型条目留空的默认值——模态、思考格式、档位与默认档、是否回传思维链——并把 Anthropic 输出上限改为按「配置默认 → 家族上限 → 64K」取值，而不再取模型自己的 maxTokens。"
---

# 模型默认值来自模型家族

[English](guide.md) | 中文

## 变更

本次发布中，`@deepseek-ai/dsh-llm-service-lite` 会用一张经过核对的表（`packages/llm/llm-service-lite/src/model-defaults.ts`，记录主流模型家族官方文档里的参数）补上手写模型条目留空的部分。

档案依然优先：表只填补档案没有声明的字段，因此已有的路由声明的模态、思考开关写法、档位阶梯原样保留；表里没有条目的模型保留适配器此前的保守答案。例如只写 `models: [{ id: deepseek-v4-flash }]` 现在会解析出图片输入、`thinking` 开关、`low`/`high`/`max` 档位与厂商默认档 `high`、以及开启的回传；`claude-opus-5-5` 解析出它官方文档写明的默认档 `medium`。

两处声明带来行为变化：

- 新增 `capabilities.replayReasoning`：决定既往思考是否随下一次请求发回。缺省交给模型家族；后续轮次缺它就被拒绝的家族（DeepSeek V4、Kimi K3 与 K2.7、glm-5.3、qwen3.8-max、MiniMax M2.x、MiMo）会解析为强制回传，并按名拒绝 `replayReasoning: false`。此前已声明 `reasoningContent: true` 的档案继续像以前一样回传。
- 模型自己的 `maxTokens` 现在只是能力，而不再是请求默认：两条 OpenAI 兼容线不再收到调用方没要过的 `max_tokens`；必须发这个字段的 Messages 协议按「调用方自己的值 → `extraBody.max_tokens` → `defaults.maxTokens` → 模型家族上限 → 未匹配家族的 64K」取值。

受影响的部署：依赖 `maxTokens` 决定请求输出上限的 llm-service-lite 路由，或希望采用这些已核对的家族默认值的部署。

## 迁移

1. 需要固定输出上限的路由，请在模型条目上写 `defaults.maxTokens`。`maxTokens` 仍然描述模型能答多长，只是不再自动写进请求。
2. `interfaceType: anthropic-messages` 的路由若未写 `defaults.maxTokens`，现在会发送家族上限（Claude 5 与 Opus 4.6–4.8 为 128K，Opus 4.5／Sonnet 4.5／Haiku 4.5 为 64K，等等），表里没有的模型则为 64K。希望更小的上限时请显式设置 `defaults.maxTokens`。
3. 想停止回传既往思考的路由，可在只声明回传（非强制）的家族上设置 `capabilities.replayReasoning: false`；在强制回传的家族上写入会被按名拒绝，那里保持不声明即可。
4. 其余无需改写：未由家族补值的字段保持适配器原有行为，且表中永不默认任何采样参数。
