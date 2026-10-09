---
kind: upgrade-guide
description: "The Web profile replaces the `webRuntime` service and the `web-runtime` row's `trustedHosts` config with `webStartup` plus the `lanAccess` service the exposure row publishes."
---

# Web listener and trust configuration moves to `webStartup` and `lanAccess`

English | [中文](guide.zh.md)

## Change

The Web profile no longer provides the `webRuntime` service, and the `web-runtime` row no longer declares a `trustedHosts` config value. A profile, overlay, or `--patch` file that injects `webRuntime` now waits for a service that never mounts, and an expression reading `ctx.webRuntime.trustedHosts` fails to evaluate, so the required Connection cannot start.

Two rows replace it. The `web-startup` row provides one `webStartup` service carrying the invocation's flags, including its `--trusted-host` authorities. The `lan-access` row — mounted by this bundle and enabled by default — decides the address the web server binds and publishes `lanAccess`, whose `host` the `webserver` row reads, whose `lanAddresses` the URL line names beside the local URL, and whose `trustedHosts` (the literals this bind publishes plus the `--trusted-host` values) the `connection` row feeds to its `/api` fence.

The `lan-access` row's grammar is the only authority on the bind host: a loopback spelling, one IPv4 literal of a local interface, or `0.0.0.0` for every IPv4 interface — which remains this bundle's shipped posture, and needs the persistent access token before it binds. A host outside that grammar fails the start rather than falling back, and no row binds an address the operator did not state.

## Migration

1. Replace `inject: [webRuntime]` with `inject: [webStartup, lanAccess]` on every row that needs invocation trust.
2. Replace `ctx.webRuntime.trustedHosts` expressions with `ctx.lanAccess.trustedHosts`, and drop `ctx.webRuntime.lanAddresses`, which no longer exists. A deployment that only needs the invocation's own authorities reads `ctx.webStartup.trustedHosts` instead.
3. Rewrite the `connection` overlay for those two services, and move any `trustedHosts` value that the `web-runtime` row carried into its expression. A patch replaces the matched row's whole `config`, so restate that config completely, and write an array-valued `!!js` expression as a quoted scalar:

   ```yaml
   # before
   - id: connection
     inject: [webRuntime]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webRuntime.trustedHosts]"
   # after
   - id: connection
     inject: [webStartup, lanAccess]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.lanAccess.trustedHosts]"
   ```

4. Keep a `host` the exposure row can bind. `0.0.0.0` is still the shipped posture and publishes every IPv4 interface, authenticated by the persistent access token; name `127.0.0.1` for this machine alone, or one address of a local interface for a single network. The listener's own address is accepted by the Host fence with no `--trusted-host` entry; a proxy or DNS authority still needs one.
5. Boot with the migrated overlay: `dsh --profile web --patch ./extra.yml --no-open` must print the `dsh web:` URL line and serve. A row still waiting on `webRuntime` leaves the required Connection pending and reports an activation failure, and a host outside the exposure row's grammar fails the start. `dsh --profile web --patch ./extra.yml --dump-config` prints the composed patch before boot. [The Web bundle README](../../../../packages/bundle/web-app/README.md) owns the composed rows, and [the exposure row's README](../../../../packages/host/lan-access/README.md) owns the bind grammar.
