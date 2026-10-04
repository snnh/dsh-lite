---
description: "Network exposure for the DeepSeek Harness web server: the row publishes every IPv4 interface by default, persists that posture in the profile, and refuses any reachable bind it cannot authenticate."
kind: "bundle-row"
---

# @deepseek-ai/dsh-host-lan-access

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-lan-access` decides the address the web server binds. It publishes every IPv4 interface this machine holds unless something states a host: the first start writes `host: 0.0.0.0` into the profile's own patch, so the persisted line, not the release's default, is what later starts bind. A reachable address is reachable by anyone who can route to it, so the row refuses a bind it cannot authenticate: every non-loopback host requires the persistent access token, and the row warns once in the startup log. Setting `host: 127.0.0.1` returns the tree to loopback only.

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

The row is mounted without a `host`, which means "every IPv4 interface this machine holds". The shipped Web composition mounts it inside a profile, and the first activation without a stated host persists `host: 0.0.0.0` into that profile's `cordis.patch.yml` (mode `0600`). Every later start reads that value back as the composed row config — a profile patch outranks every bundle default — so the posture outlives the release that set it. Deleting the key makes the next start state the shipped posture again.

A host the operator states is bound as written and persists nothing. `--host` from the invocation comes first, then the row's own `host` config, so `--host 127.0.0.1` narrows one run and `host: 127.0.0.1` in the profile narrows every run.

<a id="saving-an-address-from-the-settings-page"></a>
### Saving an address from the settings page

The General Settings page's Listen address row writes this same key: `config.host` of the composed `lan-access` row in the profile's own patch, merged with whatever else that row's patch config already holds. One line, one meaning — an address saved from that page and one edited by hand are indistinguishable to the next start, and the page reads the persisted line back rather than keeping a copy of its own.

The save is deliberately inert. It writes the file and stops there: the running server keeps the address it bound, no access token is created, the printed URL is not rewritten, and the Loader does not reconcile. The operator restarts to apply it, which is why the page shows the saved address beside the address in effect until they do. The write is accepted only for an address this row can bind — an IPv4 literal, the `0.0.0.0` wildcard and `localhost` included — so a typed IPv6 address or hostname is refused before it reaches the file instead of being persisted as a posture that cannot start; the refusal is the same one a hand-edit would earn on the next start, moved earlier, where it can still be corrected. A non-loopback address saved here is likewise only a request: the persistent access token it needs is created by the start that binds it, not by the save.

`--host` still outranks the saved line for the run that states it. The page reports that as a pinned posture: the address is stored, and it takes effect once the flag is removed.

With no profile to write into — an embedding that mounts this row directly — the fallback is `detectLanAddress()`: the first interface carrying a network of its own. Container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches (`virbr*`, `vmnet*`, `vboxnet*`), tunnels and overlays (`tun*`, `tap*`, `utun*`, `wg*`, `zt*`, `tailscale*`), and the platform's own shims — macOS `bridge*` (its VM bridge), `awdl*` and `llw*` (AirDrop and the WiFi companion, which a peer cannot route to), Windows/Hyper-V `vEthernet (<switch>)` — rank last: they are addresses a phone cannot reach and an operator did not mean, and a container host often reports them *before* the physical interface. They rank rather than disappear — a machine whose only address is a VPN interface still binds it — and a machine with no such address binds loopback. The table carries no exemption: a `br-` name is demoted whoever minted it, so an operator whose LAN genuinely arrives on a bridge named that way states `host` instead of expecting the name to be recognized.

The candidate list keeps an interface's own addresses together as well. Entries sharing a MAC form one contiguous run, with the names inside a run in order, so the interfaces this selection reads are the platform's — and their running order is the order the platform reports them in, not the order `node:os` happened to enumerate entries in.

Every host this row binds is IPv4. `0.0.0.0` is the IPv4 wildcard — all interfaces, container bridges included — and `detectLanAddress()` reads IPv4 addresses only, so a host that wants IPv6 exposure needs a face this row does not provide.

An overlay overrides the choice:

```yaml
- id: lan-access
  name: '@deepseek-ai/dsh-host-lan-access'
  config:
    host: 127.0.0.1
```

| `host` | Posture |
|---|---|
| omitted | Every IPv4 interface; the first start inside a profile persists `0.0.0.0` into that profile's `cordis.patch.yml` |
| `127.0.0.1` | Loopback only — the harness is unreachable from the network |
| `0.0.0.0` | Every IPv4 interface, container bridges included; no IPv6 listener |
| `192.168.1.5` | One explicit address, which must be local to this machine |

The printed line carries the addresses the server answers on, loopback first and the sampled LAN address beside it:

```
dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)
```

A reachable bind also writes one warning into the startup log, stating what is bound, that the token is the only authenticator, and how to narrow the posture.

### Returning to loopback

Set `host: 127.0.0.1` — in the profile's `cordis.patch.yml`, from the General Settings page's Listen address row, or through `--host 127.0.0.1` for a single run. The key an earlier start persisted is the same key, so editing or deleting it is the whole migration; nothing else records the posture. Removing the row is not a way back to loopback, because the shipped `webserver` row reads `ctx.lanAccess.host` and the bundle default without the row publishes every interface.

## Understand the implementation

### Why the default publishes every interface

The loopback default protects a machine nobody asked to expose; a machine running this harness has usually already chosen to be reachable, and the operator's first question is how to open the UI from the device in their hand. Publishing every IPv4 interface answers that for whichever network that device sits on: every network the machine joins — a second LAN, a virtual switch, a container bridge — is reachable without another configuration step, and an operator who wants one of them alone states that address instead.

Persisting the posture is what keeps that default honest. An operator who has not named a host has chosen the shipped one, so a later release that changes its own default must not silently move a machine that has already been started once: the profile states the choice, and deleting the key is the explicit way to ask for whatever the current release ships. The fallback for a composition with no profile stays narrow, because there is nowhere to record a choice and an embedder that wants exposure can say so.

### What the refusal covers

A loopback bind needs nothing beyond the process-local authentication the connection half already applies. Every other bind — stated or shipped — requires the persistent token first: a harness home that cannot be written, or a configured value below the length floor, rejects the row, so no web server binds a network address it could not authenticate. The reachable bind then writes its startup warning through `ctx.logger.warn` and `console.warn`; the console copy is required, because the default Web exporter filters `warn` records and an operator-visible warning has to reach the terminal. The warning names the bound address, the token as the only authenticator, the patch file to edit, and the flag that narrows one run — never the token itself, and it is a warning rather than a prompt: exposure is a posture the operator states, and nothing here blocks the start.

## Further Exploration

- `@deepseek-ai/dsh-client-connection` exchanges the token for the signed browser cookie and owns the Host/Origin fence.
- `@deepseek-ai/dsh-web-app` reads `ctx.lanAccess.host` for the bind, samples the reachable addresses into the trust fence, prints them, and uses the loopback URL as the application URL.

## Known Limitations and Deferred Work

- **No TLS, no `Secure` cookie, no HSTS.** The token travels once in the printed URL, then becomes an `HttpOnly` cookie over plain HTTP. Anyone who can observe the network path can read it; a reverse proxy or a virtual network is the answer for anything beyond trusted networks.
- **The posture is IPv4 only.** `0.0.0.0` is the IPv4 wildcard, so a dual-stack machine is reachable on its IPv4 addresses and not on its IPv6 ones, and `detectLanAddress()` never returns an IPv6 address.
- **A profile that cannot be written keeps the shipped posture without recording it.** The row logs the failed write and binds `0.0.0.0` anyway, so the operator sees both the exposure and the reason it was not persisted; a harness home that cannot hold the access token refuses the bind instead.
- **Ranking is by interface name, not by route.** Bridges and tunnels are demoted, but among interfaces that rank alike the operating system's enumeration order decides. This selection only runs where no profile states a host, so an operator who cares which network is published sets `host` explicitly.
- **The interface name is the only signal.** There is no platform I/O behind this table — no route lookup, no sysfs or WMI reading of the interface type — so a name the table does not carry is treated as a LAN interface: a bridge an operator renamed, a virtualization product with its own grammar (Parallels `enp*`/`vnic*`, say), or a platform whose switch names are not `virbr*`/`vmnet*`/`vEthernet*` ranks with the physical interfaces and may win the bind, bounded by the fact that a demoted address is still bound when nothing else exists, and by `host` stating the choice outright.
- **The trust fence is not an authentication layer.** It refuses cross-site and DNS-rebinding requests; the token is the authentication.

## Dev Note

### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. `resolveBindHost` takes the detected address as an argument so every branch — configured, detected, and neither — is pinned without depending on the machine the tests run on, and the persistence path runs against a real temporary profile rather than a stub.

### Tests

`tests/lan-access.spec.ts` stubs `DSH_HOME` per case and observes token creation, reuse, and refusal on the filesystem. `tests/lan-access-posture.spec.ts` drives the persisted posture over a real profile patch: what a first enable writes, that the row the Loader runs is the row addressed, what a stated host leaves alone, which source outranks which, and what the startup warning says. The default-host case asserts against the machine's own detection result rather than a fixed address, so it holds on a CI container with only loopback as well as on a workstation.
