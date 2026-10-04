/**
 * Host owner of the `webHost` Remote namespace: the web-address settings page's
 * view of the address this harness binds, and the write that persists the next
 * start's address into the profile.
 *
 * The scope is startup configuration alone. A save lands through the same
 * `writeProfileRowConfig()` the lan-access row persists its first-run posture
 * with — one storage, one truth — and touches nothing else: not the running
 * bind, not the access token, not the advertised URL, not the Loader. The
 * operator restarts, and the next start reads the line back through the row's
 * ordinary resolution order (`--host`, then the composed config the profile
 * patch feeds, then this machine's detected address, then loopback).
 *
 * The persisted line is what makes this page worth having: the profile patch
 * outranks every bundle default, so a host stated here survives later releases
 * changing theirs, and `127.0.0.1` is how an operator returns to loopback.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/web-host.ts
 */

import { isIPv4, isIPv6 } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { writeProfileRowConfig } from '@deepseek-ai/dsh-config-editor'
import { detectLanAddress } from '@deepseek-ai/dsh-host-lan-access'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WebHostStatusValue } from './types.ts'

/**
 * The module specifier of the row this namespace addresses. The lookup is by
 * name, not by id: a profile may compose the row under any id, and the id it
 * actually used is the one the write must address — the patch lane matches a
 * row by id *and* name, and a name that differs from the composed row's is
 * skipped with a warning.
 */
const LAN_ACCESS_ROW_NAME = '@deepseek-ai/dsh-host-lan-access'

/**
 * The row identity a write states when the active profile composes no
 * lan-access row: the shipped identity, which is the one the row's own
 * first-run persist states. A profile that mounts the row later picks the line
 * up; one that never does skips it with the patch lane's own warning rather
 * than failing the boot.
 */
const SHIPPED_ROW = { id: 'lan-access', name: LAN_ACCESS_ROW_NAME } as const

/**
 * The longest bind host this namespace accepts. The grammar below admits
 * `255.255.255.255` (15 characters) and `localhost` (9) at most, so this
 * bound refuses a payload before it reaches the patch file; it never admits
 * one on its own.
 */
const MAX_HOST_LENGTH = 45

/**
 * The host this invocation was started with, narrowed to the one field a
 * posture read needs. The service itself belongs to the web bundle, which this
 * package deliberately does not depend on: the row reads the same field the
 * same way.
 */
interface WebStartupHosts {
  /** `--host`, absent when the invocation named none. */
  readonly host?: string
}

/**
 * The launcher-provided profile a patch write lands in, narrowed to the two
 * facts `writeProfileRowConfig()` reads. Structural rather than the launcher's
 * own type, so this package depends on the write contract instead of on the
 * boot package that provides the value.
 */
interface BindHostProfile {
  /** The profile directory holding `package.json`, the write lock's name. */
  readonly dir: string
  /** The profile's own patch file: the layer a saved host is written into. */
  readonly patchPath: string
}

/** The composed lan-access row and the config the profile's patch states for it. */
interface MountedRow {
  /** The row id the Loader composed, which a write must address. */
  readonly id: string
  /** The row's module specifier, the key this lookup matched on. */
  readonly name: string
  /** The profile patch's own config for that row, whatever it holds. */
  readonly override: Record<string, unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `webHost` Remote namespace. */
    webHostController: WebHostController
  }
}

/**
 * Host service backing the generated `ctx.remote.webHost` namespace: the
 * read side reports each fact that decides the next start's bind address
 * separately — what this process bound, what the profile persists, what the
 * invocation pinned, what this machine detects — and the write side persists an
 * operator's address into the profile patch.
 *
 * The namespace mounts whether or not a lan-access row is composed: the page
 * must be able to render the posture and to receive the actionable refusal,
 * not a missing-namespace failure.
 */
export class WebHostController extends TypertRemoteService {
  /** @param ctx - Host context of the profile whose patch a write lands in. */
  constructor(ctx: Context) {
    super(ctx, 'webHostController', { namespace: 'webHost' })
  }

  /**
   * Describe the bind-host posture: every layered fact a page shows beside the
   * field, so the operator sees what a save will change and what nothing here
   * can change (`--host` is resolved at startup, and the running bind is not
   * this page's to move).
   * @returns the posture; absent facts are omitted rather than sent as `undefined`.
   */
  @Remote
  status(): WebHostStatusValue {
    return this.view()
  }

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
   * @param host - the address to bind on the next start: an IPv4 literal or `localhost`.
   * @returns the posture after the write: `persisted` is the line just written when the
   *   composed row reads it back, and absent when no row in this profile does.
   * @throws RemoteError when the address is not one this row can bind, this deployment
   *   has no profile patch, or the patch cannot be written.
   */
  @Remote
  async save(host: string): Promise<WebHostStatusValue> {
    const next = checkHost(host)
    const profile = this.profile()
    if (profile === undefined) {
      throw new RemoteError(
        'web-host/rejected',
        'this deployment has no profile patch to persist a bind host in: launch the harness from a profile (dsh --profile web) to save one',
        { host: next },
      )
    }
    try {
      await writeProfileRowConfig(profile, this.rowConfig(next))
    } catch (error: unknown) {
      throw new RemoteError(
        'web-host/rejected',
        `the profile patch refused the bind host: ${messageOf(error)}`,
        { host: next },
        { cause: error },
      )
    }
    return this.view()
  }

  /**
   * The patch row this write addresses: the composed lan-access row when the
   * profile has one, else the shipped identity. The row keeps every other key
   * its patch config already holds, so a field a later release adds to the row
   * is not dropped by saving an address here.
   * @param host - the validated address to persist.
   * @returns the row to write into the profile patch.
   */
  private rowConfig(host: string): { id: string; name: string; config: Record<string, unknown> } {
    const mounted = this.mountedRow()
    if (mounted === undefined) return { ...SHIPPED_ROW, config: { host } }
    return { id: mounted.id, name: mounted.name, config: { ...mounted.override, host } }
  }

  /**
   * The composed lan-access row and the profile's own config for it, read
   * through the configuration editor: the same view the settings page renders,
   * so this page and the editor cannot disagree about which line is the
   * persisted posture.
   * @returns the row, or undefined when no profile, editor, or such row exists.
   */
  private mountedRow(): MountedRow | undefined {
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return undefined
    const row = editor.configuration().find(candidate => candidate.entry.options.name === LAN_ACCESS_ROW_NAME)
    if (row === undefined) return undefined
    return { id: row.entry.options.id, name: row.entry.options.name, override: row.override }
  }

  /**
   * The launcher-provided profile a write lands in. Read through the untyped
   * service lookup and narrowed here: the launcher's own type describes a whole
   * boot context, while a patch write reads exactly two of its facts.
   * @returns the profile's directory and patch path, or undefined outside a launched profile.
   */
  private profile(): BindHostProfile | undefined {
    const profile = this.ctx.get('profileContext') as BindHostProfile | undefined
    return profile
  }

  /** Project the current posture onto its wire view, field by field. */
  private view(): WebHostStatusValue {
    const mounted = this.mountedRow()
    const bound = this.ctx.get('lanAccess')?.host
    const pinned = (this.ctx.get('webStartup') as WebStartupHosts | undefined)?.host
    const persisted = persistedHost(mounted)
    const detected = detectLanAddress()
    return {
      rowFound: mounted !== undefined,
      ...bound === undefined ? {} : { bound },
      ...persisted === undefined ? {} : { persisted },
      ...pinned === undefined ? {} : { pinned },
      ...detected === undefined ? {} : { detected },
      writable: this.profile() !== undefined,
    }
  }
}

/**
 * The host one profile patch states for the mounted row, when it states one.
 * A `!!js` expression is a value the Loader evaluates per start, not an address
 * this page can show or own, so anything that is not a string reads as absent.
 * @param mounted - the composed row, when the profile has one.
 * @returns the persisted host, or undefined when the patch states none.
 */
function persistedHost(mounted: MountedRow | undefined): string | undefined {
  const stored = mounted?.override.host
  return typeof stored === 'string' ? stored : undefined
}

/**
 * Validate one bind host the settings page sent.
 *
 * The accepted grammar is exactly what the lan-access row can bind: an IPv4
 * literal — the `0.0.0.0` wildcard, loopback, and every interface address this
 * machine holds included — or `localhost`. Everything else is refused with its
 * reason, because a hostname that never resolves, an IPv6 literal this row does
 * not publish, or a blank field would otherwise be persisted and read back as a
 * posture that cannot start. A padded value is refused rather than trimmed:
 * silently rewriting the operator's input is the kind of hidden edit this page
 * exists to make visible.
 *
 * @param host - the address as it arrived over the wire.
 * @returns the accepted address, unchanged.
 * @throws RemoteError when the value is not a bind host the row can use.
 */
function checkHost(host: string): string {
  if (host.length === 0 || host.trim() !== host) {
    throw new RemoteError(
      'web-host/rejected',
      'a bind host must be a non-empty address with no surrounding whitespace',
      { host },
    )
  }
  if (host.length > MAX_HOST_LENGTH) {
    throw new RemoteError(
      'web-host/rejected',
      `a bind host is at most ${MAX_HOST_LENGTH} characters`,
      { host },
    )
  }
  if (isIPv4(host) || host === 'localhost') return host
  throw new RemoteError(
    'web-host/rejected',
    isIPv6(host)
      ? `"${host}" is an IPv6 address: this row publishes IPv4 interfaces only`
      : `"${host}" is neither an IPv4 address nor localhost`,
    { host },
  )
}

/**
 * The text of one seam failure. A writer reached through this seam is not
 * obliged to reject with an Error, and a refusal that renders "[object Object]"
 * instead of the reason is not a diagnostic.
 * @param error - whatever the patch writer threw.
 * @returns the failure's own message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default WebHostController
