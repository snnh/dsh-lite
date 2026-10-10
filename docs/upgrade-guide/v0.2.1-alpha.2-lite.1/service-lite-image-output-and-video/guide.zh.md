---
kind: upgrade-guide
description: "llm-service-lite serves the image-output and video declarations it used to refuse, and its provider profiles accept an official catalog, an optional interfaceType, and per-model request defaults."
---

# 模型路由承载图片输出，视频以文件抵达

[English](guide.md) | 中文

## 变更

本次发布中，`@deepseek-ai/dsh-llm-service-lite` 不再拒绝它过去在解析期拒绝的两条声明。

`capabilities.imageOutput: true` 现在可以解析并被服务。声明该能力的模型可以用图片作答：端点返回的内联图片经附件提供方落盘，并以可持久化的图片块重新发布，因此会话持有的是引用而不是 base64。未声明该能力的模型若返回图片，请求会按名失败；而该声明在 `interfaceType: anthropic-messages` 上仍被拒绝——那条协议的助手回合没有图片部件——拒绝信息会明确说明这一点。

`video` 输入模态现在可以解析，并以文件承载：一次视频出现以任何文件附件都会贡献的句柄文本抵达模型。它**不会**以活动画面抵达模型——现有线协议都没有视频部件，harness 也还没有视频内容块，因此该声明表示这条路由接受视频文件。

随之而来的还有两项新增能力。服务商档案现在可以点名 `catalog`——官方服务商文件的路径，或它解析后的内容——其模型、端点、请求头、协议与采样设置会被转换成本档案自己的词汇；当目录提供了协议时，可以省略 `interfaceType`，而两者都没有的档案会被拒绝，并在信息中同时给出两条补救路径。模型条目现在可以声明 `defaults`（`temperature`、`topP`、`topK`、`maxTokens`），每个值只在调用方未给值时写出。

本变更面向的部署是：在 llm-service-lite 路由上声明过 `imageOutput` 或 `video` 模态的部署，以及希望采用官方服务商文件的部署。

## 迁移

1. 过去声明了 `imageOutput: true` 或 `modalities` 含 `video` 的已存档案，会被保留为可寻址但带着诊断、并不服务任何请求。本次改动后它会正常解析并服务。请确认它确实是你想要的行为：图片输出需要挂载附件提供方（`@deepseek-ai/dsh-attachment-local` 或其他），视频输入意味着模型读到的是文件句柄而不是画面。无需改写任何内容。
2. 在 `interfaceType: anthropic-messages` 上声明 `imageOutput: true` 的档案仍然不可服务；诊断信息现在写作 `that protocol has no assistant image part`。请删去该声明，或把这条路由移到两条 OpenAI 兼容协议之一。
3. 希望采用官方服务商文件的部署，现在把 `catalog` 指向该文件即可让插件转换它：`models` 可以省略（目录中的模型照常生效），转换承载不了的字段会在宿主日志中按损失报告一次。未声明该字段的档案不受影响。
4. 两条能力都没声明的档案无需任何操作。既有路由、凭据、图片输入与 token 计价全部照旧工作。
