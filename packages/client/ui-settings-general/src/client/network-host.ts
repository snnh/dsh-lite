/**
 * The bind-address seam as this page reads it: the `webHost` Remote namespace
 * plus the small state owner the General row and its shell notice share.
 *
 * `webHost` is the Host's startup-configuration scope. `status()` reports each
 * fact that decides the next start's address separately — what this process
 * bound, what the profile's patch persists, what `--host` pinned for this
 * invocation, what this machine detects — and `save(host)` persists one
 * address into that patch. Neither call moves the running bind, so the row
 * shows the saved line beside the effective one instead of pretending the
 * running harness changed.
 *
 * The namespace is declared here rather than consumed from the owner's
 * generated Client artifact: this package's Client program resolves
 * `ctx.remote` through `@deepseek-ai/dsh-api-remotes/client`, and the owner's
 * built `./remote` artifact predates the namespace. The declaration repeats
 * the generator's own shape — the namespace interface carries the generator's
 * name (hex of the namespace string) and the map entry is the same key — so a
 * regenerated artifact merges with it instead of colliding with it.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-general/src/client/network-host.ts
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge this namespace augments.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * The bind-address posture one read answers with. Every optional field is
 * absent rather than present-and-undefined, so a page tells "this fact does
 * not exist here" from "this fact is empty".
 */
export interface WebHostStatus {
  /** A lan-access row is composed in the active profile; only then can one be configured. */
  readonly rowFound: boolean
  /** The host this process bound, as the lan-access row published it at startup. */
  readonly bound?: string
  /** The host the profile's own patch states, which the next start reads back. */
  readonly persisted?: string
  /** The host `--host` pinned for this invocation, which outranks the patch. */
  readonly pinned?: string
  /** This machine's detected LAN address, the fallback when no host is stated. */
  readonly detected?: string
  /** A profile patch exists to persist into; the write itself may still be refused. */
  readonly writable: boolean
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** `webHost`: the bind address this harness persists for its next start. */
  interface TypertRemoteNamespace$776562486f7374 extends WebHostNamespace {}
  interface TypertRemoteNamespaceMap {
    webHost: TypertRemoteNamespace$776562486f7374
  }
}

/**
 * The method face of the `webHost` namespace as this page calls it. The
 * generated namespace interface extends this one, so the two declarations
 * share one method set.
 */
export interface WebHostNamespace {
  /** Read the current posture, field by field. */
  status: () => Promise<RemoteResult<WebHostStatus>>
  /** Persist one bind host for the next start; refused hosts answer `web-host/rejected`. */
  save: (host: string) => Promise<RemoteResult<WebHostStatus>>
}

/** Phase of the one posture read this row performs; 'ready' means `view` is present. */
export type NetworkLoadPhase = 'loading' | 'ready' | 'failed'

/** Observable row state: the posture read plus whether a save is in flight. */
export interface NetworkRowState {
  /** Read phase; `view` is present exactly in the 'ready' phase. */
  status: NetworkLoadPhase
  /** Last accepted posture, absent while unresolved. */
  view: WebHostStatus | null
  /** One save in flight. */
  busy: boolean
}

/** The `settings.network` copy a save outcome reports through the shell notice. */
export type NetworkNoticeKey = 'network.saved' | 'network.saveFailed'

/** Observable notice state shared by the row and the shell overlay. */
export interface NetworkNoticeState {
  /** Outcome still to announce, or null once shown and dismissed. */
  notice: NetworkNoticeKey | null
  /** Per-show sequence keying the banner, so the same outcome replays. */
  sequence: number
}

/** Save outcome announced by the overlay; a success reads as the stored line. */
const SAVED: NetworkNoticeKey = 'network.saved'
/** Save outcome announced by the overlay when the Host refused or the call failed. */
const SAVE_FAILED: NetworkNoticeKey = 'network.saveFailed'

/**
 * Read and write owner of the bind address. The row renders from {@link store}
 * and writes through {@link save}; the shell overlay announces the outcome
 * from {@link notice}, so a save stays visible after Settings closes.
 *
 * Both reads and writes address the running Host through `ctx.remote.webHost`
 * on the fiber the plugin handed this controller — the fiber that declared the
 * namespace as a dependency, so the call reaches the Client assembly's mount.
 */
export class NetworkHostController {
  /** Observable posture state rendered by the row. */
  readonly store: SnapshotStore<NetworkRowState> = createSnapshotStore<NetworkRowState>({
    status: 'loading', view: null, busy: false,
  })

  /** Observable save outcome rendered by the shell overlay. */
  readonly notice: SnapshotStore<NetworkNoticeState> = createSnapshotStore<NetworkNoticeState>({
    notice: null, sequence: 0,
  })

  /** One read in flight; concurrent loads collapse into it. */
  private loading = false

  /** @param ctx - the plugin context whose `remote.webHost` namespace owns the posture. */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Read the posture once; concurrent calls collapse behind the in-flight read
   * so a remount cannot stack Host reads.
   * @returns completion once the snapshot reflects the read.
   */
  async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.store.update((state) => { state.status = 'loading' })
    try {
      const result = await this.host().status()
      this.store.update((state) => {
        if (result.ok) {
          state.status = 'ready'
          state.view = result.value
          return
        }
        state.status = 'failed'
      })
    } catch (_error) {
      // A carrier that folds failures into the result still rejects on an
      // assembly fault (an unmounted method, a missing adapter); the row owes
      // the operator the same "could not read" state for either.
      this.store.update((state) => { state.status = 'failed' })
    } finally {
      this.loading = false
    }
  }

  /**
   * Persist one address for the next start and report the outcome through the
   * overlay. The accepted posture replaces the row's view, so the saved line
   * and the effective line can be compared immediately.
   * @param host - the IPv4 literal or `localhost` to persist.
   * @returns completion once the write settled and the notice is published.
   */
  async save(host: string): Promise<void> {
    if (this.store.getSnapshot().busy) return
    this.store.update((state) => { state.busy = true })
    let notice: NetworkNoticeKey = SAVED
    try {
      const result = await this.host().save(host)
      if (result.ok) this.store.update((state) => { state.view = result.value })
      else notice = SAVE_FAILED
    } catch (_error) {
      notice = SAVE_FAILED
    }
    this.store.update((state) => { state.busy = false })
    this.notice.update((state) => {
      state.notice = notice
      state.sequence += 1
    })
  }

  /** Clear the announced outcome once the banner has faded. */
  dismiss(): void {
    this.notice.update((state) => { state.notice = null })
  }

  private host(): WebHostNamespace {
    return this.ctx.remote.webHost
  }
}
