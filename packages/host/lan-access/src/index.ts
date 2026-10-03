/**
 * Network exposure for the web server.
 *
 * The harness is most useful from the machine it runs on and from the other
 * machines on the same network — a phone, a tablet, another laptop. This row
 * therefore binds this machine's LAN address by default: every network the
 * machine is attached to *other* than that one keeps its loopback-only posture,
 * container bridges and virtual interfaces included. An operator who wants the
 * old loopback-only posture sets `host: 127.0.0.1`; one who wants every
 * interface sets `host: 0.0.0.0`.
 *
 * The address it picks is the first interface that carries a network of its
 * own. Docker bridges, veth pairs, hypervisor switches, and tunnels are
 * addresses a phone cannot reach and an operator did not mean, and on a
 * container host they are often reported *before* the physical interface, so
 * they rank last rather than winning by enumeration order. They are ranked,
 * never excluded: a machine whose only address is a VPN interface still binds
 * it.
 *
 * `detectLanAddress()` answers which address the row binds, and `isLanHost()`
 * answers the question one step before it — whether this machine holds a LAN
 * worth binding at all. The same bridge-and-tunnel distinction decides it: a
 * machine whose every address belongs to a bridge or a tunnel gives a caller
 * something the ranking cannot, namely the difference between "no LAN here"
 * and "the VPN is the only way in".
 *
 * A reachable address is reachable by anyone who can route to it, so this row
 * refuses a bind it cannot authenticate: every non-loopback host requires the
 * persistent access token, which is resolved (and created when the harness home
 * has none) before the service is provided. The token is the only thing between
 * the network and remote code execution, so a host that cannot establish one
 * fails the boot instead of listening unauthenticated.
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

/** Hosts that name this machine alone. */
const LOOPBACK_HOSTS = new Set([LOOPBACK_HOST, 'localhost', '::1', '[::1]'])

/**
 * Interface-name prefixes that carry no LAN of their own: container bridges,
 * veth pairs, hypervisor switches, and tunnels.
 *
 * These addresses are real, routable, and reachable — from inside the
 * container network and nowhere else. Binding one exposes the harness to the
 * wrong network and hides it from the one the operator meant, so they rank
 * last. They are never excluded: a machine whose only address is a VPN
 * interface still gets that address rather than no network at all.
 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'br-', 'docker', 'veth', 'virbr', 'vmnet', 'vboxnet', 'tun', 'tap', 'utun', 'wg', 'zt', 'tailscale',
] as const

/** What this row publishes through {@link LAN_ACCESS_SERVICE}. */
export interface LanAccessValues {
  /** The host the web server should bind. */
  readonly host: string
}

export interface Config {
  /**
   * Explicit bind host. Omit it to bind this machine's LAN address — the first
   * interface carrying a network of its own, with bridges and tunnels ranked
   * last and loopback as the fallback when the machine has none. `127.0.0.1`
   * restores the loopback-only posture; `0.0.0.0` binds every interface.
   */
  host?: string
}

/** Row configuration; the default binds this machine's LAN address. */
export const Config: z<Config> = z.object({
  host: z.string(),
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
 * `docker0`, every Linux veth pair is `veth<id>`.
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
 * The address this row binds when it names none: the best-ranked candidate,
 * which is the first non-virtual interface's address when there is one.
 * @returns the address, or undefined on a machine with only loopback (an
 *   isolated container, for example).
 */
export function detectLanAddress(): string | undefined {
  return rankLanCandidates(listLanCandidates())[0]?.address
}

/**
 * Whether this machine holds a LAN worth binding: at least one non-internal,
 * non-virtual IPv4 address.
 *
 * The complement of {@link detectLanAddress}, which answers *which* address
 * the row binds by default; this answers whether there is a LAN to bind at
 * all, so a caller can tell "this machine has no LAN" apart from "the rank
 * picked one of several". A purely virtual machine is not a LAN host: a
 * container whose only address is its bridge, or a laptop whose only address
 * is its VPN tunnel, holds addresses that reach the container network or the
 * tunnel and nothing a peer on the local network could open. Loopback is not a
 * LAN either, and {@link listLanCandidates} excludes it already.
 *
 * @returns true when the candidate list holds an address carried by an
 *   interface that is not a bridge, container link, or tunnel.
 */
export function isLanHost(): boolean {
  return listLanCandidates().some(candidate => !candidate.virtual)
}

/**
 * Whether a host names this machine alone.
 * @param host - the configured or detected bind host.
 * @returns true for loopback literals and `localhost`.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * Resolve the host this row binds. The detected address is a parameter rather
 * than a default so a caller — and a test — can state "this machine has none"
 * distinctly from "do not look".
 * @param configured - the row's explicit host, when it named one.
 * @param detected - this machine's LAN address, from {@link detectLanAddress}.
 * @returns the configured host, else the detected address, else loopback.
 */
export function resolveBindHost(configured: string | undefined, detected: string | undefined): string {
  if (configured !== undefined && configured.length > 0) return configured
  return detected ?? LOOPBACK_HOST
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
  const host = resolveBindHost(config?.host, detectLanAddress())
  if (!isLoopbackHost(host)) {
    // Refuse the exposure when nothing can authenticate it. The connection half
    // exchanges this same token for the browser cookie.
    await ensureAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME))
  }
  ctx.provide(LAN_ACCESS_SERVICE, { host })
}
