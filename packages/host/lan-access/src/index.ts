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

import { networkInterfaces } from 'node:os'
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

/** What this row publishes through {@link LAN_ACCESS_SERVICE}. */
export interface LanAccessValues {
  /** The host the web server should bind. */
  readonly host: string
}

export interface Config {
  /**
   * Explicit bind host. Omit it to bind this machine's LAN address — the first
   * non-internal IPv4 interface, which falls back to loopback when the machine
   * has none. `127.0.0.1` restores the loopback-only posture; `0.0.0.0` binds
   * every interface.
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
 * The first non-internal IPv4 address this machine holds.
 * @returns the address, or undefined on a machine with only loopback (an
 *   isolated container, for example).
 */
export function detectLanAddress(): string | undefined {
  for (const iface of Object.values(networkInterfaces()).flat()) {
    if (iface !== undefined && iface.family === 'IPv4' && !iface.internal) return iface.address
  }
  return undefined
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
