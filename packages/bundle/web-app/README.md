---
description: "The browser GUI for dsh: interactive chat, model and settings management, and session history, for users running the dsh web surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

English | [中文](README.zh.md)

Desktop analytics follows the [product collection policy](../../client/product-analytics/README.md), including its live application setting. Web usage is excluded.

Desktop analytics schedules partial batches every 30 seconds, with a 15-second exporter timeout and a 20-second processor timeout. Shutdown allows 2 seconds to drain, then cancels pending requests and retry waits so telemetry does not keep the Host alive. Pending events may be lost on exit.

## Summary

Run `dsh --profile web` for browser chat, model and settings management, and session history, with the same model access, tools, and safety defaults as other surfaces. Startup prints a tokenized URL and opens the default browser; SSH sessions and `--no-open` need manual opening. Change the port and listen address — the shipped posture publishes every IPv4 interface, and the General Settings page's Listen address row saves a narrower one — allow extra authorities, and serve HTTPS from your own certificate. Remote access uses an advertised HTTP(S) URL, listener TLS, or plain HTTP on a non-loopback bind, authenticated by the token.

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

Start the GUI, open your browser, and start talking to the agent. The flags fine-tune the invocation.

### Starting the Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

After startup you see a `dsh web:` line whose root URL carries a fresh process token. Unless `--no-open` or an SSH session suppresses it, the default browser opens that URL, receives a signed cookie, and redirects to the same directory without the token. You know it worked when the page loads and you can chat with the agent. Two failures to expect: if the frontend is not built, startup stops with a build hint (`pnpm run build` in a checkout); if the browser cannot be opened, a credential-free diagnostic prints to stderr while the server keeps running — open the printed startup URL yourself.

**Settings → Models** displays **DeepSeek**, using `DEEPSEEK_API_KEY`. The default is `deepseek-official` / `deepseek-flash` (DeepSeek-V4.1-Flash). The [DeepSeek plugin](../../llm/llm-deepseek/README.md#endpoint-and-wire-format) uses the Messages API.

Saved model selections override the composition default. The settings card accepts a Messages-compatible API address and a credential reference.

### Configuration

`--host` and `--port` configure the listener; `--tls-cert` and `--tls-key` make it serve HTTPS; `--public-url` names the advertised public HTTP(S) root the GUI is reached at behind a prefix-stripping proxy, and `--trusted-host` adds further accepted authorities. All are described under [Listening, trust, and public deployments](#public-deployments), and the `tls` field those flags set is documented with the [carrier's config](../../../docs/subsystems/web-server.md#config):

| Field | Default | Meaning |
|---|---|---|
| `openBrowser` | `true` | Open the default browser after startup; SSH launches suppress it |
| `printUrl` | `true` | Print the `dsh web:` URL line at startup |
| `surfaceContext` | `true` | Give the agent GUI-orientation context and expose `DSH_WEB_URL` to its shell commands |
| `publicUrl` | Unset | Advertised HTTP(S) application root; otherwise announce the bind-address URL |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) lists this runtime plugin's accepted fields and their JSDoc. The shipped composition inserts the `schedule` service row and the `ui-schedule` task page row, while the clock reading and the four reminder tools belong to the `standard`, `cordis`, and `ptc` presets. The `tool-subagent` and `tool-subagent-fork` rows in those presets deny the four tools, so a delegated child's scope never lists them.

<a id="public-deployments"></a>
### Listening, trust, and public deployments

By default the GUI publishes every IPv4 interface this machine holds: the shipped `lan-access` row resolves to its own schema default `0.0.0.0` and writes no file, so a later release changing that default moves a machine that has never stated a host. Every attached network reaches it, container bridges included, and no IPv6 interface is published; `host: 127.0.0.1` on that row restores loopback-only, and one network's own address publishes just that network. `--host` outranks the row's composed config for a single run, `--host 0.0.0.0` included. That row's one grammar authority, `classifyBindHost` ([why it, and not this carrier, owns the grammar](../../../.agents/notes/implemented/architecture/2026-10-09-lan-exposure-policy-plugin.md)), accepts any loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`, a mapped literal such as `::ffff:127.0.0.1`, or any other address in 127/8), the `0.0.0.0` wildcard, or one IPv4 literal, and anything else — a hostname other than `localhost`, a non-loopback IPv6 literal such as `::` — fails the start instead of falling back to the shipped posture. A non-loopback bind serves plain HTTP unless `--tls-cert`/`--tls-key` supply a certificate, requires the persistent access token, and writes one exposure warning into the startup log, even when an HTTPS `--public-url` fronts it. Repeatable `--trusted-host` adds the authorities the `/api` Host/Origin fence accepts, so a remote browser reaches the GUI behind a prefix-stripping proxy or through a port-forwarding client that presents a trusted hostname; the fence accepts the listener's own bind IP without that flag. A container whose port is published with `-p` sees only its own interfaces, so the host-reachable authority the browser actually types must be declared that way too, because no derived entry can name it. The token exchange and signed session cookie authenticate every API method and WebSocket stream.

The same posture can be changed without editing a file: the General Settings page's **Listen address** row shows what this process bound beside what the profile persists, and saving one writes the profile patch alone. A save therefore takes effect on the next start, not immediately, and a non-loopback address saved there is just a request — the persistent access token it needs is created by the start that binds it. The row accepts what the `lan-access` row can bind, judged by that row's one grammar authority, `classifyBindHost`: any loopback spelling (`127.0.0.1`, `localhost`, `::1`, `[::1]`, mapped literals, a zone, the rest of 127/8), the `0.0.0.0` wildcard, or one IPv4 literal. A hostname and a non-loopback IPv6 literal are refused rather than persisted as a posture that cannot start, and the same grammar decides what `--host` may state at startup. The [lan-access reference](../../host/lan-access/README.md#saving-an-address-from-the-settings-page) owns that contract, and the [settings controller](../../api/settings-controller/README.md) owns the namespace behind it.

Pass `--tls-cert` and `--tls-key` together to serve HTTPS from the listener instead of plain HTTP. Each names a file resolved against the process working directory: the certificate file holds the full chain and the key file an unencrypted PEM private key. The flags are one setting — supplying only one is a usage error, and supplying neither keeps the plain-HTTP default. Startup fails when a file is missing, unreadable, empty, or not a valid certificate-and-key pair; it never falls back to HTTP. Nothing re-reads the material while the listener runs, so serving a different certificate needs a listener reload or a process restart. DSH issues, renews, and watches nothing: there is no ACME client, no self-signed fallback, and no redirect listener. The browser applies its own trust store and host-name matching, so a certificate the browser does not trust, or one whose subject alternative names miss the authority you open, fails before the page loads. The default port stays 3080, and `--tls-cert`/`--tls-key` do not follow `--public-url`: the listener's certificate covers the authority browsers dial. TLS changes nothing about authority: Connection still authenticates every request and still checks Host/Origin, and the session cookie it mints is `Secure` whenever the receiving listener serves HTTPS.

A container can bind its Pod address and advertise the ingress that fronts it:

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` may list several addresses; `--host` takes one, so the command selects the first, which the shipped grammar accepts as an IPv4 literal. A zone-qualified spelling such as `fe80::1%eth0` is another matter: the `lan-access` row refuses it before the bind, and a composition that binds one anyway must advertise it explicitly, because a zone ID cannot appear in a URL — the advertised root drops a redundant loopback zone while a non-loopback zone requires an explicit `--public-url`.

Without `--public-url` the printed root is the bind address in URL form: the `0.0.0.0` posture prints the loopback literal `127.0.0.1`, because the wildcard is not an address a browser can open, while a bind that names one address advertises that address. IPv6 literals are bracketed, and a loopback spelling uses its canonical address text, so a mapped loopback bind such as `::ffff:127.0.0.1` advertises its IPv4 form `127.0.0.1` and the browser recognizes a local, trustworthy origin. A dotted-quad IPv6 tail names the address's own low 32 bits, exactly as `listen` reads it, so `::0.0.0.1` is IPv6 loopback and advertises `[::1]`, while `::127.0.0.1` is a non-loopback address, not IPv4 loopback. The listener keeps the configured bind address either way.

The URL line names the LAN address beside the application URL — `dsh web: <url> (LAN: <url>)` — whenever the exposure row published one, taking its best-ranked entry, so a peer on that network can open the same process; a bind that names one address adds no LAN link, because its own URL already carries the address. Both forms carry the token.

`--public-url` advertises the HTTP(S) root browsers use — the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. Advertisement grants no trust: the browser-visible authority must also be named with `--trusted-host`. The flag configures no listener, routing, or cookie scope, because the proxy owns the external leg: [Publish the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) lists what such a deployment must provide.

Neither the advertised URL nor the browser-trust fence protects the port itself, so restrict the port to the trusted proxy or network.

The printed URL contains a process credential; share it only with intended users. `printUrl: false` suppresses the line with or without `--public-url`, and the credential never appears in the model context or in `DSH_WEB_URL`.

### Running over SSH

When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Without an advertised root the printed URL names the remote host's bind-address endpoint — loopback for a loopback bind — which you reach through your forwarding address. With `--public-url` the printed URL is the authenticated advertised root; the browser handoff stays suppressed, because opening a browser on the remote host cannot reach your screen.

### Per-session agent setup

Each browser session selects a shipped preset (`standard` by default). The Agent presets settings page changes the default and edits preset child plugins; saves persist in `$DSH_HOME/profiles/web/cordis.patch.yml`. Creator's plugin-management tool is enabled only when the Host provides an editable profile.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch layer of five files plus one runtime glue plugin: `cordis.patch.yml` carries the host rows and the preset registry, and each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `dsh.bundle.patch` lists them. The storage stack and projection cache come from `dsh-base`; the web overlay's workspace and message-feedback rows consume that shared `storageDomain` service. The patch restates the surface-specific values the base deliberately omits, inserts the web-only host rows and browser roster, then moves the agent plane behind presets. The glue plugin owns dist serving, the advertised application URL, the plain-HTTP exposure warning, prompt sections, the bash variable, and the readiness announcements. The `office-to-pdf` row mounts one lazy [Office conversion provider](../../document/office-to-pdf/README.md) for Host consumers, including Desktop compositions using this bundle. The conversion service's Remote methods authorize preview reads, while Document Preview owns the Office viewer and Client cache.

### Patch semantics

A patch replaces the targeted row's whole `config`, so each web row restates every key it owns: the persona prefix template, the `DSH_TOOLS_MODE` PTC mode opt-in, and the `session-query-sqlite` values on the base rows, then `insert` adds the web host rows, transport, and browser roster. The `webserver`, `web-runtime`, and `lan-access` rows inject the `webStartup` provider and read their invocation values directly; the `connection` row instead takes the authorities the exposure row published, `ctx.lanAccess.trustedHosts`, while the Host/Origin fence accepts the listener's bind IP independently of that list. The per-agent tool rows the base mounts process-wide are disabled here and the preset roster takes over; the reasoning for each host-plane versus preset-plane decision is inline in the patch.

### Advertised application URL

Startup display and browser handoff receive the advertised root with its launch token; the web-surface prompt and `DSH_WEB_URL` receive it clean. The root itself is defined under [Listening, trust, and public deployments](#public-deployments).

### Readiness

The URL line and browser handoff are readiness signals: supervisors RPC as soon as they observe the line, and a browser requests the page as soon as it opens, so both run only after the Loader tree settles, the required-startup audit passes, and Connection authentication is available — or immediately in a hand-built tree without a Loader. Client combo JavaScript and source maps remain unmaterialized at this point. Optional plugin failures do not suppress readiness; a required startup failure or a tree disposed mid-boot announces nothing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `web-app` glue plugin: dist resolution, advertised application URL, prompt sections, bash variable, URL line, browser handoff |
| [`src/public-url.ts`](src/public-url.ts) | Advertised-root validation and trailing-slash normalization; a leaf module for local imports, not package API |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--tls-cert`, `--tls-key`, `--public-url`, `--trusted-host`, `--no-open`, `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The web patch: restated base values, web host rows, browser roster, preset registry |
| [`presets/`](presets) | One `@deepseek-ai/dsh-agent-preset` declaration per shipped preset (`standard`, `ptc`, `minimal`, `cordis`), each its own patch file |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | Dist index anchoring, advertised-URL publication and warnings, prompt sections, readiness publication |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/public-url.spec.ts`](tests/public-url.spec.ts) | Advertised-root parsing and normalization |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | Default-browser handoff after the page is reachable |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you want to go deeper into the shared core, the browser reload pipeline, or the built frontend.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the GUI runs on.
- [dsh-client-hmr](../../client/hmr/README.md) — how client-plugin changes reload during development.
- [frontend-static](../../host/frontend-static/README.md) — how the built frontend is served.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (first-party order 10100, after reusable instructions) orients the model to the GUI: the advertised application URL (defined under Listening, trust, and public deployments above), the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

Source and Web sections follow first-party reusable instructions. Different checkout paths or application URLs leave that preceding prefix unchanged when tools and configuration match; provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you what to expect in unusual setups — a source checkout, SSH sessions, or strict networks. They are current package constraints, not a general browser comparison or a task backlog.

- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **TLS is opt-in and unmanaged** — the listener serves HTTPS only when `--tls-cert` and `--tls-key` name a full chain and its unencrypted key; DSH never obtains, renews, or watches certificates, and a changed file needs a listener reload or a process restart. The browser must trust that certificate, its names must cover the authority you open, and the certificate is independent of `--public-url`.
- **Without TLS the external leg is plain HTTP** — protect it with a TLS-terminating proxy, and do not send the launch URL over a network you do not trust.
- **Only the handoff start is observable** — the GUI reports that the browser was asked to open, not that it actually opened; a later browser exit is never reported, and the printed URL is your manual fallback.
- **SSH sessions keep the URL but skip the browser handoff** — without an advertised root the printed URL names the remote host's bind-address endpoint (loopback for a loopback bind); the SSH client or editor must expose and open the local forwarded address.
- **`BROWSER` overrides only come from the environment** — a discovered `.env` cannot set `BROWSER`; only an inherited value can choose the executable for the automatic handoff.
- **The published bind is a stored posture, not a per-run choice** — no host means every IPv4 interface, from the `lan-access` row's schema default `0.0.0.0`, which no start writes anywhere; `host: 127.0.0.1`, the General Settings page's Listen address row, or `--host 127.0.0.1` is the way back to loopback, and only a line an operator stored (or one left in the profile patch) holds a posture against a later release changing its default.
- **A saved listen address applies on the next start** — the settings row writes the profile patch and nothing else, so the running server keeps the address it bound, the printed URL keeps naming it, and the persistent access token is created only by the start that binds a non-loopback address.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Web composition includes the account Remote controller and Account settings section.
