/**
 * The OWC family's profile fields: identity, wire protocol, endpoint, the
 * credential switches the protocol supports, the extra request body, the
 * route's numeric limits, and the connection test.
 *
 * The card edits the user layer alone, so what a cleared field falls back to
 * is the layer beneath — a `cordis.yml` that pinned a name or an endpoint —
 * and what an empty numeric field falls back to is the adapter's own schema
 * default. Both are shown as placeholders rather than written: leaving a field
 * blank must keep inheriting, not freeze today's answer into the profile.
 *
 * @module dsh-client-ui-settings-models/client/OwcProfileFields
 */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import { invalidOwcNumbers, numberFieldText, OWC_NUMBER_FIELDS, OWC_NUMBER_LABELS, spelledDefault } from './owcNumbers.ts'
import type { OwcNumberField } from './owcNumbers.ts'
import { protocolLabel } from './protocol-label.ts'
import styles from './ModelsSection.module.css'

/** What the connection test last reported. */
export type OwcConnectionReport =
  /** Never asked, or asked and superseded by a fresh card. */
  | { readonly kind: 'idle' }
  /** A request is in flight; the action is refused until it answers. */
  | { readonly kind: 'busy' }
  /**
   * The endpoint answered, disclosing this many models. The round trip is
   * reported beside the count because it is the one number that tells a slow
   * gateway from a fast one before a session is spent on it.
   */
  | { readonly kind: 'connected'; readonly count: number; readonly latencyMs: number }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'failed'; readonly message: string }

/** Props of {@link OwcProfileFields}. */
export interface OwcProfileFieldsProps {
  /** Route id this profile is keyed by; what an empty display name means. */
  route: string
  /** The user-layer draft this card edits. */
  draft: Record<string, unknown>
  /** The effective profile beneath the draft, for the flags it inherits. */
  fallback: unknown
  /** Interface types the adapter's own schema declares, in its order. */
  interfaces: readonly string[]
  /** What a cleared identity field falls back to: the composition's own values. */
  inherited: { readonly displayName: string; readonly baseURL: string | undefined }
  /** Inherited numeric defaults, shown as the placeholder of an empty field. */
  defaults: Readonly<Record<OwcNumberField, number | undefined>>
  /** The extra request body as typed, with its refusal and its edit action. */
  extraBody: {
    readonly text: string
    readonly failure: ModelsKey | undefined
    readonly onChange: (text: string) => void
  }
  /** What the connection test currently reports. */
  connection: OwcConnectionReport
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
  /** Replace one profile field; `undefined` unsets it. */
  onField: (key: string, value: unknown) => void
  /** Accept one keystroke in a numeric field. */
  onNumber: (field: OwcNumberField, text: string) => void
  /** Ask the route's endpoint which models it serves. */
  onTest: () => void
}

/** Whether a value is a plain object rather than an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One text field's stored value, as its input shows it. */
function textOf(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * A profile flag: the draft's own value, else the one it inherits, else the
 * adapter's default. Reading the inherited layer matters for the profile a
 * composition pinned and this card has only just opened over.
 */
function flagOf(draft: Record<string, unknown>, fallback: unknown, key: string, absent: boolean): boolean {
  const stored = draft[key]
  if (typeof stored === 'boolean') return stored
  const inherited = isRecord(fallback) ? fallback[key] : undefined
  if (typeof inherited === 'boolean') return inherited
  return absent
}

/**
 * Render one OWC provider profile.
 * @param props - the drafted profile, its inherited defaults, and wire actions.
 * @returns the profile fields, ending in the connection test.
 */
export function OwcProfileFields(props: OwcProfileFieldsProps): ReactNode {
  const { draft, t, disabled, onField } = props
  // A profile naming an interface type the schema no longer offers selects
  // nothing, exactly as an unset one does: the choice is gone either way.
  const declared = textOf(draft, 'interfaceType')
  const interfaceType = props.interfaces.includes(declared) ? declared : ''
  const invalidNumbers = invalidOwcNumbers(draft)
  return (
    <>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={textOf(draft, 'displayName')}
          placeholder={props.inherited.displayName}
          aria-label={t('customDisplayName')}
          disabled={disabled}
          onChange={(event) => { onField('displayName', event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcInterfaceType')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={interfaceType}
          aria-label={t('owcInterfaceType')}
          disabled={disabled}
          onChange={(event) => { onField('interfaceType', event.target.value) }}
        >
          {interfaceType === '' ? <option value="">{t('customApiUnset')}</option> : null}
          {props.interfaces.map(choice => <option key={choice} value={choice}>{protocolLabel(t, choice)}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={textOf(draft, 'baseURL')}
          placeholder={props.inherited.baseURL ?? (interfaceType === 'anthropic-messages'
            ? t('owcAnthropicBaseUrlPlaceholder')
            : t('owcChatBaseUrlPlaceholder'))}
          aria-label={t('baseUrl')}
          disabled={disabled}
          onChange={(event) => { onField('baseURL', event.target.value) }}
        />
      </div>
      <div className={styles['modelInputChoices']}>
        <Checkbox
          label={t('owcEnabled')}
          checked={flagOf(draft, props.fallback, 'enabled', true)}
          disabled={disabled}
          onChange={(checked) => { onField('enabled', checked ? undefined : false) }}
        />
        {/* Each switch belongs to the protocol that has it: Anthropic's prompt
            caching and OpenAI's usage reporting are separate wire features of
            separate protocols, so offering the other one would offer a field
            the endpoint ignores. */}
        {interfaceType === 'anthropic-messages'
          ? (
            <Checkbox
              label={t('owcPromptCaching')}
              checked={flagOf(draft, props.fallback, 'promptCaching', false)}
              disabled={disabled}
              onChange={(checked) => { onField('promptCaching', checked ? true : undefined) }}
            />
          )
          : null}
        {interfaceType === 'openai-chat-completions'
          ? (
            <Checkbox
              label={t('owcIncludeUsage')}
              checked={flagOf(draft, props.fallback, 'includeUsage', false)}
              disabled={disabled}
              onChange={(checked) => { onField('includeUsage', checked ? true : undefined) }}
            />
          )
          : null}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcExtraBody')}</span>
        <textarea
          className={styles['extraBodyInput']}
          value={props.extraBody.text}
          aria-label={t('owcExtraBody')}
          aria-invalid={props.extraBody.failure !== undefined}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => { props.extraBody.onChange(event.target.value) }}
        />
        <span className={styles['advancedHint']}>{t('owcExtraBodyHint')}</span>
        {props.extraBody.failure === undefined
          ? null
          : <p className={styles['error']}>{t(props.extraBody.failure)}</p>}
      </div>
      <div className={styles['owcNumbers']}>
        {OWC_NUMBER_FIELDS.map((field) => {
          const failure = invalidNumbers.includes(field)
          return (
            <label className={styles['modelField']} key={field}>
              <span className={styles['modelFieldLabel']}>{t(OWC_NUMBER_LABELS[field])}</span>
              <input
                className={styles['input']}
                type="text"
                inputMode="numeric"
                value={numberFieldText(draft[field])}
                placeholder={spelledDefault(props.defaults[field])}
                aria-label={t(OWC_NUMBER_LABELS[field])}
                aria-invalid={failure}
                disabled={disabled}
                onChange={(event) => { props.onNumber(field, event.target.value) }}
              />
              {failure ? <span className={styles['error']}>{t('owcNumberInvalid')}</span> : null}
            </label>
          )
        })}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('owcConnection')}</span>
        <div className={styles['probeRow']}>
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={disabled || props.connection.kind === 'busy'}
            onClick={props.onTest}
          >
            {props.connection.kind === 'busy' ? t('owcTesting') : t('owcTestConnection')}
          </button>
          {props.connection.kind === 'idle' || props.connection.kind === 'busy'
            ? null
            : props.connection.kind === 'connected'
              ? (
                <>
                  <span className={styles['probeNotice']} role="status">
                    {`${t('owcConnected')} · ${String(props.connection.count)} ${t('owcModelsFound')}`}
                  </span>
                  <span className={styles['probeNotice']}>
                    {`${t('owcLatency')} ${String(props.connection.latencyMs)} ${t('owcMillis')}`}
                  </span>
                </>
              )
              : <span className={styles['error']}>{props.connection.message}</span>}
        </div>
      </div>
    </>
  )
}
