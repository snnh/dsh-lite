# Agent Note: The local LLM service converts official catalogs, carries image output, and states per-model defaults

Status: implemented

[English](2026-10-10-service-lite-official-catalogs-and-image-output.md) | 中文

## Problem

`dsh-llm-service-lite` 的存在意义是适配任何已安装目录都描述不了的端点，而一个有真实服务商的部署会立刻撞上它四处缺口（2026-10-10）。

第一，官方发行版早已为每个服务商发布一个模型配置文件——以 API 为键、条目为 `chat:<id>` 的映射，里面有端点、容量、输入模态与思考档位。这些文件根本读不进来：采用一份官方文件意味着把每个模型重新誊写成本适配器自己的词汇，而配置文件的存在正是为了避免这种誊写。

第二，`imageOutput` 与 `video` 是"声明了就会在解析期被拒绝"的能力。在没有传输承载它们时，这个拒绝是诚实的；但一旦某条线能承载图片，本适配器自己的规则——无人执行的声明会被读成路由并不具备的能力——就翻转了方向：会产图端点的档案无法声明这件事，而没声明的路由即使收到图片也只会把它丢掉。

第三，模型的采样设置无处安放。`extraBody` 是路由级的，还要过保留键检查，因此同一个网关上想要不同温度的两个模型无法同时描述，档案也无法声明"调用方没说时这个端点希望用什么"。

第四，这些能力周围的文本已经和代码脱节：模型设置页告诉用户本适配器"只承载文本"，而它其实早就承载图片；README 说两条传输而实际服务三条；一处文档默认值写的是适配器从未使用的数值；文档里四个图像预算字段在接收它们的 schema 里根本不存在。

## Decision

**官方文件转换成本适配器自己的档案。** 档案可以带 `catalog`——路径或解析后的内容——由 `src/official-catalog.ts` 转换：API 成为 `interfaceType`（`openai-completions` 转 `openai-chat-completions`，另有 `openai-responses`、`anthropic-messages`），`baseUrl` 成为 `baseURL`，所有模型共用的请求头成为路由的请求头，每个 `chat:` 条目成为一个带容量、输入模态与思考档位的模型；`samplingParams` 成为该模型的 `defaults`。因此 `interfaceType` 变成可选：目录可以提供它，两者都没有的档案会按名被拒。档案自己的字段优先于转换结果；`models` 缺省或为空时保留目录中的模型——这正是官方规则：只有点名了列表，列表才替换目录。协议或端点不一致、没有任何 chat 模型、或无法读取的文件，会让这条路由留下诊断，而不是变成一个转了一半的路由；转换承载不了的每个字段（`cost`、`compat` 标志、`inputLimits`、逐模型请求头）都会按损失报告一次并带上涉及的模型数量，经 `ctx.logger.warn` 输出，而不是被猜测。

**图片输出被承载；视频以文件承载。** 声明了 `imageOutput` 的模型可以用图片作答：chat-completions 翻译器读取端点返回的内联图片部分（在 delta 上或整条 message 上），Responses 翻译器读取 image-generation item 的 base64 结果，而适配器——唯一知道路由事实的地方——把字节经附件提供方落盘，并重新发布为可持久化的 `block-end` 图片块，于是会话存的是引用而不是 base64。字节自己决定媒体类型（`src/image-output.ts` 嗅探 PNG/JPEG/WebP/GIF），因为附件提供方会按保存时声明的类型校验载荷。未声明该能力的模型若返回图片会按名失败，没有挂载附件提供方的部署同样如此；而该声明在 `anthropic-messages` 上被拒绝——那条协议的助手回合没有图片部件。`video` 被接受并以文件承载：一次视频出现以任何文件都会贡献的句柄文本抵达模型；`capabilities.imageOutput` 正是让 seam 的 `outputModalities` 说出 `['text', 'image']` 而不是 `['text']` 的依据。

**请求参数属于模型。** 模型条目的 `defaults` 声明 `temperature`、`topP`、`topK` 与 `maxTokens`，每个值只在调用方自己的请求没写时才写出——因此默认值永远不会覆盖显式选择。`topK` 在 `openai-responses` 上被拒绝，那条协议没有 top-k 字段；`defaults.maxTokens` 是 harness 交给未声明输出上限的调用方的值，未声明时回落到模型自己的 `maxTokens`。

**seam 说出输出模态。** `LlmModelInfo.outputModalities` 与 `inputModalities` 并列，本适配器总是发布它（`['text']`，声明图片输出处为 `['text', 'image']`），而不是留作未知，于是路由自己说明了回答里可能带什么。

**文案跟随代码。** 模型设置页的模态提示现在说明声明的视频输入如何出行，而不再声称"只承载文本"；声明的图片输出有了自己的提示；空白模型字段显示的容量占位改成本家族自己的默认值；README、模块文档以及两处未翻译或用词不当的字符串一并修正。

## Alternatives considered

**像 `dsh-llm-pi-ai` 那样按 provider id 读取已安装的 pi-ai 目录。** 拒绝：那个适配器存在的全部理由就是请求路径里没有已安装目录，而引入该依赖会把这个包刻意避开的模块图一起带进来；转换读的是同一种文件格式，但不需要那个包。

**这次就承载原生视频部件。** 拒绝：harness 还没有视频内容块，原生部件意味着改 `ContentBlockMap`、横跨十余个 root 的持久化确认、附件侧的视频媒体，以及一条只有部分网关接受的线部件。今天先接受声明，并给出诚实的含义——视频以文件抵达——原生部件是它自己的改动。

**给图片输出单开一个内容块。** 拒绝：harness 已经允许从流里收到 `image` 块（`block-end` 承载任意块，会话、附件发现与客户端都已处理助手消息上的图片引用），再开一种块只会白白带来一次持久化变更。

**把逐模型参数放进 seam 的调用配置。** 拒绝：`LlmCallConfig` 是每个适配器共享的跨包表面，而这里的需求只是某一个端点自己的设置；模型级字段把这处改动留在适配器内部、留在描述该端点的档案里。

**只要转换中有无法映射的字段就整体拒绝。** 拒绝：官方文件里大部分字段本就是本适配器不建模的（`cost`、按协议不同的 compat 标志），整体拒绝会让转换失去意义；每条损失报告一次，既让路由继续服务，又准确说明留下了什么。

## Consequences

一份官方服务商文件现在用三行档案就能变成可用路由，而它无法映射的字段会出现在日志里，而不是悄悄消失。声明了图片输出的路由可以端到端服务会产图的模型；没声明的路由若收到图片会**大声**失败。模型级默认值让一个网关上的两个模型都能被描述。`interfaceType` 变成可选是放宽而非破坏：过去因省略它而在 schema 处失败的档案，现在会在解析期失败并同时给出两条补救路径。

过去被拒绝的 `video` 与 `imageOutput` 声明现在可以解析——一份声明了其中之一并带着诊断的已存档案会变得可服务，这是本次改动唯一对外可见的语义变化（已记为升级说明）。

推迟项：原生视频部件（seam 的视频内容块）、按思考档位的默认参数（`samplingParamsByThinkingLevel` 今天只转成一条诊断），以及模型设置页里 `defaults` 的编辑入口——该字段今天已可通过 schema 在 `cordis.patch.yml` 中配置，页面上的模型行尚未提供。

## Testing

`tests/official-catalog.spec.ts` 覆盖转换表、每一处拒绝与带去重的计数诊断；`tests/profiles.spec.ts` 覆盖档案级 `catalog` 字段（内联、按路径、被覆盖、读不到）以及被接受的 `video`/`imageOutput` 声明；`tests/adapter.spec.ts` 通过 mock 端点端到端驱动图片输出并断言两条失败路径；`tests/image-output.spec.ts` 覆盖字节嗅探与内联 URL 解码；`tests/chat-completions.spec.ts` 与 `tests/responses-stream.spec.ts` 覆盖两条线的翻译，包括终止事件不得重复承载同一张图。

## Related

- [本地 LLM 服务会说 Anthropic Messages 协议](../bug-fix/2026-10-08-service-lite-anthropic-messages.zh.md) —— 本适配器第三种协议随之上线的那次改动。
