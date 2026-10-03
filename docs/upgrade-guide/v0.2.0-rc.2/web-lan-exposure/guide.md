---
kind: upgrade-guide
description: "The Web profile now binds the machine's LAN address by default and requires the persistent access token for that reachable bind; an overlay restores loopback-only."
---

# Web profile reachable from the local network by default

English | [中文](guide.zh.md)

## Change

Until this release, `dsh web` bound `127.0.0.1` and the harness was unreachable from anything but the machine running it. It now defaults to the machine's LAN address — the first interface carrying a network of its own — so a phone, a tablet, or another computer on the same network can open the Web UI without any configuration.

The reachable bind is authenticated. Every non-loopback host requires the persistent access token at `$DSH_HOME/access-token` (written `0600`); the first start creates one when the home has none, and `DSH_ACCESS_TOKEN` overrides it. A harness home that cannot be written does not fall back to an unauthenticated bind — the row refuses it and the boot fails with the reason.

Two things deliberately did not change: the command line still refuses `--host 0.0.0.0`, and a bind is still chosen by configuration rather than by a flag. What changed is the posture the shipped Web composition states.

Container bridges, virtual networks, and interfaces other than the bound one keep their loopback-only posture: the server binds one address, not `0.0.0.0`. Container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches, and tunnels rank last when that address is chosen, so a container host binds its physical interface even though Docker reports its bridges first; they are demoted rather than excluded, and a machine whose only address is a VPN interface binds that one.

## Migration

1. **To keep the loopback-only posture**, override the row:

   ```yaml
   - id: lan-access
     name: '@deepseek-ai/dsh-host-lan-access'
     config:
       host: 127.0.0.1
   ```

   Put it in the profile's `cordis.patch.yml` or pass it with `--patch`. Deleting the row has the same effect: the web bundle declares `lanAccess` as an injected dependency, so a tree without the row binds the loopback default.

2. **To bind every interface instead of one address** — for a machine whose reachable address changes, or a container — set `host: 0.0.0.0`. The security boundary is the token; the address only decides which networks can attempt to authenticate.

3. **To rotate the token**, delete `$DSH_HOME/access-token` (or change `DSH_ACCESS_TOKEN`) and restart. Every previously printed URL stops working, which is the point.

4. **If the chosen address is not the one you want** — a machine with two LANs, or one whose physical interface is not the one your phone reaches — set `host` to the address you mean. The default picks a network, not necessarily yours.

5. **Confirm**: the printed line carries the bound address — `dsh web: http://192.168.1.5:3080/?token=…` — and `ss -ltn` shows the listener on that address rather than on `127.0.0.1`.

### Security boundary

The server carries no TLS, sets no `Secure` attribute, and sends no HSTS header. The token appears once in the printed URL and then becomes an `HttpOnly` cookie over plain HTTP, so anyone who can observe the network path can read it. Treat the LAN as trusted, or front the server with a reverse proxy that terminates TLS or a virtual network that restricts who can connect. Per-peer allow-listing, per-user identity, and a second factor are not provided.
