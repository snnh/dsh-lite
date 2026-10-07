/**
 * The card that declares a provider an OWC namespace serves — the "add
 * service provider" flow of OWC's own configuration surface, on this page's
 * schema and credential seams.
 *
 * This is a create, not an edit, which is why it is its own form rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. It renders as the OWC
 * panel of the section's add card, over the mounted namespace whose own schema
 * declares an `interfaceType` — never over a namespace named here, since the
 * namespace is an entry id the deployment chooses.
 *
 * Only the fields a create cannot default are asked for: the route name, the
 * interface type, and the endpoint the protocol answers at; the API key
 * travels separately through `credentials/set` under the reference the profile
 * records as `apiKeyEnv`, exactly as an existing provider's key does. Every
 * other field of the profile has an adapter-side default, so the created route
 * serves as soon as the write lands and the row's editor fills in the rest —
 * the display name, the protocol switches, the numeric limits, the models.
 *
 * A preset answers the protocol and the endpoint at once, and a connection
 * test interrogates the endpoint the draft names before anything is stored —
 * the same `GET /models` question the saved card asks, asked here so a key or
 * an address that cannot serve is discovered while the form still holds it.
 *
 * Because the route id is also the stem of that credential reference, it has
 * to be an id `deriveKeyRef` can turn into a legal reference: a credential
 * reference is a POSIX shell identifier, which cannot start with a digit, so
 * the id starts with a letter and the failure is named while the user is still
 * looking at the field.
 *
 * @module dsh-client-ui-settings-models/client/OwcProviderCard
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { deriveKeyRef } from './store.ts'
import { OWC_PRESETS, presetById } from './owcPresets.ts'
import { protocolLabel } from './protocol-label.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * The route ids a create accepts: a letter first, then letters, digits, dots,
 * dashes, and underscores. The leading letter is what keeps `deriveKeyRef`'s
 * answer a legal credential reference; a digit-leading id would otherwise pass
 * every check this card makes and fail at the credential seam with a raw
 * regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/

/** Whether a typed endpoint is one the adapter may be pointed at. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * What the card last learned from the endpoint its draft names. The report is
 * about one address and one protocol, so any edit to either retires it — a
 * stale "connected" over an endpoint the user has since changed would vouch
 * for something nothing asked.
 */
type ProbeReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ok'; readonly count: number; readonly latencyMs: number }
  | { readonly kind: 'failed'; readonly message: string }

/** Props of {@link OwcProviderCard}. */
export interface OwcProviderCardProps {
  /**
   * The mounted namespace whose schema declares the OWC profile shape. It is
   * both where the profile is written and what supplies the draft's revision,
   * so a route another tab declared meanwhile is a refusal rather than a
   * silent overwrite of its profile.
   */
  namespace: SettingsNamespaceView
  /** Route ids this namespace already declares, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Interface types the adapter's own schema declares, in its order. */
  interfaces: readonly string[]
  /** The Host operations this card writes through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the card; `changed` reports whether a provider was created. */
  onClose: (changed: boolean) => void
  /**
   * Called once per change with whether the create is in flight, so the owner
   * can hold its surface still.
   */
  onBusyChange?: (busy: boolean) => void
}

/**
 * Render the OWC service-provider creation card.
 * @param props - the target namespace, its current routes, and wire faces and copy.
 * @returns the creation card.
 */
export function OwcProviderCard(props: OwcProviderCardProps): ReactNode {
  const { namespace, interfaces, operations, t, onBusyChange } = props
  // The write is checked against the revision on which this draft was opened.
  const [openedAt] = useState(() => namespace.revision)
  const [presetId, setPresetId] = useState('')
  const [route, setRoute] = useState('')
  // The interface type is the one field with no way to leave it blank: the
  // adapter requires it, so the card opens on the first the schema declares.
  const [interfaceType, setInterfaceType] = useState(interfaces[0] ?? '')
  const [baseURL, setBaseURL] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [probe, setProbe] = useState<ProbeReport>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  // A probe holds the card's surface still as a write does: switching the add
  // card's mode mid-request would hide the report it is about to receive.
  useEffect(() => { onBusyChange?.(busy || probe.kind === 'busy') }, [busy, probe, onBusyChange])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = props.taken.includes(route)
  // The endpoint is optional — the protocol's own usual host applies when it
  // is left blank — so only a typed one is judged, exactly as the editor judges
  // it. Its placeholder is what the blank field means.
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
  const keyFailure = apiKeyFailure(keyDraft)
  /**
   * The typed key with paste whitespace removed. A blank field yields an empty
   * string, which the create path reads as "no key supplied" — a route may
   * legitimately authenticate through the provider's own ambient discovery, or
   * through a header a `cordis.patch.yml` pins.
   */
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && interfaceType.length > 0 && !baseUrlInvalid && keyFailure === undefined

  /**
   * Adopt one preset into the draft. A preset is a whole answer — the picker
   * offers nothing to combine it with — so it replaces the route, the endpoint,
   * and the protocol together. A deployment may narrow the schema's interface
   * types, and a preset whose own protocol is not among them still contributes
   * what it knows: the endpoint, leaving the declared type untouched.
   */
  const applyPreset = (id: string): void => {
    setPresetId(id)
    const preset = presetById(id)
    if (preset === undefined) return
    setRoute(preset.id)
    setBaseURL(preset.baseURL)
    if (interfaces.includes(preset.interfaceType)) setInterfaceType(preset.interfaceType)
    setProbe({ kind: 'idle' })
  }

  /**
   * Ask the drafted endpoint what it serves, before anything is stored. The
   * key above travels as a one-shot credential — the harness never keeps it —
   * and a blank one asks unauthenticated, which is how a local server and a
   * gateway that lists models publicly are checked.
   */
  const probeEndpoint = async (): Promise<void> => {
    setProbe({ kind: 'busy' })
    const started = Date.now()
    const answer = await operations.discoverModels(namespace.ns, {
      baseURL: normalizedBaseURL,
      api: interfaceType,
      ...keyValue.length === 0 ? {} : { apiKey: keyValue },
    })
    const latencyMs = Date.now() - started
    setProbe(answer.kind === 'found'
      ? { kind: 'ok', count: answer.models.length, latencyMs }
      : { kind: 'failed', message: answer.message })
  }

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        interfaceType,
        ...normalizedBaseURL.length === 0 ? {} : { baseURL: normalizedBaseURL },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path instead of
        // resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
      }
      // `taken` is a snapshot too, so the id check alone cannot see a route
      // declared after this card opened; the revision makes that race a
      // `settings-conflict` instead of a write over the other profile.
      const written = await operations.writeSettings(
        namespace.ns,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }
      // The provider now exists. A retry after the key write below fails must
      // not re-run this write: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommitted(true)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (stored !== undefined) return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcPreset')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={presetId}
          aria-label={t('owcPreset')}
          disabled={profileDisabled}
          onChange={(event) => { applyPreset(event.target.value) }}
        >
          <option value="">{t('owcPresetPick')}</option>
          {OWC_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id}>
              {preset.codingPlan === true ? `${preset.label} · ${t('owcCodingPlan')}` : preset.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customRoute')}</span>
        <input
          className={styles['input']}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-label={t('customRoute')}
          aria-invalid={routeInvalid || routeTaken}
          disabled={profileDisabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>
      {/* A rejected id reads as a fault, not as guidance — the same split the
          key field below makes between its failure and its hint. */}
      {routeInvalid || routeTaken
        ? <p className={styles['error']}>{t(routeInvalid ? 'owcRouteInvalid' : 'customRouteTaken')}</p>
        : <p className={styles['advancedHint']}>{t('owcRouteHint')}</p>}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcInterfaceType')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={interfaceType}
          aria-label={t('owcInterfaceType')}
          disabled={profileDisabled}
          onChange={(event) => { setInterfaceType(event.target.value); setProbe({ kind: 'idle' }) }}
        >
          {interfaces.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder={interfaceType === 'anthropic-messages'
            ? t('owcAnthropicBaseUrlPlaceholder')
            : t('owcChatBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          aria-invalid={baseUrlInvalid}
          disabled={profileDisabled}
          onChange={(event) => { setBaseURL(event.target.value); setProbe({ kind: 'idle' }) }}
        />
      </div>
      {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="new-password"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          aria-invalid={keyFailure !== undefined}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: this route may authenticate
            through the provider's own ambient discovery. */}
        {keyFailure === undefined
          ? null
          : <p className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      {/* The endpoint is the draft's, so the test needs no stored route — but
          it does need an address, which is why the button waits for one. */}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcConnection')}</span>
        <div className={styles['probeRow']}>
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={disabled || committed || probe.kind === 'busy'
              || normalizedBaseURL.length === 0 || baseUrlInvalid}
            onClick={() => { void probeEndpoint() }}
          >
            {probe.kind === 'busy' ? t('owcTesting') : t('owcTestConnection')}
          </button>
          {probe.kind === 'ok'
            ? (
              <>
                <span className={styles['probeNotice']} role="status">
                  {`${t('owcConnected')} · ${String(probe.count)} ${t('owcModelsFound')}`}
                </span>
                <span className={styles['probeNotice']}>{`${t('owcLatency')} ${String(probe.latencyMs)} ${t('owcMillis')}`}</span>
              </>
            )
            : probe.kind === 'failed'
              ? <span className={styles['error']}>{probe.message}</span>
              : null}
        </div>
      </div>
      {probe.kind === 'idle' ? <p className={styles['advancedHint']}>{t('owcProbeHint')}</p> : null}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
