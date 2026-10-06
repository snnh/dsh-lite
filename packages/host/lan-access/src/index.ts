/**
 * Network exposure for the web server.
 *
 * The harness is most useful from the machine it runs on and from the other
 * machines on the same network — a phone, a tablet, another laptop. This row
 * therefore publishes every IPv4 interface this machine holds, and that is its
 * configuration default rather than something it writes anywhere. An operator
 * who wants the loopback-only posture states `host: 127.0.0.1`, and one who
 * wants a single network states that network's address.
 *
 * Nothing here writes to the profile. A row that persisted its own default
 * would edit the patch the Loader reconciles, and the entry's configuration
 * would change under it: the web server reads this host through its own
 * configuration, so the reconcile tears it down and binds it again on a new
 * port while the URL this start already printed stays on the old one. The
 * default composes; it does not accumulate files.
 *
 * The hosts this row can be told to bind, in the operator's order of authority:
 * `--host` from the invocation, then the composed row config — which is where
 * an operator's own choice lives, since the profile patch outranks every bundle
 * default — then the shipped default.
 *
 * `detectLanAddress()` answers which single address on this machine peers can
 * reach — the first interface that carries a network of its own — so the
 * settings page can offer it as one click beside loopback and the wildcard. It
 * is an offer, not a fallback: a row that states no host publishes every IPv4
 * interface. Docker bridges, veth
 * pairs, hypervisor switches, tunnels, and the wireless shims each platform
 * adds on top (macOS `awdl*`/`llw*`, a `bridge*` VM bridge, a Windows
 * `vEthernet`) are addresses a phone cannot reach and an operator did not mean,
 * and on a container host they are often reported *before* the physical
 * interface, so they rank last rather than winning by enumeration order. A
 * demoted address is ranked, never excluded: a machine whose only address is a
 * VPN interface still binds it.
 *
 * Every address this row publishes is IPv4: `0.0.0.0` is the IPv4 wildcard and
 * never an IPv6 listener, and `detectLanAddress()` reads IPv4 addresses only. A
 * host that wants IPv6 exposure needs a face this row does not provide.
 *
 * The hosts this row will bind are one closed grammar, classified in one place
 * ({@link classifyBindHost}): an IPv4 literal — `0.0.0.0` for every IPv4
 * interface, any address this machine holds, or `127.0.0.1` — or one of the
 * four loopback names `127.0.0.1`, `localhost`, `::1`, and `[::1]`. A shape
 * outside that grammar names no address this row can bind, and the value a
 * setting page shares the grammar with is refused before it is persisted. A
 * host the operator states that falls outside it — an unqualified hostname, a
 * non-loopback IPv6 literal such as `::` — is not settled to the shipped
 * posture: the start fails and states the grammar back, because a silent
 * fallback binds an address the operator did not ask for while the invocation
 * still reads as though it had been honoured.
 *
 * A reachable address is reachable by anyone who can route to it, so this row
 * refuses a bind it cannot authenticate: every non-loopback host requires the
 * persistent access token, which is resolved (and created when the harness home
 * has none) before the service is provided. The token is the only thing between
 * the network and remote code execution, so a host that cannot establish one
 * fails the boot instead of listening unauthenticated. A non-loopback bind also
 * warns once through the startup log — what is bound, what the token is, and
 * the two ways back to a narrower posture. It is a warning rather than a
 * prompt: exposure is a posture the operator states, not a question asked at
 * boot, and nothing here blocks the start.
 *
 * Returning to loopback is one line — `host: 127.0.0.1` in this row — and
 * removing the row entirely also works: the web bundle reads `lanAccess` through
 * its own `inject` declaration, so a tree without the row never binds a
 * network-reachable address.
 *
 * What this does not do: terminate TLS, set `Secure` on the cookie, or restrict
 * which network peers may connect. See the package README for the boundary.
 *
 * @module @deepseek-ai/dsh-host-lan-access
 */

import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ACCESS_TOKEN_FILENAME, ensureAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Stable Cordis plugin name. */
export const name = 'lan-access'

/** Service this row provides and the web bundle reads for its bind host. */
export const LAN_ACCESS_SERVICE = 'lanAccess'

/** The loopback literal every non-exposed posture binds. */
export const LOOPBACK_HOST = '127.0.0.1'

/** The IPv4 wildcard: every IPv4 interface this machine holds, and no IPv6 one. */
export const BIND_ALL_HOST = '0.0.0.0'

/**
 * The `webStartup` values this row reads. It narrows the web bundle's own
 * service to the one field a bind decision needs, so this package depends on
 * the service's shape rather than on the bundle that provides it.
 */
interface WebStartupHosts {
  /** `--host`, absent when the invocation did not name one. */
  readonly host?: string
}

/**
 * The one profile fact the exposure warning names: the patch file an operator
 * would edit to narrow the posture. A shape rather than the launcher's own type,
 * so this row depends on the service's surface and not on the package that
 * provides it.
 */
interface ProfilePatchRef {
  /** The profile patch an operator edits. */
  readonly patchPath?: string
}

/** Hosts that name this machine alone, in every spelling an operator may state. */
const LOOPBACK_HOSTS = new Set([LOOPBACK_HOST, 'localhost', '::1', '[::1]'])

/**
 * The longest bind host this grammar admits. `255.255.255.255` is 15
 * characters and `[::1]` is 5, so this bound refuses a value long before any
 * address could be read out of it; it never admits one on its own.
 */
const MAX_BIND_HOST_LENGTH = 45

/**
 * Interface-name prefixes that carry no LAN of their own: container bridges,
 * veth pairs, hypervisor switches, tunnels, and the wireless shims a platform
 * adds on top.
 *
 * These addresses are real, routable, and reachable — from inside the
 * container network and nowhere else. Binding one exposes the harness to the
 * wrong network and hides it from the one the operator meant, so they rank
 * last. They are never excluded: a machine whose only address is a VPN
 * interface still gets that address rather than no network at all.
 *
 * The list is the union of what the platforms name these interfaces, because a
 * name that is virtual on one is a name the others never mint — and the
 * desktop platforms this row serves are the ones it is written for. Linux
 * answers with `docker0`, `br-<id>`, `veth*`, `virbr*`, `tun*`, `tap*`, `wg*`,
 * and `zt*`; macOS with `bridge*` (its own `bridge0` VM bridge), `vmnet*`,
 * `utun*`, `awdl*` and `llw*` (AirDrop and the low-latency WLAN companion,
 * neither of which carries a routable LAN), and `tailscale*`; Windows with
 * `vEthernet (<switch>)` for every Hyper-V switch it holds. A platform whose
 * interface-name grammar this misses — a bridge an operator renamed, a
 * virtualization product not listed — falls through to the physical answer.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'br-', 'docker', 'veth', 'virbr', 'vmnet', 'vboxnet', 'tun', 'tap', 'utun', 'wg', 'zt', 'tailscale',
  'bridge', 'awdl', 'llw', 'vEthernet',
] as const

/** What this row publishes through {@link LAN_ACCESS_SERVICE}. */
export interface LanAccessValues {
  /** The host the web server should bind. */
  readonly host: string
}

/** Row configuration surface; see {@link Config.host} for the posture default. */
export interface Config {
  /**
   * Explicit bind host. Omit it to publish every IPv4 interface; that wildcard
   * is this row's default, not a value written anywhere. `127.0.0.1` restores
   * the loopback-only posture, and a single network's address publishes that
   * interface alone.
   */
  host?: string
}

/**
 * Row configuration. The shipped default publishes every IPv4 interface; an
 * operator states any other posture by naming it.
 *
 * The default is a schema default rather than a value this row writes at
 * startup, and that is what keeps a start's printed URL honest: a row that
 * edited the profile patch would make the Loader reconcile a changed entry, and
 * the web server — which reads this host through its own configuration — tears
 * down and binds again on a new port while the URL it already printed goes
 * stale.
 */
export const Config: z<Config> = z.object({
  host: z.string().default(BIND_ALL_HOST),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The bind host this row admitted. Absent when the row is not mounted, which
     * leaves the web bundle's own loopback default in place.
     */
    lanAccess: LanAccessValues
  }
}

/**
 * Whether an interface name marks a bridge, container link, or tunnel.
 *
 * The name is the only signal available without platform I/O, and it is the
 * signal the platforms agree on: every Docker bridge is `br-<id>` or
 * `docker0`, every Linux veth pair is `veth<id>`, every Hyper-V switch is a
 * `vEthernet`, and macOS names its own bridge, AirDrop, and WiFi-companion
 * interfaces `bridge<id>`, `awdl<id>`, and `llw<id>`. A name that matches
 * nothing here is treated as a LAN interface, which is why the table above is
 * a list rather than a heuristic. It carries no exemption: a name opening like
 * a virtual interface is demoted, whatever machine minted it.
 *
 * @param iface - the operating system's interface name.
 * @returns true when the interface carries no LAN of its own.
 */
export function isVirtualInterface(iface: string): boolean {
  return VIRTUAL_INTERFACE_PREFIXES.some(prefix => iface.startsWith(prefix))
}

/** An address this machine holds, and the interface that carries it. */
export interface LanCandidate {
  /** The IPv4 address. */
  readonly address: string
  /** The operating system's name for the interface carrying it. */
  readonly iface: string
  /** The interface is a bridge, container link, or tunnel. */
  readonly virtual: boolean
}

/** One address as `node:os` reports it, tagged with the interface carrying it. */
type InterfaceAddress = NetworkInterfaceInfo & { readonly iface: string }

/**
 * The MAC `node:os` reports for an interface that has none. Tunnels and
 * loopback-style shims carry no hardware identity, so this literal says
 * nothing about which addresses belong together.
 */
const ABSENT_MAC = '00:00:00:00:00:00'

/**
 * The key that groups the addresses one interface carries. A real MAC is the
 * hardware's identity, so several names answering to it — a Linux address
 * alias, say — form one group. An interface that reports no MAC is keyed by
 * its own name instead, so two unrelated MAC-less interfaces never merge.
 * @param entry - one address, as `node:os` reported it.
 * @returns the group key of the interface carrying this address.
 */
function interfaceKey(entry: InterfaceAddress): string {
  return entry.mac === ABSENT_MAC ? `iface:${entry.iface}` : `mac:${entry.mac}`
}

/**
 * Order the addresses of one interface by the name that carries them, each
 * name keeping the order the operating system reported. Sorting by name rather
 * than by enumeration alone makes the order of an interface's own addresses
 * independent of how the platform happened to sequence them.
 * @param entries - the addresses of one interface.
 * @returns the same addresses, names in order.
 */
function byName(entries: readonly InterfaceAddress[]): readonly InterfaceAddress[] {
  const names = [...new Set(entries.map(entry => entry.iface))].sort()
  return names.flatMap(name => entries.filter(entry => entry.iface === name))
}

/**
 * Group the addresses of one interface into one contiguous run, groups in the
 * order the operating system first reported them.
 *
 * The reordering is confined to an interface's own addresses: two different
 * interfaces never trade places, because a group sits where its first address
 * was reported. The enumeration order the ranking falls back on — alike
 * candidates keep the order the platform reported them in — therefore survives
 * the grouping untouched.
 *
 * @param entries - addresses in the order `node:os` reported them.
 * @returns the same addresses, one interface's entries contiguous.
 */
function groupByInterface(entries: readonly InterfaceAddress[]): readonly InterfaceAddress[] {
  const keys = [...new Set(entries.map(entry => interfaceKey(entry)))]
  return keys.flatMap(key => byName(entries.filter(entry => interfaceKey(entry) === key)))
}

/** Every non-internal IPv4 address this machine holds, in interface order. */
function lanEntries(): readonly InterfaceAddress[] {
  return Object.entries(networkInterfaces())
    .flatMap(([iface, list]) => (list ?? []).map(entry => ({ ...entry, iface })))
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
}

/**
 * Every non-internal IPv4 address this machine holds, tagged with its
 * interface and whether that interface is a bridge or tunnel.
 *
 * One interface's addresses form one contiguous run, which is what the ranking
 * and {@link detectLanAddress} rely on: the first address of the first
 * interface is the address this row binds.
 *
 * @returns the candidates in interface order; empty on a machine with only
 *   loopback.
 */
export function listLanCandidates(): readonly LanCandidate[] {
  return groupByInterface(lanEntries()).map(entry => ({
    address: entry.address,
    iface: entry.iface,
    virtual: isVirtualInterface(entry.iface),
  }))
}

/**
 * Order candidates by how likely each address is the one peers can reach.
 *
 * Interfaces that carry a network of their own come first, container bridges
 * and tunnels last. The sort is stable, so candidates that rank alike keep
 * their interface order — on a machine with one wired and one wireless
 * address, the first the operating system reports still wins.
 *
 * @param candidates - addresses from {@link listLanCandidates}.
 * @returns a reordered copy; the input is not mutated.
 */
export function rankLanCandidates(candidates: readonly LanCandidate[]): readonly LanCandidate[] {
  return [...candidates].sort((a, b) => Number(a.virtual) - Number(b.virtual))
}

/**
 * The single address on this machine peers are most likely able to reach: the
 * best-ranked candidate, which is the first non-virtual interface's address
 * when there is one. Best-effort and display-only — it decides no bind, and a
 * caller that offers it must still accept whatever the row's own grammar can
 * classify, since an operator may decline the offer and state another.
 * @returns the address, or undefined on a machine with only loopback (an
 *   isolated container, for example).
 */
export function detectLanAddress(): string | undefined {
  return rankLanCandidates(listLanCandidates())[0]?.address
}

/** How a bind host is shaped. */
export type BindHostKind = 'loopback' | 'wildcard' | 'address'

/**
 * Classify one bind host, or reject it.
 *
 * This function is the one authority on the shape of a bind host: the row that
 * binds it and the settings page that persists it both call it, so the grammar
 * an operator reads in a refusal is the grammar that decides the bind. It
 * judges the string as stated and never rewrites it — a padded value is
 * refused rather than trimmed, because silently correcting the operator's input
 * is the kind of hidden edit this row exists to keep visible.
 *
 * `loopback` names this machine alone: `127.0.0.1`, `localhost`, `::1`, and
 * `[::1]`. The IPv6 spellings are accepted as loopback even though nothing this
 * row binds is IPv6, because they mean exactly what the IPv4 literal means —
 * this machine's own stack — and refusing them would make the same intent
 * succeed or fail on the spelling alone.
 *
 * `wildcard` is `0.0.0.0`: every IPv4 interface this machine holds, and never
 * an IPv6 one. `address` is any other IPv4 literal, which publishes exactly the
 * interface that holds it.
 *
 * @param host - the value as stated by an operator or a settings page.
 * @returns the kind, or undefined when the row cannot bind it.
 */
export function classifyBindHost(host: string): BindHostKind | undefined {
  if (host.length === 0) return undefined
  if (host.length > MAX_BIND_HOST_LENGTH) return undefined
  if (host.trim() !== host) return undefined
  if (LOOPBACK_HOSTS.has(host)) return 'loopback'
  if (host === BIND_ALL_HOST) return 'wildcard'
  return isIPv4(host) ? 'address' : undefined
}

/**
 * Whether a host names this machine alone.
 *
 * The answer comes from the same table {@link classifyBindHost} reads, so the
 * choosers that ask this question and the bind that uses the answer cannot
 * drift apart.
 *
 * @param host - the configured or detected bind host.
 * @returns true for loopback literals and `localhost`.
 */
export function isLoopbackHost(host: string): boolean {
  return classifyBindHost(host) === 'loopback'
}

/**
 * Decide whether this host may bind the address it resolved.
 *
 * A loopback bind is reachable only from this machine, so it needs nothing
 * beyond the process-local authentication the connection half already applies.
 * Any other bind is reachable by everything that can route to it, so this row
 * requires the persistent token to exist first — resolving it creates one when
 * the harness home has none — and a failure to establish it refuses the bind
 * rather than starting an unauthenticated one.
 *
 * @param ctx - plugin context the web bundle reads the value from.
 * @param config - the resolved row configuration.
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const host = resolveHost(ctx, config)
  if (!isLoopbackHost(host)) {
    // Refuse the exposure when nothing can authenticate it. The connection half
    // exchanges this same token for the browser cookie.
    await ensureAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME))
    ctx.logger.warn(exposureWarning(host, (ctx.get('profileContext') as ProfilePatchRef | undefined)?.patchPath))
  }
  ctx.provide(LAN_ACCESS_SERVICE, { host })
}

/**
 * The host this row binds.
 *
 * The operator's word comes first: `--host` from the invocation, then the
 * composed row config, and otherwise this release's shipped posture. Nothing is
 * written back: the row composes the wildcard on its own, and a start that
 * edited the profile patch would make the Loader reconcile a changed entry,
 * which tears the web server down and binds it again on a new port while the
 * URL this start already printed goes stale. An operator who wants any other
 * posture states it — through the settings row or the profile patch — and that
 * statement is what a later release reads.
 *
 * An empty stated value is unstated, not illegal: `--host ''` and `host: ''`
 * mean "name nothing", exactly as omitting them does, so the shipped posture
 * still applies. Every other stated value must be one this row can bind, and
 * one that is not — `::`, a hostname, a padded field — refuses the boot instead
 * of falling back to the default, because a start that binds an address the
 * operator did not state is the silent failure this row is written against.
 *
 * @param ctx - plugin context; `webStartup` is read when present.
 * @param config - the composed row configuration.
 * @returns the host to bind.
 * @throws Error when a stated host is not one this row can bind.
 */
function resolveHost(ctx: Context, config?: Config): string {
  const flagged = (ctx.get('webStartup') as WebStartupHosts | undefined)?.host
  const stated = flagged !== undefined && flagged.length > 0 ? flagged : config?.host
  return stated !== undefined && stated.length > 0 ? bindableHost(stated) : BIND_ALL_HOST
}

/**
 * Admit a host an operator or a setting page stated, or refuse the boot.
 *
 * The grammar is {@link classifyBindHost}'s, and nothing here narrows or widens
 * it: a value it classifies is bound exactly as written, and a value it cannot
 * classify stops the start with the grammar stated back. There is deliberately
 * no fallback to the shipped posture, because the operator's line is a
 * statement about what to bind — quietly binding something else answers a
 * question they did not ask.
 *
 * @param host - the non-empty host the invocation or the row config stated.
 * @returns the same host, admitted.
 * @throws Error stating the accepted shapes and where to correct the value.
 */
function bindableHost(host: string): string {
  if (classifyBindHost(host) !== undefined) return host
  throw new Error(
    `lan-access: refusing to bind ${JSON.stringify(host)}: this row binds an IPv4 address or a loopback name only. `
    + 'Accepted: 127.0.0.1, localhost, ::1, and [::1] for this machine alone; any IPv4 literal such as 192.168.1.5 for the one interface holding it; '
    + `and ${BIND_ALL_HOST}, the IPv4 wildcard, for every IPv4 interface this machine holds — container bridges included, and never an IPv6 one. `
    + 'A hostname other than localhost, an IPv6 literal that is not loopback (:: included), a blank or padded value, '
    + `and anything longer than ${MAX_BIND_HOST_LENGTH} characters name no address here to bind. `
    + 'Correct the "host:" configuration of this row — or pass --host 127.0.0.1 for one run — '
    + 'or save a bindable host on the web-address settings page.',
  )
}

/**
 * The startup warning for a bind anything on the network may reach.
 *
 * It states what was bound, what the token is worth, and the two ways back to a
 * narrower posture — the profile patch to edit and the flag to pass — because
 * the alternative to a warning is a harness that is exposed and silent about it.
 *
 * @param host - the host this row bound.
 * @param patchPath - the profile patch an operator would edit to narrow the posture, when there is one.
 * @returns the warning text.
 */
function exposureWarning(host: string, patchPath: string | undefined): string {
  return `lan-access: bound ${host}, reachable by anything that can route to it. `
    + `${BIND_ALL_HOST} publishes every IPv4 interface this machine holds, container bridges included, and never an IPv6 one. `
    + 'The persistent access token is the only authenticator on that surface. '
    + `For a narrower posture set "host: 127.0.0.1" in ${patchPath ?? 'the profile patch cordis.patch.yml'}, `
    + 'or one LAN address such as 192.168.1.5 to publish a single network; --host 127.0.0.1 does the same for one run.'
}
