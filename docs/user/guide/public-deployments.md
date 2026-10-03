# Deploy the Web UI: exposure and trust boundaries

English | [中文](public-deployments.zh.md)

`dsh --profile web` binds a network address by default — this machine's LAN address — so a phone, a tablet, or another computer on the same network opens the Web UI without any configuration. This page states what that default exposes, what a deployment adds in front of it, and which parts of the boundary remain the deployer's. The [Web app reference](../../../packages/bundle/web-app/README.md#public-deployments) owns the `--public-url` and `--trusted-host` command-line contract and the `publicUrl` and `trustedHosts` fields, and the [lan-access reference](../../../packages/host/lan-access/README.md) owns the bind-address row.

## What the default exposes

The server binds one address rather than every interface: the first interface carrying a network of its own, with container bridges (`docker0`, `br-<id>`), veth pairs, hypervisor switches, and tunnels ranked last, and loopback as the fallback on a machine that carries no network of its own. Only the bound address answers, so the machine's own loopback does not reach a LAN-bound server, and every interface left unbound keeps its loopback-only posture. The command line still refuses `--host 0.0.0.0`; binding every interface is a `host: 0.0.0.0` configured on the `lan-access` row.

The bind decides reachability: every device that can route to that address reaches the listening port. Authentication is the persistent access token, required for every non-loopback bind and resolved from `$DSH_HOME/access-token` — written `0600`, created on the first start, overridable with `DSH_ACCESS_TOKEN`; a harness home that cannot be written refuses the bind rather than listening unauthenticated.

The token is a process credential, not a per-user one. It appears once in the URL the server prints, and the page exchanges it for a signed browser cookie that is `HttpOnly` and `SameSite=Strict` without `Secure`, so both travel over plain HTTP. Anyone who can observe the network path reads the token or the cookie and then acts as that browser. What such a client reaches is the process's authority: the agent's workspace, shell, and files on this machine.

## Choose a posture

- **Treat the LAN as trusted.** Leave the default and accept that every device able to route to the bound address is an operator of this process. The harness cannot tell those devices apart, so this is a statement about the network rather than a control it enforces.
- **Put something in front.** Terminate TLS at a reverse proxy, or join the server to a virtual network that decides who can reach the port. That layer is where peer and user restriction can exist, because this one provides none.

## Behind a reverse proxy

A reverse proxy in front of the listener owns the external leg — the public host name, TLS, and the path prefix it strips before forwarding — and `--public-url` tells DSH which address browsers use:

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

### What `--public-url` advertises

`--public-url` accepts an `http://` or `https://` root with an optional mount prefix and normalizes it to end in `/`. It supplies the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. The webserver keeps serving origin-root routes and never learns the mount. The `publicUrl` config field publishes the same advertisement.

### What the proxy must do

- **Preserve the browser-facing `Host`.** The fence compares the received `Host` against the accepted authorities, so the proxy forwards it unchanged instead of rewriting it to the listener's address.
- **Strip the mount prefix.** The listener answers origin-root routes, so a request for `/ui/api/...` must arrive as `/api/...`.
- **Forward upgrades.** Every request and WebSocket upgrade the page opens must reach the listener with its `Upgrade` and `Connection` headers intact; TLS terminates on the proxy's external leg when it serves HTTPS.
- **Rewrite cookie scope.** The backend always issues host-only `Path=/` cookies without `Secure`; the proxy rewrites `Path` to the mount (`/ui/`) and adds `Secure` on its HTTPS leg.
- **Redirect the bare mount.** `/ui/` is the only entry: it alone exchanges the launch token for the session cookie, and it or `/ui/index.html` serves the document to a browser that already holds that cookie, because the served document resolves URLs against its own directory. A request to `/ui` must arrive as `/ui/`, and the stripped backend cannot reconstruct that external path.

### Trust the authority browsers use

The fence accepts loopback plus every authority `--trusted-host` names. A browser that reaches the deployment under any other authority gets 403 for every API call, however correct the proxy is, so name the browser-visible authority with `--trusted-host`; advertising it with `--public-url` is display only and does not admit it. An entry without a port matches any port, which suits a tunnel that binds a different one each time. The fence only admits the request; the launch token in the printed URL and the signed session cookie authenticate it.

Neither the advertised URL nor the fence protects the listening port itself, so restrict the port to the trusted proxy or network.

## What stays the deployment's job

- **TLS termination.** The listener serves plain HTTP and terminates no TLS.
- **`Secure` and HSTS.** No cookie carries `Secure` and no response carries an HSTS header, so nothing here protects or upgrades the browser's leg.
- **A peer allow-list.** Every connection that reaches the port is served; restricting source addresses belongs to the network or to the proxy.
- **Per-user identity and a second factor.** One token authenticates a browser as the process, and there are no accounts that distinguish users.
- **Authentication by the fence.** The Host/Origin fence refuses cross-site and DNS-rebinding requests; the token is the authentication.

## When plain HTTP is acceptable

The token and the session cookie cross the network in cleartext, so what is acceptable follows from the network they cross rather than from the harness.

- **A network you control** is the intended posture: the cleartext leg ends where that network ends, and every device on it could already reach the port.
- **A network you do not control end to end** is not: an untrusted WLAN, a shared segment, or a port forwarded through a router puts the credential in front of anyone observing that path.

Terminating TLS in a proxy, carrying the connection over a VPN or overlay network, and not exposing the port are the three answers.

## Reach it without exposing it

For work that never needs another device, return the row to loopback with `host: 127.0.0.1` and forward a port over SSH: `ssh -L 3080:127.0.0.1:3080 host`. A loopback posture forwards the loopback endpoint, and the `127.0.0.1:3080` authority the browser then uses is one the fence accepts. With the default still in place, the forward must name the address the server bound instead, and the browser keeps the loopback URL with the token from the printed line.
