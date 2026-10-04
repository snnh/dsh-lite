/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * The bind-host write was refused: an address outside the grammar this row
     * can bind, or a profile whose patch could not be written. The details name
     * the address the caller asked to persist, never a token.
     */
    'web-host/rejected': { readonly host: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/**
 * The bind-host posture a web-address settings page renders, and what a save
 * answers with: the facts that decide the next start's address, each one
 * distinct, plus whether this deployment can persist a new one at all.
 *
 * Every optional field is omitted rather than sent as `undefined`, so a page
 * can tell "this fact does not exist here" from "this fact is empty": an
 * embedded deployment reports `rowFound: false` and omits the rest.
 */
export interface WebHostStatusValue {
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
  /** Every IPv4 address this machine holds, best-ranked first; empty on a loopback-only host. */
  readonly candidates: string[]
  /** A profile patch exists to persist into; the write itself may still be refused. */
  readonly writable: boolean
}
