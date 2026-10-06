---
description: "Network exposure for the DeepSeek Harness web server: the row publishes every IPv4 interface by schema default, writes no file, and refuses any reachable bind it cannot authenticate."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-lan-access

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-lan-access` decides the address the web server binds. It publishes every IPv4 interface this machine holds unless something states a host: that posture is this row's schema default `0.0.0.0`, and the row writes no file while deciding. A reachable address is reachable by anyone who can route to it, so the row refuses a bind it cannot authenticate: every non-loopback host requires the persistent access token, and the row warns once in the startup log. Setting `host: 127.0.0.1` returns the tree to loopback only.

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

### Choosing the bind address

The row is mounted without a `host`, which means "every IPv4 interface this machine holds". That posture is the row's schema default (`host: z.string().default('0.0.0.0')`), so no start writes it into the profile patch or anywhere else. An earlier draft persisted the line for later starts, and it was reverted: a profile patch that gains a line changes the row's composed config, so the Loader reconciles that entry, and the `webserver` row — whose `host` is the expression `ctx.lanAccess.host` — reloads with it, closing the old listener and binding a new port while the URL this start already printed still names the old one (observed: printed `127.0.0.1:46455`, actually listening on `0.0.0.0:34421`). A printed URL and a first-run write cannot both hold.

A stated host is bound as written and persists nothing: `--host` from the invocation comes first, then the row's own `host` config, and only then the built-in `0.0.0.0`. So `--host 127.0.0.1` narrows one run and `host: 127.0.0.1` in the profile narrows every run, and a stated host is the only thing that holds a posture against a later release changing its default. Both go through this row's one grammar authority, `classifyBindHost`, before the bind: a loopback spelling, the `0.0.0.0` wildcard, or an IPv4 literal is bound as stated, and anything else refuses the start and states the grammar back rather than falling back to the shipped posture.

<a id="saving-an-address-from-the-settings-page"></a>
### Saving an address from the settings page

The General Settings page's Listen address row writes this same key: `config.host` of the composed `lan-access` row in the profile's own patch, merged with whatever else that row's patch config already holds. One line, one meaning — an address saved from that page and one edited by hand are indistinguishable to the next start, and the page reads the persisted line back rather than keeping a copy of its own.

The save is deliberately inert. It writes the file and stops there: the running server keeps the address it bound, no access token is created, the printed URL is not rewritten, and the Loader does not reconcile. The operator restarts to apply it, which is why the page shows the saved address beside the address in effect until they do. The write is accepted only for an address this row can bind, judged by the same grammar the bind uses (`classifyBindHost`): a loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`), the `0.0.0.0` wildcard, or one IPv4 literal. A typed hostname, or a non-loopback IPv6 literal such as `::`, is refused before it reaches the file instead of being persisted as a posture that cannot start; the refusal is the same one a hand-edit would earn on the next start, moved earlier, where it can still be corrected. A non-loopback address saved here is likewise only a request: the persistent access token it needs is created by the start that binds it, not by the save.

`--host` still outranks the saved line for the run that states it. The page reports that as a pinned posture: the address is stored, and it takes effect once the flag is removed.

`detectLanAddress()` answers with this machine's LAN address — the first interface carrying a network of its own — for callers that ask it; the bind itself no longer falls back to it, because a start that binds an address the operator did not state is the silent failure this row is written against. Container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches (`virbr*`, `vmnet*`, `vboxnet*`), tunnels and overlays (`tun*`, `tap*`, `utun*`, `wg*`, `zt*`, `tailscale*`), and the platform's own shims — macOS `bridge*` (its VM bridge), `awdl*` and `llw*` (AirDrop and the WiFi companion, which a peer cannot route to), Windows/Hyper-V `vEthernet (<switch>)` — rank last: they are addresses a phone cannot reach and an operator did not mean, and a container host often reports them *before* the physical interface. They rank rather than disappear — a machine whose only address is a VPN interface still binds it — and a machine with no such address binds loopback. The table carries no exemption: a `br-` name is demoted whoever minted it, so an operator whose LAN genuinely arrives on a bridge named that way states `host` instead of expecting the name to be recognized.

The candidate list keeps an interface's own addresses together as well. Entries sharing a MAC form one contiguous run, with the names inside a run in order, so the interfaces this selection reads are the platform's — and their running order is the order the platform reports them in, not the order `node:os` happened to enumerate entries in.

Every host this row publishes is IPv4. `0.0.0.0` is the IPv4 wildcard — all interfaces, container bridges included — and `detectLanAddress()` reads IPv4 addresses only, so a host that wants IPv6 exposure needs a face this row does not provide. Loopback is the one spelling that reaches further: `::1` and `[::1]` are accepted because they name this machine alone exactly as `127.0.0.1` does, and they bind the IPv6 loopback rather than a network address.

An overlay overrides the choice:

```yaml
- id: lan-access
  name: '@deepseek-ai/dsh-host-lan-access'
  config:
    host: 127.0.0.1
```

| `host` | Posture |
|---|---|
| omitted | Every IPv4 interface, from the schema default `0.0.0.0`; nothing is written anywhere |
| `127.0.0.1` | Loopback only — the harness is unreachable from the network |
| `0.0.0.0` | Every IPv4 interface, container bridges included; no IPv6 listener |
| `192.168.1.5` | One explicit address, which must be local to this machine |
| `localhost`, `::1`, `[::1]` | The same loopback posture, spelled as a name or as the IPv6 loopback literal |

Anything outside that grammar — a hostname other than `localhost`, a non-loopback IPv6 literal such as `::`, or a blank or space-padded value — is refused at startup, with the accepted shapes stated back.

The printed line carries the addresses the server answers on, loopback first and the sampled LAN address beside it:

```
dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)
```

A reachable bind also writes one warning to the startup log and the terminal, stating what is bound, that the token is the only authenticator, and how to narrow the posture.

### Returning to loopback

Set `host: 127.0.0.1` — in the profile's `cordis.patch.yml`, from the General Settings page's Listen address row, or through `--host 127.0.0.1` for a single run. That stored line is the only record of the posture, so editing or deleting it is the whole migration: with no line there, the next start binds the row's built-in `0.0.0.0` again. Removing the row is not a way back to loopback, because the shipped `webserver` row reads `ctx.lanAccess.host` and the bundle default without the row publishes every interface.

## Understand the implementation

### Why the default publishes every interface

The loopback default protects a machine nobody asked to expose; a machine running this harness has usually already chosen to be reachable, and the operator's first question is how to open the UI from the device in their hand. Publishing every IPv4 interface answers that for whichever network that device sits on: every network the machine joins — a second LAN, a virtual switch, a container bridge — is reachable without another configuration step, and an operator who wants one of them alone states that address instead.

The default is deliberately not written back, and that is what keeps a start's printed URL honest. A profile patch that gained the line would change the row's composed config, so the Loader reconciles a changed entry, and the `webserver` row — which reads this host through `ctx.lanAccess.host` — reloads with it: the old listener closes and a new port binds while the URL this start already printed still names the old one. The trade is accepted: a release that changes this default moves a machine that never stated a host, and an operator who wants a posture to outlive releases states it, on the settings page or in the profile patch.

### What the refusal covers

A loopback bind states no precondition of its own: the connection half authenticates every start with the persistent token it resolves, so there is nothing for this row to add when only this machine can reach the server. Every other bind — stated or shipped — requires the persistent token first: a harness home that cannot be written, or a configured value below the length floor, rejects the row, so no web server binds a network address it could not authenticate. The reachable bind then writes its startup warning through `ctx.logger.warn` and `console.warn`; the console copy is required, because the default Web exporter filters `warn` records and an operator-visible warning has to reach the terminal. The warning names the bound address, the token as the only authenticator, the patch file to edit, and the flag that narrows one run — never the token itself, and it is a warning rather than a prompt: exposure is a posture the operator states, and nothing here blocks the start.

## Further Exploration

- `@deepseek-ai/dsh-client-connection` exchanges the token for the signed browser cookie and owns the Host/Origin fence.
- `@deepseek-ai/dsh-web-app` reads `ctx.lanAccess.host` for the bind, samples the reachable addresses into the trust fence, prints them, and uses the loopback URL as the application URL.

-----

<a id="model-experience"></a>
## Model Experience

None, as this row only decides the address the web server binds and refuses a reachable bind it cannot authenticate; it registers no prompt, tool schema, or session event.

#### KV Cache effect

None; the bind posture never enters a model request, so a reusable provider prefix is left untouched.

## Known Limitations and Deferred Work

- **No TLS, no `Secure` cookie, no HSTS.** The token travels once in the printed URL, then becomes an `HttpOnly` cookie over plain HTTP. Anyone who can observe the network path can read it; a reverse proxy or a virtual network is the answer for anything beyond trusted networks.
- **The published posture is IPv4 only.** `0.0.0.0` is the IPv4 wildcard, so a dual-stack machine is reachable on its IPv4 addresses and not on its IPv6 ones, and `detectLanAddress()` never returns an IPv6 address. The grammar admits the IPv6 loopback spellings `::1` and `[::1]`, which bind this machine alone; no other IPv6 literal is accepted.
- **The shipped default moves with the release.** A machine that has never stated a host adopts whatever posture the release it starts ships, because the row writes no line of its own; stating `host` in the profile patch, or saving one on the settings page, is the only pin.
- **Ranking is by interface name, not by route.** Bridges and tunnels are demoted, but among interfaces that rank alike the operating system's enumeration order decides. The selection is an exported helper rather than part of the bind decision, so an operator who cares which network is published sets `host` explicitly.
- **The interface name is the only signal.** There is no platform I/O behind this table — no route lookup, no sysfs or WMI reading of the interface type — so a name the table does not carry is treated as a LAN interface: a bridge an operator renamed, a virtualization product with its own grammar (Parallels `enp*`/`vnic*`, say), or a platform whose switch names are not `virbr*`/`vmnet*`/`vEthernet*` ranks with the physical interfaces and may win the bind, bounded by the fact that a demoted address is still bound when nothing else exists, and by `host` stating the choice outright.
- **The trust fence is not an authentication layer.** It refuses cross-site and DNS-rebinding requests; the token is the authentication.

### Dev Note

#### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. Every host the row resolves without reading this machine — the flag, the composed config, and the shipped default — is pinned through the explicit resolution inputs, so the cases do not depend on the machine the tests run on, and the posture cases assert that a start creating a token writes nothing else under the harness home.

#### Tests

`tests/lan-access.spec.ts` stubs `DSH_HOME` per case and observes token creation, reuse, and refusal on the filesystem. `tests/lan-access-posture.spec.ts` drives the shipped posture: that no stated host binds `0.0.0.0` and writes nothing, that a stated host is taken as written, that `--host` outranks the row config, that an empty value is unstated, and what the startup warning says.
