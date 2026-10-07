# Agent Note: An opt-in remote operator surface

Status: implemented

English | [中文](2026-10-07-remote-operator-surface-opt-in.zh.md)

## Problem

A deployment reached over the LAN could run Sessions but could not be administered. Settings documents, plugin configuration, and provider credentials live behind `ctx.remote.$host.isLoopback` ([ui-settings](../../../../packages/client/ui-settings/src/client/index.ts)), which the Connection service derives from the page's own authority: `ownsHost`, a non-browser context, or `isLoopbackHostname(location.hostname)` ([connection client](../../../../packages/client/connection/src/client/index.ts)). A page served at `http://192.168.1.5:3080` is none of those, so the settings mirror is constructed with `memory` persistence, reports `settings are unavailable in this browser`, and every plugin page registered against `configForms` never appears. Remote operators were left with a read-and-chat surface and no way to configure anything over the address they actually use.

The fences that would have made the page safe were already passed. Every `/api` request clears the Host/Origin trust fence, which admits loopback, `trustedHosts`, and the LAN literals the Web runtime derives from an active all-interface bind, and every RPC handler sits behind a browser session bound to the persistent access token ([browser auth](../../../../packages/client/connection/src/browser-auth.ts)). The token is the only authenticator on that surface, and the frozen `memory` mode silently discards writes rather than refusing them, which is the worse half of both postures: no administration, and no error explaining why.

## Decision

### The owning row states the posture

The `client-connection` row takes `operatorSurface?: 'loopback' | 'trusted'`, defaulting to `'loopback'` ([schema](../../../../packages/client/connection/src/index.ts)). The default keeps every existing deployment exactly as it was. `'trusted'` states that the pages this Host serves are the operator surface too: the Host resolves it once and injects it as `__DSH_OPERATOR_SURFACE__` beside the recovery global, and the Connection handle carries it into the browser half.

### The served document is the proof of token validation

The privileged flag is granted synchronously, with no wait for a connection generation. It does not need one: the Host's own document route is behind the access-token gate, which writes `set-cookie` and redirects on the `GET /` exchange and answers `401` through `writeUnauthorized` for everything else, so a page that exists at all has already presented a valid token. Reads and writes made from it still pass the trust fence and the session check on every request, so the posture widens which UI a page is offered, never what an unauthenticated request can reach.

An earlier revision gated the flag on an authenticated connection generation and awaited it from the settings plugins' `apply`. That deadlocked the whole application: the connection loop starts after the client mounts, so activation awaiting it never settles, and the served app stopped at `Loading plugins…` on loopback as well as over the LAN.

### `isLoopback` keeps its name and its readers

`$host.isLoopback` is the one fact every privileged consumer already reads ([gateway client](../../../../packages/api/gateway/src/client/index.ts)), so the posture joins it there rather than behind a second flag each consumer would have to learn. The name now means "the privileged surface is reachable for this page", which is what its readers always asked.

## Alternatives considered

**Keep the loopback-only surface and nothing else.** Rejected: it is the posture every existing deployment has and it stays the default, so a deployment that wants administration confined to the machine still reaches the loopback address over a tunnel without stating anything new. What it cannot do is serve the operator who holds the LAN address: the access token already runs Sessions and tools for that operator, so this posture withheld administration of the very documents those Sessions obey, and the frozen `memory` mode discarded their writes without saying so.

**Gate the privileged flag on an authenticated connection generation.** Rejected: waiting for a generation would have made the privilege follow a live authenticated connection rather than a served document. The connection loop starts after the client mounts, so a settings plugin awaiting it never settles and the application stops at `Loading plugins…` on loopback as well as over the LAN. The access-token gate on the document route is the same evidence, and it is available synchronously.

## Consequences

- A LAN deployment administers itself from the address it is served at: settings, the plugin inventory, and plugin pages such as a profile-installed bundle's own settings surface all work at `http://<lan-ip>:<port>/?token=…`.
- `loopback` stays the default, so no shipped preset, golden, or existing profile changes behaviour: `test:expected` (109), `test:e2e` (183), and `test:snapshot` (181) pass unchanged.
- The operator now opts into a real widening: with `operatorSurface: trusted`, anyone who holds the access token can write settings documents and plugin configuration from any network position that clears the fence, which is the same exposure the token already carries for Sessions and tools. Deployments that want administration confined to the machine keep the default and reach the loopback address over a tunnel.
- `ConnectionHandle.operatorSurface` is a new required field, so hand-built Connection doubles in tests must state it; the fork's own `job-controller` double does.
- Divergence from upstream is one schema field, one injected global, and one predicate; the fork carries it as a deliberate deviation and the upstream default remains the conservative one.
