# Deploy the Web UI: exposure and trust boundaries

English | [中文](public-deployments.zh.md)

`dsh --profile web` publishes a network address by default — every IPv4 interface this machine holds — so a phone, a tablet, or another computer on any attached network opens the Web UI without any configuration. The posture comes from the `lan-access` row the Web bundle patch mounts by default: every binding decision lives in that row, from its own schema default `0.0.0.0` to the persistent access token a reachable bind requires, and no start writes any of it into the profile. That leaves the carrier as thin as it can be — `dsh-host-webserver` accepts any non-empty listen address and judges no address grammar of its own, while the row owns the grammar, the token, and the startup warning. This page states what that default exposes, what a deployment adds in front of it, and which parts of the boundary remain the deployer's. The [Web app reference](../../../packages/bundle/web-app/README.md#public-deployments) owns the `--public-url`, `--trusted-host`, and `--tls-cert`/`--tls-key` command-line contract and the `publicUrl` field, and the [lan-access reference](../../../packages/host/lan-access/README.md) owns the bind-address row — including the line the General Settings page's Listen address row saves.

## What the default exposes

The server publishes every IPv4 interface this machine holds, because `0.0.0.0` is the `lan-access` row's schema default, and the Web bundle patch mounts that row by default: the row writes that value into no file, and the profile patch stays untouched, so the posture an operator never stated is the one the running release ships. (Writing the line was tried and reverted, because the Loader reconciles a changed config entry and the web server that reads `ctx.lanAccess.host` re-binds on a new port while the URL this start already printed goes stale.) Container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches, and tunnels are published with the rest, and `0.0.0.0` is the IPv4 wildcard, so nothing listens over IPv6. `--host 0.0.0.0` is accepted and reaches the same bind; deleting the row's `host` key makes the next start fall back to that built-in default. A narrower posture is a stated host: `host: 127.0.0.1` for loopback only, or one network's own address for that network alone. A stated host is validated before the bind, so one this row cannot bind — a hostname, or a non-loopback IPv6 literal such as `--host ::` — fails the start instead of binding an address the trust fence then refuses every request on.

The bind decides reachability: every device that can route to any published address reaches the listening port. Authentication is the persistent access token, required for every non-loopback bind and resolved from `$DSH_HOME/access-token` — written `0600`, created on the first start, overridable with `DSH_ACCESS_TOKEN`; a harness home that cannot be written refuses the bind rather than listening unauthenticated, so a read-only `DSH_HOME` that used to start under a loopback default can now stop the start. Every non-loopback bind also writes one warning into the startup log, naming the bound address, the token as the only authenticator, and the two ways back to a narrower posture; that warning carries no credential, and no browser banner asks for confirmation.

The startup line names what this bind published: the application URL and, beside it, the best-ranked LAN address whenever the bind carries more than one — `dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)`. The `lan-access` row both ranks that list (container bridges and tunnels last, link-local `169.254.*` dropped) and publishes the fence's authorities: every literal this bind publishes plus the `--trusted-host` names the invocation stated. A narrower bind — loopback, or one network's own address — prints no LAN link, because its own URL already carries the address.

The token is a process credential, not a per-user one. It appears once in the URL the server prints, and the page exchanges it for a signed browser cookie that is `HttpOnly` and `SameSite=Strict` without `Secure`, so both travel over plain HTTP. Anyone who can observe the network path reads the token or the cookie and then acts as that browser. What such a client reaches is the process's authority: the agent's workspace, shell, and files on this machine.

## Choose a posture

- **Treat the network as trusted.** Leave the default and accept that every device able to route to any published address is an operator of this process. The harness cannot tell those devices apart, so this is a statement about the networks the machine is attached to rather than a control it enforces.
- **Put something in front.** Terminate TLS at a reverse proxy, or join the server to a virtual network that decides who can reach the port. That layer is where peer and user restriction can exist, because this one provides none.

### Change the posture without editing a file

The General Settings page's **Listen address** row names what the running process bound beside what the profile persists, and saves the address the next start should bind — the `host` key in the profile's `cordis.patch.yml`, the only place a posture is recorded. The save is that one line and nothing else: the running server keeps the address it bound, the printed URL keeps naming it, no listener is rebound, and the access token a non-loopback start needs is created by the start that binds it rather than by the save. The bind host grammar is the lan-access row's own, and one authority — `classifyBindHost` — answers for the settings page, `--host`, and the row's `host` key alike: a loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`), the `0.0.0.0` wildcard, or one IPv4 literal. A hostname and every other IPv6 literal, a non-loopback one such as `::` included, is refused instead of being persisted as a posture that cannot start; the rejection is the same one a hand-edit would earn on the next start, moved to where it can still be corrected. It states `0.0.0.0`'s meaning beside the field: every IPv4 interface, container bridges included, and no IPv6 listener. When the invocation names `--host`, the row says the save is stored and takes effect once that flag is removed, because `--host` outranks the stored line.

## Behind a reverse proxy

The default bind already serves the LAN, so a proxy is needed only for an external host name, a TLS leg, or a path prefix. A reverse proxy in front of the listener owns that external leg — the public host name, TLS, and the path prefix it strips before forwarding — and `--public-url` tells DSH which address browsers use:

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

### What `--public-url` advertises

`--public-url` accepts an `http://` or `https://` root with an optional mount prefix and normalizes it to end in `/`. It supplies the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. The webserver keeps serving origin-root routes and never learns the mount. The `publicUrl` config field publishes the same advertisement.

### What the proxy must do

- **Preserve the browser-facing `Host`.** The fence compares the received `Host` against the accepted authorities, so the proxy forwards it unchanged instead of rewriting it to the listener's address.
- **Strip the mount prefix.** The listener answers origin-root routes, so a request for `/ui/api/...` must arrive as `/api/...`.
- **Forward upgrades.** Every request and WebSocket upgrade the page opens must reach the listener with its `Upgrade` and `Connection` headers intact; TLS terminates on the proxy's external leg when it serves HTTPS.
- **Rewrite cookie scope.** A backend serving plain HTTP issues host-only `Path=/` cookies without `Secure`; the proxy then rewrites `Path` to the mount (`/ui/`) and adds `Secure` on its HTTPS leg. A backend listener serving its own TLS already marks the cookie `Secure`, so the proxy only rewrites `Path`.
- **Redirect the bare mount.** `/ui/` is the only entry: it alone exchanges the launch token for the session cookie, and it or `/ui/index.html` serves the document to a browser that already holds that cookie, because the served document resolves URLs against its own directory. A request to `/ui` must arrive as `/ui/`, and the stripped backend cannot reconstruct that external path.

### Trust the authority browsers use

The fence accepts loopback, the listener's own bind address, and every authority `--trusted-host` names. A browser that reaches the deployment under any other authority gets 403 for every API call, however correct the proxy is, so name the browser-visible authority with `--trusted-host`; advertising it with `--public-url` is display only and does not admit it. An entry without a port matches any port, which suits a tunnel that binds a different one each time. The fence only admits the request; the launch token in the printed URL and the signed session cookie authenticate it. TLS, wherever it terminates, changes none of this: the certificate identifies the server to the browser, not the browser to the server.

Neither the advertised URL nor the fence protects the listening port itself, so restrict the port to the trusted proxy or network.

## Secure the external leg

Terminate TLS at the proxy, on the listener itself, or on both; `--public-url` remains an advertisement. An `http://` browser-facing root exposes the launch token in plaintext. An `https://` proxy root protects the browser-to-proxy leg; encryption between proxy and listener depends on the listener's TLS configuration.

To terminate on the listener, pass `--tls-cert` and `--tls-key`, each a path resolved against the process working directory: the certificate file holds the full chain and the key file an unencrypted PEM private key. DSH never obtains, renews, or watches certificates, and the carrier reads the files once, so replace them and reload the listener or restart the process to change them; startup fails on a missing or invalid pair and never falls back to HTTP. The browser applies its own trust store and name checks, so the certificate must cover the hostname or IP you open. The default port stays 3080. Native TLS needs no proxy, but proxy deployments and `--public-url` remain supported independently. A TLS listener marks session cookies `Secure`; keep the public browser-facing leg HTTPS so browsers can return those cookies.

The printed URL carries a process credential, so share it only with intended users.

## Containers and addresses that move

A container publishes a mapped port (`docker run -p 3080:3080 ...`), so the process sees only the container's own interfaces — usually a `172.x` literal — while the host and every phone on the network reach it under the host's own address. That authority is in no derived entry, so the server is healthy, the static page loads, and then every `/api` request answers 403: the client reports that it cannot connect rather than showing a rejection. Name the authority browsers use at startup:

```sh
dsh web --host 0.0.0.0 --trusted-host 192.168.1.20:3080
```

A reverse proxy's public host name and an internal DNS name need the same declaration, and a port-less entry covers any port. Declaring an authority widens only the Host check: the session cookie stays bound to the normalized `host:port` it was issued for, and the access token is unchanged.

The derived entries are one sample taken at startup and never re-derived, so a new DHCP lease, a VPN that changes the route in, or a new bridge changes the literal browsers type while the fence keeps the old one. When that literal changes, restart the server and declare the new authority; the fence notices nothing on its own.

## What stays the deployment's job

- **Certificates.** A TLS listener serves the certificate and key it was given, and DSH never obtains, renews, or watches a certificate; the identity the browser checks is the deployment's.
- **`Secure` and HSTS.** A TLS listener marks the session cookie `Secure` and a plain-HTTP one does not; no response carries an HSTS header, so upgrading the browser's leg stays with the deployment.
- **A peer allow-list.** Every connection that reaches the port is served; restricting source addresses belongs to the network or to the proxy.
- **Per-user identity and a second factor.** One token authenticates a browser as the process, and there are no accounts that distinguish users.
- **Authentication by the fence.** The Host/Origin fence refuses cross-site and DNS-rebinding requests; the token is the authentication.

## When plain HTTP is acceptable

The token and the session cookie cross the network in cleartext, so what is acceptable follows from the network they cross rather than from the harness.

- **A network you control** is the intended posture: the cleartext leg ends where that network ends, and every device on it could already reach the port.
- **A network you do not control end to end** is not: an untrusted WLAN, a shared segment, or a port forwarded through a router puts the credential in front of anyone observing that path.

Terminating TLS in a proxy or on the listener, carrying the connection over a VPN or overlay network, and not exposing the port are the answers.

## Reach it without exposing it

For work that never needs another device, return the row to loopback — `host: 127.0.0.1`, or the same address saved from the General Settings page's Listen address row — and forward a port over SSH: `ssh -L 3080:127.0.0.1:3080 host`. A loopback posture forwards the loopback endpoint, and the `127.0.0.1:3080` authority the browser then uses is one the fence accepts. The shipped default answers on loopback as well, because `0.0.0.0` covers it, so that forward reaches the server before the row is narrowed; the printed line keeps the loopback URL and adds the LAN one beside it.

The [Web app reference](../../../packages/bundle/web-app/README.md#public-deployments) documents the `--public-url`, `--trusted-host`, and `--tls-cert`/`--tls-key` command-line options. In the Web profile, `publicUrl` configures the `web-runtime` row, the [Connection row](../../../packages/client/connection/README.md)'s `trustedHosts` is `ctx.lanAccess.trustedHosts` — this bind's own literals plus `--trusted-host` — and `tls` configures the [webserver row](../../../docs/subsystems/web-server.md#config).
