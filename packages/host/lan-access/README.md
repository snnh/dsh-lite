---
description: "Opt-in network exposure for the DeepSeek Harness web server: one row decides the bind host, and a network-reachable bind requires a persistent access token."
kind: "bundle-row"
---

# @deepseek-ai/dsh-host-lan-access

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-lan-access` is the switch that decides whether the web server binds loopback or every interface. The web bundle reads its bind host from this row through `ctx.get`, so a tree that mounts the row with its default configuration behaves exactly like one without it. Setting the row's `host` to `0.0.0.0` exposes the harness to every network the machine is attached to — and a network-reachable bind requires a token that outlives the process, which this row resolves (creating one when the harness home has none) before the service is provided. Returning to loopback is changing that value back or deleting the row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Exposing the harness on the local network

Change the row's host in the bundle patch, or override it from an overlay:

```yaml
- id: lan-access
  name: '@deepseek-ai/dsh-host-lan-access'
  config:
    host: 0.0.0.0
```

The printed line then carries a LAN address next to the loopback one:

```
dsh web: http://127.0.0.1:3080/?token=… (LAN: http://192.168.1.5:3080/?token=…)
```

### Returning to loopback

Set `host` back to `127.0.0.1`, or delete the row entirely. The web bundle reads the value with `ctx.get`, so an absent row leaves its own loopback default in place.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | The address the web server binds |

## Understand the implementation

### Why this is a row rather than a flag

The command line refuses `--host 0.0.0.0`, because a flag is a per-invocation decision an operator can make without revisiting the posture they are choosing. A configuration row is a stated posture: it lives in the tree, it can be reviewed, and removing it is a revert. The row also owns the one precondition that makes exposure safe — the persistent token — so the posture and its requirement cannot drift apart.

### What the refusal covers

A loopback bind is reachable only from this machine, so the row provides the service without touching the token: the connection half already applies process-local authentication. Every other bind is reachable by anything that can route to the host, so the row resolves the persistent token first. A token that cannot be established — a harness home that cannot be written, a configured value below the length floor — rejects the row, so no web server binds a network address it could not authenticate.

## Further Exploration

- `@deepseek-ai/dsh-client-connection` exchanges the token for the signed browser cookie and owns the Host/Origin fence.
- `@deepseek-ai/dsh-web-app` samples the LAN address into the trust fence and prints the LAN link.

## Known Limitations and Deferred Work

- **No TLS, no `Secure` cookie, no HSTS.** The token travels once in the printed URL, then becomes an `HttpOnly` cookie over plain HTTP. Exposure beyond a trusted network is expected to go through a reverse proxy or a virtual network.
- **`0.0.0.0` means every interface.** There is no per-interface selection and no peer allow-list: the row admits the bind, and the token is what keeps unauthenticated requests out.
- **The trust fence is not an authentication layer.** It refuses cross-site and DNS-rebinding requests; the token is the authentication.

## Dev Note

### Coverage

`packages/*/*/src` carries a per-file 100% statement, branch, and function gate. The row's four paths — default loopback, explicit loopback, admitted network bind, refused network bind — are each pinned by a case in `tests/lan-access.spec.ts`, which drives the row against a private temporary harness home.

### Tests

The spec stubs `DSH_HOME` per case, so token creation, reuse, and refusal are all observed on the filesystem rather than assumed.
