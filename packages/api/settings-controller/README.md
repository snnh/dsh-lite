---
description: "Host Remote owner for settings, credential, and bind-address configuration surfaces, including redacted reads, writes, credential references, the persisted listen address, and native document opening."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, and `ctx.remote.webHost` namespaces for browser configuration surfaces. It returns redacted settings and credential metadata, supports settings and credential writes without returning secret values, persists the listen address a page saves for the next start, and opens provider-owned settings or Agent preset locations on the Host desktop. When a provider is absent, the namespace remains registered and returns an actionable configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers all three namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings and credential Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text editor; it accepts no browser-supplied filesystem target.

`webHost.status()` reports one listen-address posture, keeping the facts apart: `bound` is what this process bound, `persisted` is the host the profile patch states, `pinned` is the `--host` this invocation named, `detected` is this machine's LAN address, and `writable` says whether a profile patch exists to save into. A fact this deployment does not have is omitted rather than sent as `undefined`, so a page distinguishes `rowFound: false` — no lan-access row is composed — from an unstated address.

`webHost.save(host)` writes one line: the `config.host` of the composed lan-access row in the profile's own patch, merged with whatever else that row's patch config already holds, or the shipped row identity when the profile composes none. Nothing else follows: no Loader reconcile, no rebind, no token resolution, and no change to the running server's URL or session token, so a non-loopback address persists without creating the token the next start will demand. The accepted grammar is the row's own and has one authority, lan-access's `classifyBindHost`: a loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`), the `0.0.0.0` wildcard, or one IPv4 literal. A hostname and every other IPv6 literal — a non-loopback one such as `::` — is refused as `web-host-rejected` with the address in its details. A save into a deployment with no profile patch is refused the same way.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings and credential configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
