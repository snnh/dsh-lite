/**
 * Opt-in network exposure for the web server.
 *
 * The web bundle binds loopback by default. An operator who wants the harness
 * reachable from a phone, a tablet, or another machine on the same network needs
 * the server on an address the network can reach — and that address is reachable
 * by anyone who can route to it, not only by the operator.
 *
 * This row is the switch. It decides the bind host the web server reads, and it
 * refuses a host it cannot authenticate: a network-reachable bind requires a
 * token that outlives the process, which is resolved (and created when absent)
 * before the service is provided. The default host is loopback, so a tree that
 * mounts this row unchanged behaves exactly as one without it.
 *
 * Enabling exposure is therefore a one-line change to this row's `host` — in the
 * bundle patch or in an overlay — and returning to loopback is changing it back
 * or deleting the row: the web bundle reads the value through `ctx.get`, so an
 * absent row simply leaves the loopback default in place.
 *
 * What this does not do: terminate TLS, set `Secure` on the cookie, or restrict
 * which network peers may connect. See the package README for the boundary.
 *
 * @module @deepseek-ai/dsh-host-lan-access
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ACCESS_TOKEN_FILENAME, ensureAccessToken } from '@deepseek-ai/dsh-access-token'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Stable Cordis plugin name. */
export const name = 'lan-access'

/** Service this row provides and the web bundle reads for its bind host. */
export const LAN_ACCESS_SERVICE = 'lanAccess'

/** The bind host this row admits: loopback, or every interface. */
export type LanAccessHost = '127.0.0.1' | '0.0.0.0'

/** What this row publishes through {@link LAN_ACCESS_SERVICE}. */
export interface LanAccessValues {
  /** The host the web server should bind. */
  readonly host: LanAccessHost
}

export interface Config {
  /**
   * The address the web server binds. `127.0.0.1` (the default) keeps the
   * loopback-only posture; `0.0.0.0` exposes the harness to every network the
   * machine is attached to, and requires a persistent access token.
   */
  host: LanAccessHost
}

/** Row configuration; the default keeps the harness on loopback. */
export const Config: z<Config> = z.object({
  host: z.union([z.const('0.0.0.0'), z.const('127.0.0.1')]).default('127.0.0.1'),
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
 * Decide whether this host may bind a network-reachable address.
 *
 * A loopback bind is reachable only from this machine, so it needs nothing
 * beyond the process-local authentication the connection half already applies.
 * Any other bind is reachable by everything that can route to it, so this row
 * requires the persistent token to exist first — resolving it creates one when
 * the harness home has none — and the failure to establish it refuses the bind
 * rather than starting an unauthenticated one.
 *
 * @param ctx - plugin context the web bundle reads the value from.
 * @param config - the resolved row configuration.
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const host = config?.host ?? '127.0.0.1'
  if (host === '127.0.0.1') {
    ctx.provide(LAN_ACCESS_SERVICE, { host })
    return
  }
  // Refuse the exposure when nothing can authenticate it. The connection half
  // exchanges this same token for the browser cookie.
  await ensureAccessToken(dshHomePath(ACCESS_TOKEN_FILENAME))
  ctx.provide(LAN_ACCESS_SERVICE, { host })
}
