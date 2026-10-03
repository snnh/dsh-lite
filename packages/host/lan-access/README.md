---
description: "Network exposure for the DeepSeek Harness web server: the row binds this machine's LAN address by default and refuses any reachable bind it cannot authenticate."
kind: "bundle-row"
---

# @deepseek-ai/dsh-host-lan-access

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-lan-access` decides the address the web server binds, and it binds the machine's LAN address by default: the harness is reachable from a phone, a tablet, or another machine on the same network, while container bridges and every other interface keep their loopback-only posture. A reachable address is reachable by anyone who can route to it, so the row refuses a bind it cannot authenticate — every non-loopback host requires the persistent access token, which the row resolves (creating one when the harness home has none) before the service is provided. Setting `host: 127.0.0.1` returns the tree to loopback only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Choosing the bind address

The row is mounted without a `host`, which means "this machine's LAN address".

That address is the first interface carrying a network of its own. Container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches (`vmnet*`, `vboxnet*`), and tunnels (`tun*`, `utun*`, `wg*`, `tailscale*`) rank last: they are addresses a phone cannot reach and an operator did not mean, and a container host often reports them *before* the physical interface. They rank rather than disappear — a machine whose only address is a VPN interface still binds it.

An overlay overrides the choice:

```yaml
- id: lan-access
  name: '@deepseek-ai/dsh-host-lan-access'
  config:
    host: 127.0.0.1
```

| `host` | Posture |
|---|---|
| omitted | This machine's LAN address — its first interface carrying a network of its own, or loopback when it has none |
| `127.0.0.1` | Loopback only — the harness is unreachable from the network |
| `0.0.0.0` | Every interface, container bridges included |
| `192.168.1.5` | One explicit address, which must be local to this machine |

The printed line carries the address the server bound:

```
dsh web: http://192.168.1.5:3080/?token=…
```

### Returning to loopback

Set `host: 127.0.0.1`, or delete the row. The web bundle declares `lanAccess` as an injected dependency, so a tree that mounts the row with an explicit loopback host binds loopback, and the row's own default is the only thing that exposes the machine.

## Understand the implementation

### Why the default is the LAN address

The loopback default protects a machine nobody asked to expose; a machine running this harness has usually already chosen to be reachable, and the operator's first question is how to open the UI from the device in their hand. Binding one address rather than every interface answers that without also listening on container bridges, virtual networks, and any other interface the machine happens to carry, so the exposure is as narrow as the request.

### What the refusal covers

A loopback bind needs nothing beyond the process-local authentication the connection half already applies. Every other bind — detected or configured — requires the persistent token first: a harness home that cannot be written, or a configured value below the length floor, rejects the row, so no web server binds a network address it could not authenticate.

## Further Exploration

- `@deepseek-ai/dsh-client-connection` exchanges the token for the signed browser cookie and owns the Host/Origin fence.
- `@deepseek-ai/dsh-web-app` samples the reachable address into the trust fence, prints it, and uses it as the application URL.

## Known Limitations and Deferred Work

- **No TLS, no `Secure` cookie, no HSTS.** The token travels once in the printed URL, then becomes an `HttpOnly` cookie over plain HTTP. Anyone who can observe the network path can read it; a reverse proxy or a virtual network is the answer for anything beyond a trusted LAN.
- **Ranking is by interface name, not by route.** Bridges and tunnels are demoted, but among interfaces that rank alike the operating system's enumeration order decides. A host with several such networks (a laptop on Wi-Fi and Ethernet) binds the first one it reports, so an operator who cares which one sets `host` explicitly.
- **The trust fence is not an authentication layer.** It refuses cross-site and DNS-rebinding requests; the token is the authentication.

## Dev Note

### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. `resolveBindHost` takes the detected address as an argument so every branch — configured, detected, and neither — is pinned without depending on the machine the tests run on.

### Tests

`tests/lan-access.spec.ts` stubs `DSH_HOME` per case and observes token creation, reuse, and refusal on the filesystem. The default-host case asserts against the machine's own detection result rather than a fixed address, so it holds on a CI container with only loopback as well as on a workstation.
