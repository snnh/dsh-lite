/**
 * Boot-time backend resolution for the adaptive directory-picker composition:
 * one pure decision from sampled host facts to a concrete backend kind. The
 * caller samples exactly once per boot, so the mounted capability stays
 * stable for the service lifetime as the seam requires.
 *
 * The bind host is classified through the row that owns that vocabulary —
 * `dsh-host-lan-access`'s `isLoopbackHost` — so the chooser and the bind
 * decision itself can never disagree about which hosts name this machine
 * alone.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import { isLoopbackHost } from '@deepseek-ai/dsh-host-lan-access'
import type { Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<'DISPLAY' | 'WAYLAND_DISPLAY', string>>
>

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /**
   * Effective webserver bind host, verbatim. The webserver schema admits any
   * non-empty host (`z.string().min(1).required()`): a loopback literal, the
   * IPv4 wildcard, or one explicit local address. It is therefore classified
   * by {@link isLoopbackHost}, never against a closed literal union.
   */
  bindHost: HttpServerConfig['host']
  /** Host process platform. */
  platform: NodeJS.Platform
  /** SSH launch fact from the inherited process layer, independent of `.env` values. */
  ssh: boolean
  /** Environment sample; DISPLAY/WAYLAND_DISPLAY marks a Linux display. */
  env: DirectoryPickerEnv
  /** Whether a Linux chooser binary the native backend can drive (zenity/kdialog) is on PATH; consulted only when `platform` is linux. */
  linuxChooser: boolean
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. `native` requires every signal that
 * the operator can see the host display and the native backend can serve it:
 * a loopback-only bind, no SSH launch (under SSH port-forwarding the chooser
 * would open on the unattended server), and a servable display session —
 * assumed on darwin/win32, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a
 * chooser binary on linux, and never true elsewhere (the native backend
 * drives exactly darwin/win32/linux). Anything ambiguous resolves to
 * `browse`, which works everywhere.
 *
 * "Loopback-only" means {@link isLoopbackHost}'s vocabulary — `127.0.0.1`,
 * `localhost`, `::1`, `[::1]` — the same four literals that let the
 * lan-access row bind without the network token, so a host spelling this
 * chooser accepts is a host spelling the bind decision already treats as
 * local.
 *
 * An all-interfaces bind (`0.0.0.0`, the posture lan-access persists on first
 * run) is deliberately not loopback, and this resolution therefore answers
 * `browse` for it — for the operator sitting at the machine as much as for a
 * peer on the LAN. That is the stated trade, not an oversight: the seam
 * samples once per boot and the pick verb carries no caller origin, so a
 * mounted `native` backend could not tell the local operator from any other
 * admitted client, and every one of them could open a dialog on the host's
 * display. Losing the OS chooser for the machine's own browser is the cheaper
 * side of that; binding loopback (`host: 127.0.0.1`, the settings row's
 * narrower posture) is how a local operator gets the native chooser back.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  if (!isLoopbackHost(facts.bindHost)) return 'browse'
  if (facts.ssh) return 'browse'
  if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
