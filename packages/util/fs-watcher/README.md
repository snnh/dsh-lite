---
description: "Chokidar-backed watcher lifecycle for host packages: one place creates each filesystem watcher, gates its readiness, routes its failures, and closes it."
kind: "package-library"
---

# @deepseek-ai/dsh-fs-watcher

English | [中文](README.zh.md)

## Summary

`dsh-fs-watcher` lets host packages watch files and directories without depending on the watcher library or re-deriving its lifecycle rules. Callers keep their own paths and options — filters, depth, write stabilization, polling — and subscribe to the events the backend emits. The HMR service, the local filesystem, the local credentials store, and the filesystem skill provider all consume it. The library owns creation, readiness gating, failure routing, and teardown; each consumer still owns what a change means.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use `createWatcher()` when a host package observes the file system and must report readiness, surface backend failures, and release the native handles in a defined order. Use `waitForReady()` when the consumer has to finish its own setup before it can act on events. A caller that reads a path once does not need either.

### Entry point

Create a watcher with the caller's own options, subscribe, then wait for the initial scan:

```ts
import { createWatcher, waitForReady } from '@deepseek-ai/dsh-fs-watcher'

declare const root: string

const watcher = createWatcher(root, {
  ignoreInitial: true,
  depth: 0,
  ignored: entry => entry.endsWith('.tmp'),
})
watcher.on('all', (event, path) => { console.log(event, path) })
watcher.on('error', (error) => { console.error(error) })
await waitForReady(watcher, { onError: (error) => { console.error(error) } })

// At teardown, and safe to call more than once:
await watcher.close()
```

`waitForReady()` resolves after the initial scan, rejects with the first failure — or with the abort reason of an optional signal — and keeps routing later failures to `onError`. See [`src/index.ts`](src/index.ts) for the exact TypeScript contract.

A consumer that watches with a different Chokidar major than this package's own passes its module as the optional third argument, so the instance comes from the Chokidar it depends on:

```ts
import { createWatcher, type ChokidarNamespace } from '@deepseek-ai/dsh-fs-watcher'

declare const root: string
/** The consumer's own `chokidar` module, whatever major it depends on. */
declare const chokidar: ChokidarNamespace

const watcher = createWatcher(root, { ignoreInitial: true }, chokidar)
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`createWatcher()` reads the backend's watcher factory — the named export or the default export, whichever the loaded module carries — and wraps the returned instance in a facade that forwards `on`, `once`, `off`, and `close` to it. Listener order, event arguments, and emitter error semantics therefore stay exactly the backend's: the facade adds lifecycle, not translation.

`waitForReady()` settles the caller's readiness exactly once. The first failure while waiting rejects the returned promise; every failure after that settles goes to `onError`, so a startup failure still rejects once and a later watcher death is still reported. The readiness and failure listeners stay attached for the watcher's lifetime, and an abort listener is removed as soon as readiness settles.

The facade counts its open watchers. That registry is the single place a future handle or memory ceiling would enforce from; today it only reports.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Watcher creation, event delegation, readiness gating, and live-watcher accounting |
| [`tests/fs-watcher.spec.ts`](tests/fs-watcher.spec.ts) | Faked-backend coverage of creation, delegation, readiness, abort, teardown, and module shapes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — the other shared primitives in this group.
- [`packages/boot/hmr`](../../boot/hmr/README.md) — the module and configuration reloader that decides what a changed module means.
- [`packages/fs/fs-local`](../../fs/fs-local/README.md) — the local filesystem backend whose watch observes one target or its parent directory.

-----

<a id="model-experience"></a>
## Model Experience

None, as this library only manages watcher lifecycles and registers nothing model-facing itself.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One backend instance per call** — `createWatcher()` does not merge callers whose options happen to agree. Consumers differ in depth, filters, path spelling, polling, and write stabilization, so a shared instance would change which events each one sees; sharing stays deferred.
- **No handle ceiling** — `liveWatcherCount()` reports the open watchers, but nothing refuses a new one; capacity policy still belongs to each caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
