# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: a single `node:http` plugin providing `ctx.webServer`, a named-route registry, optional gzip response compression, index.html transform callbacks, and one fallback handler that a plugin may claim. It is not part of the agent loop and not a capability seam; it knows no harness concepts, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering reference](../../packages/boot/app-boot/README.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. The shipped Web composition claims the seat with [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts), the SPA dist server with locked semantics: Connection authenticates the dist root and configured index before their HTML is read; non-index assets remain public; non-GET/HEAD is 405, traversal outside the dist root is 403, existing files are served directly, absent or non-file targets are empty 404 responses, and unknown extensions ship as octet-stream.

## Config

```ts type-equiv
/** Web server listen and response-compression config. */
interface Config {
  /**
   * Listen host. `127.0.0.1` (the default posture) is loopback only; `0.0.0.0`
   * is every interface; any other address binds that one local address, which
   * is how a host exposes itself on a single network without listening on the
   * others. The server carries no TLS, authentication, or origin policy of its
   * own, so a reachable bind is the caller's security decision. The composing
   * `lan-access` row decides this value, and its `classifyBindHost` is the one
   * authority on the grammar the value has to be in (a loopback spelling, the
   * `0.0.0.0` wildcard, or one IPv4 literal); this package only hands the
   * string to `listen`, judges no grammar of its own, and accepts any non-empty
   * string the caller states.
   */
  host: string
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Response compression for socket-backed HTTP requests. @default 'none' */
  compression?: 'none' | 'gzip'
  /** Gzip DEFLATE level from 0 through 9. @default 1 */
  compressionLevel?: number
  /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
  compressionThresholdBytes?: number
}
```

`host` accepts any non-empty listen address; the shipped rows use `127.0.0.1` for loopback only and `0.0.0.0` for every IPv4 interface. The carrier itself owns no TLS, authentication, or Origin policy, so a non-loopback bind exposes the server unless the composition supplies those controls. `compression` defaults to `none`; the shipped Web bundle selects gzip level 1 with a 1024-byte threshold. The shipped `dsh web` command takes its host from the `lan-access` row — `--host` first, then the composed row config, and otherwise that row's own `0.0.0.0` default, which it writes nowhere — and so publishes every IPv4 interface unless an operator states otherwise; its Connection plugin supplies Host/Origin checks plus browser-session authentication for every Host API route and stream. The General Settings page's Listen address row is the other way an operator states one: it writes the same persisted line into the profile patch through `ctx.remote.webHost` and takes effect on the next start, with the address this process bound shown beside it until then. Other compositions own their bind and route-authentication policy. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. Gzip wraps eligible socket-backed responses inside the server, so route handlers retain direct `ServerResponse` ownership and no response-writing API is added to the service. Existing content encodings, `Cache-Control: no-transform`, ranges, SSE, ZIP, and the packaged `.gz` Worker image remain identity responses. `collectIndexInjections()` gathers structured `IndexInjection` rows over one `webserver/index-inject` emit, and `renderIndex(html)` renders them into successful root and configured index responses before applying the raw `tapIndex(transform)` escape-hatch transforms in registration order; [dsh-client-modules](../../packages/client/modules) answers the event with the boot manifest rows. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnection--hostconnectionhandle"></a>

### `ctx.connection` — `HostConnectionHandle`

Host `ctx.connection` members consumed by transport-independent adapters.

```ts cordis-catalog
/**
 * Compose exact Fetch routes and the shared-channel RPC interceptor.
 * @param channel - shared channel mounted by Connection.
 * @returns Fetch handler for trusted, authenticated requests.
 */
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

/**
 * Apply Connection's Host/Origin checks and browser authentication to
 * another Web route.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns rejection status, or undefined when the route may accept the request.
 */
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

/**
 * Admit one request: it passes {@link requestRejection} and speaks for the
 * operator, or it is refused with that status.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns the operator Peer, or the rejection status.
 */
admit(request: ConnectionTrustRequest): PeerAdmission

/**
 * Authenticate one frontend index request, owning a token redirect or 401.
 * @param request - root or configured-index HTTP request.
 * @param response - response owned when the result is false.
 * @returns true only when the frontend may serve index.html.
 */
authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

/**
 * Add the fresh process token to an ordinary Web application URL.
 * @param baseUrl - clean application URL whose authority and mount are preserved.
 * @returns tokenized URL for initial login; a mount proxy strips its prefix before {@link authorizeIndex}.
 */
authenticatedUrl(baseUrl: string): string
```

Source: [`packages/client/connection/src/rpc.ts`](../../packages/client/connection/src/rpc.ts)

<a id="ctxlanaccess--lanaccessvalues"></a>

### `ctx.lanAccess` — `LanAccessValues`

What this row publishes through LAN_ACCESS_SERVICE.

Source: [`packages/host/lan-access/src/index.ts`](../../packages/host/lan-access/src/index.ts)

<a id="ctxwebhostcontroller--webhostcontroller"></a>

### `ctx.webHostController` — `WebHostController`

Host service backing the generated `ctx.remote.webHost` namespace: the read side reports each fact that decides the next start's bind address separately — what this process bound, what the profile persists, what the invocation pinned, what this machine detects — and the write side persists an operator's address into the profile patch.

The namespace mounts whether or not a lan-access row is composed: the page must be able to render the posture and to receive the actionable refusal, not a missing-namespace failure.

```ts cordis-catalog
/**
 * Describe the bind-host posture: every layered fact a page shows beside the
 * field, so the operator sees what a save will change and what nothing here
 * can change (`--host` is resolved at startup, and the running bind is not
 * this page's to move).
 * @returns the posture; absent facts are omitted rather than sent as `undefined`.
 */
@Remote status(): WebHostStatusValue

/**
 * Persist one bind host for the next start.
 *
 * The write is one row of the profile's own patch, merged with the config
 * that row already states, so the address this page owns is the only key it
 * changes. Nothing else follows from it: no Loader reconcile, no rebind, no
 * token resolution, no URL rewrite. A non-loopback address therefore persists
 * without creating the access token the next start will demand, which keeps
 * this call free of side effects on the running harness.
 *
 * @param host - the address to bind on the next start: an IPv4 literal or a loopback name.
 * @returns the posture after the write: `persisted` is the line just written when the
 *   composed row reads it back, and absent when no row in this profile does.
 * @throws RemoteError when the address is not one this row can bind, this deployment
 *   has no profile patch, or the patch cannot be written.
 */
@Remote async save(host: string): Promise<WebHostStatusValue>
```

Source: [`packages/api/settings-controller/src/web-host.ts`](../../packages/api/settings-controller/src/web-host.ts)

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string

/**
 * Gather the structured injection table: one `webserver/index-inject` emit,
 * every subscriber pushes its current rows. Fresh per call, so subscribers
 * read live state (module graph, theme preference) at emit time.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(): IndexInjection[]

/**
 * Render one index.html body: the structured injection table first, then
 * the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
renderIndex(html: string): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="connection-events"></a>

### `connection/*` events

<a id="connectionrequest--waterfall"></a>

#### `connection/request` — waterfall

Admit or wrap an authenticated shared API request, including body transfer. Existing requests continue when a listener refuses subsequent requests.

```ts cordis-catalog
/**
 * Admit or wrap an authenticated shared API request, including body transfer.
 * Existing requests continue when a listener refuses subsequent requests.
 * @param request - Authenticated incoming HTTP request.
 * @param response - Response owned until the delegated bridge settles.
 * @param next - Delegate to the next listener or the shared API bridge.
 * @mode waterfall
 */
'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
```

Source: [`packages/client/connection/src/index.ts`](../../packages/client/connection/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table. Emitted on every index
 * render and every worker boot-payload request; listeners push their
 * current rows, so a row's data is read fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[]): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
