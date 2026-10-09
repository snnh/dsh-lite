# Agent Note: LAN exposure policy lives in one plugin

Status: implemented

English | [中文](2026-10-09-lan-exposure-policy-plugin.zh.md)

## Problem

This fork ships network exposure as a product feature: `dsh web` publishes every IPv4 interface by default, prints the best-ranked LAN address beside the local URL, keeps the persistent access token as the only authenticator on a reachable bind, and admits the literals that bind publishes into the `/api` Host fence.

That policy was spread across three owners. `packages/bundle/web-app/src/index.ts` computed the LAN snapshot (`resolveLanTrust`, `printableLanAddresses`), provided it as the `webRuntime` service, and appended the `(LAN: …)` suffix to the URL line. `packages/host/webserver` described the exposure row as the authority on its own host grammar in its `Config.host` documentation while accepting any non-empty value. `packages/bundle/web-app/src/startup.ts` published `--host` for a consumer to decide. Upstream then redesigned the same area — one concrete bind literal, the unspecified address rejected at load, the `webRuntime` service and LAN sampling removed — so every upstream merge had to re-litigate the same files, and the feature depended on carrier code upstream deletes.

## Decision

`@deepseek-ai/dsh-host-lan-access` — mounted by the web bundle patch and enabled by default — owns exposure end to end. It resolves the bind host in the operator's order of authority (`--host`, then its own composed `host`, then the shipped `0.0.0.0`), refuses a value outside its grammar instead of falling back, requires the persistent access token before a non-loopback bind, warns once through `ctx.logger.warn` and `console.warn`, and publishes one service:

```ts
interface LanAccessValues extends LanRuntimeValues {
  readonly host: string
}
interface LanRuntimeValues {
  readonly lanAddresses: string[]
  readonly trustedHosts: string[]
}
```

`lanAddresses` is the ranked display selection (physical interfaces first, link-local and address-less records dropped) and `trustedHosts` is the fence's admission list — every non-internal IPv4 literal this machine holds plus the `--trusted-host` values. Both are sampled once, when the row resolves its host.

The carrier judges no grammar. `webserver.config.host` accepts any non-empty string and hands it to `listen`; `classifyBindHost` in the exposure row is the only authority on what may be stated, and the settings page shares that same function so a saved posture is one the bind can take. Loopback is decided by the address a value names rather than by its spelling: the plugin reuses the carrier's exported `isLoopbackHost` (a literal parser over mapped forms, dotted-quad tails, zones, and 127/8), so a mapped loopback spelling binds this machine alone while a non-loopback IPv6 literal is still refused.

The bundle reads the service instead of computing it. `web-app`'s URL line names `ctx.lanAccess.lanAddresses[0]` beside the local URL; the `connection` row injects `lanAccess` and feeds `ctx.lanAccess.trustedHosts` to its `/api` fence; the `webRuntime` service no longer exists. Upstream's transport work that does not collide with any of this stays: zone-free and IPv4-canonical URL text, bracketed IPv6 binds, `--public-url`, and native TLS.

## Alternatives considered

**Keep upstream's concrete-bind-only design.** It rejects every unspecified address at load and drops LAN sampling entirely, which deletes a shipped capability (default LAN reachability, the `(LAN: …)` link, the derived fence literals) that this fork's settings row, docs, and upgrade guide expose. Taking it would mean re-shipping those features from a plugin that has no carrier to publish a wildcard through.

**Keep the LAN code in the web-app bundle.** That is the pre-merge layout: the bundle owns a policy about networks no browser glue concerns, `webRuntime` becomes a second bundle-level service for it, and every upstream merge conflicts on the URL line and the bundle's service list. The plugin boundary is also what makes the posture configurable at all — a bundle has no row an operator can edit.

**Duplicate the loopback-literal parsing in the plugin.** The plugin could parse mapped forms and zones itself instead of importing the carrier's predicate, but that is two parsers for one address grammar: the duplication gate exists precisely to stop the drift where a value classifies as loopback for the bind and not for the chooser, or the reverse.

**Let the carrier keep a validation grammar and have the plugin bypass it.** A permissive carrier is the only way the exposure row can publish `0.0.0.0`, and a carrier that validates independently of the row would reject postures the row admits. Grammar ownership follows the decision, so it sits in the row that decides.

## Consequences

Turning exposure off is one line: `host: 127.0.0.1` on the `lan-access` row (or `--host 127.0.0.1` for a single run). The row is also removable — the bundle's `webserver` row reads `ctx.lanAccess.host`, so a composition without it falls back to that row's own config, and nothing derives LAN literals for the fence.

The carrier's permissiveness is a deliberate trade: a composition that mounts `webserver` without the exposure row can state any host the operating system accepts, including a wildcard, and no row warns or requires a token. That is the documented cost of keeping the security decision in the row that ships it; the shipped web bundle always mounts the row.

Upstream merges now land in the plugin and one patch line. The carrier keeps only the generic single-line schema deviation (any non-empty host) and the URL formatter, both of which upstream's own change already touched.

The exposure row's README, the web bundle README, and the [web listener upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md) are the reader-facing half of this note; they state the posture, the grammar, and the migration from `webRuntime` to `webStartup` plus `lanAccess`.

## Testing

`packages/host/lan-access/tests/lan-access-bind-host.spec.ts` pins the grammar (every loopback spelling admitted, non-loopback IPv6, mapped wildcards, padded and over-long values refused) and the refusal message; `lan-access-posture.spec.ts` pins posture resolution, token creation, and the warning text; `lan-access-selection.spec.ts` and the candidate-order suite pin ranking and display selection. `packages/host/webserver/tests/webserver.spec.ts` pins the carrier's permissiveness and its address predicates. `packages/bundle/web-app/tests/lan-url-print.spec.ts` pins the printed LAN link against the service, `container-publish-trust.spec.ts` pins the fence seam, and `packages/api/settings-controller/tests/web-host-bind-grammar.host.spec.ts` pins the settings page against the same grammar. `apps/cli/tests/profiles/web/tests/public-url.expected.e2e.ts`, `web-failure-matrix.expected.e2e.ts`, and `apps/cli/tests/web-host-settings.e2e.ts` boot the built profile on loopback, mapped loopback, and non-loopback binds.
