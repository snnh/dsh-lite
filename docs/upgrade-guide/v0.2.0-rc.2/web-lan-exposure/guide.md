---
kind: upgrade-guide
description: "The Web profile publishes every IPv4 interface by default and pins that posture in the profile patch, so a read-only DSH_HOME can fail the boot."
---

# Web profile publishes every IPv4 interface by default

English | [中文](guide.zh.md)

## Change

Until this release, `dsh web` bound `127.0.0.1`, so only the machine running it reached the harness. The shipped `lan-access` row now publishes every IPv4 interface when nothing states a host, and the first start persists `host: 0.0.0.0` into the profile's `cordis.patch.yml` (mode `0600`). That persisted line — not this release's default — is what every later start binds, so a later release changing its default moves nothing for an operator who has started once; deleting the key re-pins it. `0.0.0.0` is the IPv4 wildcard, container bridges included, and nothing listens over IPv6.

Every non-loopback host requires the persistent access token at `$DSH_HOME/access-token` (`0600`, created on first start, overridable with `DSH_ACCESS_TOKEN`); a host that cannot establish one fails the boot rather than listening unauthenticated. A read-only `DSH_HOME`, which the loopback default used to admit, can now stop the start.

The bind follows `--host`, then the composed row config (where the persisted posture lives), then `detectLanAddress()`, then loopback. `--host 0.0.0.0` is accepted and reaches the bind, and a container host publishes its bridges rather than keeping them loopback-only. A non-loopback bind writes one startup-log warning — through the logger and the console, since the Web exporter filters `warn` — naming the bound address, the token as the only authenticator, and how to narrow the posture, and no Web banner asks for confirmation.

With no profile, an embedding mounting the row keeps the narrow fallback: `detectLanAddress()`'s answer for a machine with a LAN, loopback for one without, and nothing written.

## Migration

1. **To keep a loopback-only posture**, state the host explicitly — nothing is persisted while a host is stated:

   ```yaml
   - id: lan-access
     name: '@deepseek-ai/dsh-host-lan-access'
     config:
       host: 127.0.0.1
   ```

   Put it in the profile's `cordis.patch.yml` or pass it with `--patch`; `dsh web --host 127.0.0.1` does the same for one run. Deleting the row no longer means loopback.

2. **To publish one network instead**, set its address in the same row, such as `host: 192.168.1.5`. Delete the row's `host` key to let the shipped posture be written again.

3. **To rotate the token**, delete `$DSH_HOME/access-token` (or change `DSH_ACCESS_TOKEN`) and restart. Every previously printed URL stops working.

4. **Confirm**: the startup log carries the exposure warning with the bound address and its `patchPath`, and the URL line carries the loopback URL with the LAN one — `dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)`.

### Security boundary

The server carries no TLS, sets no `Secure` attribute, and sends no HSTS header, so the token crosses the network in cleartext. Treat every attached network as trusted, or front the server with a TLS-terminating proxy or a restricting virtual network.
