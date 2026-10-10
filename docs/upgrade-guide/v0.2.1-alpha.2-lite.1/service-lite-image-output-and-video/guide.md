---
kind: upgrade-guide
description: "llm-service-lite serves the image-output and video declarations it used to refuse, and its provider profiles accept an official catalog, an optional interfaceType, and per-model request defaults."
---

# Model routes carry image output, and video arrives as a file

English | [中文](guide.zh.md)

## Change

In this release, `@deepseek-ai/dsh-llm-service-lite` stops refusing two declarations it used to reject at resolution.

`capabilities.imageOutput: true` now resolves and is served. A model that declares it may answer with images: the inline picture the endpoint returns is stored through the attachment provider and republished as a durable image block, so the session holds a reference rather than base64. An image from a model that never declared the capability fails the request by name, and the declaration is still refused on `interfaceType: anthropic-messages`, whose assistant turn has no image part — with a message saying exactly that.

A `video` input modality now resolves and is carried as a file: a video occurrence reaches the model as the same handle text any file attachment contributes. It does **not** reach the model as moving pictures — no served wire has a video part and the harness has no video content block yet, so the declaration states that the route accepts video files.

Two related additions ride along. A provider profile may now name a `catalog` — the path of an official provider file, or its parsed content — whose models, endpoint, headers, protocol, and sampling settings are converted into the profile's own vocabulary; when a catalog supplies the protocol, `interfaceType` may be omitted, and a profile that names neither is refused with a message naming both remedies. A model entry may now declare `defaults` (`temperature`, `topP`, `topK`, `maxTokens`), each written only where a caller states no value.

The audience is a deployment that declared `imageOutput` or a `video` modality on an llm-service-lite route, or that wants to adopt an official provider file.

## Migration

1. A stored profile that declared `imageOutput: true` or `modalities` including `video` was previously kept addressable with a diagnostic and served nothing. After this change it resolves and serves. Check that it does what you intended: image output needs the attachment provider mounted (`@deepseek-ai/dsh-attachment-local` or another), and video input means the model reads a file handle, not frames. Nothing needs rewriting.
2. A profile that declared `imageOutput: true` on `interfaceType: anthropic-messages` stays unserviceable; the diagnostic now reads `that protocol has no assistant image part`. Drop the declaration, or move the route to one of the two OpenAI-compatible protocols.
3. A deployment that wants to adopt an official provider file may now point `catalog` at it and let the plugin convert it: `models` may be left out (the catalog's models stand), and any field the conversion cannot carry is reported in the host log once per loss. Nothing changes for profiles that declare none.
4. No action is required for a profile that declared neither capability. Existing routes, credentials, image inputs, and token accounting keep working unchanged.
