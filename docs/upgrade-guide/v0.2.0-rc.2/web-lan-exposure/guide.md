---
kind: upgrade-guide
description: "The Web profile publishes every IPv4 interface by default, and that default is the row's schema default rather than a line any start writes."
---

# Web profile publishes every IPv4 interface by default

English | [中文](guide.zh.md)

## Change

Until this release, `dsh web` bound `127.0.0.1`, so only the machine running it reached the harness. The shipped `lan-access` row now publishes every IPv4 interface when nothing states a host: `0.0.0.0` is that row's schema default, and no start writes it anywhere. An earlier draft persisted it into the profile's `cordis.patch.yml`, and that is reverted. A profile patch that gains a line changes the row's composed config, so the Loader reconciles that entry, and the `webserver` row — which reads `ctx.lanAccess.host` — reloads with it: the old listener closes and a new port binds while the URL this start already printed still names the old one (observed: printed `127.0.0.1:46455`, actually listening on `0.0.0.0:34421`). Both cannot hold, so the default stays in the schema.

Every non-loopback host requires the persistent access token at `$DSH_HOME/access-token` (`0600`, created on first start, overridable with `DSH_ACCESS_TOKEN`); a host that cannot establish one fails the boot instead of listening unauthenticated — a read-only `DSH_HOME` can now stop the start.

The bind follows `--host`, then the composed row config, then the built-in `0.0.0.0`. A non-loopback bind writes one startup-log warning — through the logger and the console, since the Web exporter filters `warn` — naming the bound address, the token as the only authenticator, and how to narrow the posture. A stated host is validated before the bind, by one grammar the row owns (`classifyBindHost`): a loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`), `0.0.0.0`, or one IPv4 literal. Every other IPv6 literal — `--host ::` included, which the trust fence then answered 403 on — and every hostname now fails the start.

## Migration

1. **To keep a loopback-only posture**, state the host explicitly — a stated host is bound as written and saved by nothing else:

   ```yaml
   - id: lan-access
     name: '@deepseek-ai/dsh-host-lan-access'
     config:
       host: 127.0.0.1
   ```

   Put it in the profile's `cordis.patch.yml` or pass it with `--patch`; `dsh web --host 127.0.0.1` does the same for one run, and the General Settings page's Listen address row saves it for every later one. Deleting the row no longer means loopback.

2. **To publish one network instead**, set its address in the same row, such as `host: 192.168.1.5`. Delete the row's `host` key to fall back to the built-in `0.0.0.0` again.

3. **To rotate the token**, delete `$DSH_HOME/access-token` (or change `DSH_ACCESS_TOKEN`) and restart. Every previously printed URL stops working.

4. **Confirm**: the startup log carries the exposure warning with the bound address and `patchPath`, and the URL line carries both URLs — `dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)`.

### Security boundary

The server carries no TLS, no `Secure` attribute, and no HSTS header, so the token crosses the network in cleartext. Treat every attached network as trusted, or front the server with a TLS-terminating proxy.
