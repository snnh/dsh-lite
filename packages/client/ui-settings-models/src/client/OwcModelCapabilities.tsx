/**
 * The capability bits one OWC model declares, edited inside its own row's
 * advanced fold — OWC's own model editor, on this page's row.
 *
 * Every field here is a declaration about the endpoint rather than a
 * preference: an absent capability is one this route does not claim, and the
 * request path omits rather than invents. That is why a cleared multi-select
 * removes the key instead of storing an empty array, why a box whose meaning is
 * the adapter's default removes it again when it is set back to that default,
 * and why the removals go through {@link writeModelField} — the capabilities
 * this page does not edit belong to the profile and must survive an edit to the
 * ones it does.
 *
 * The groups mirror OWC's model editor one for one: thinking modes, the
 * thinking switch the endpoint accepts, effort levels, input modalities, image
 * output, tools, reasoning replay, and signed-reasoning replay. Level and mode
 * names stay as the wire spells them, the way a model id does — a gateway with
 * its own reasoning vocabulary declares that vocabulary — while the modes and
 * styles carry a label saying what each one does, which is what OWC shows.
 *
 * Two of the boxes describe transports this adapter does not serve yet; the
 * adapter refuses those declarations by name, and the route's own diagnostic is
 * where the refusal appears. They are offered here anyway, because a
 * configuration surface that hides half of the adapter's vocabulary is what
 * makes an imported OWC document uneditable.
 *
 * @module dsh-client-ui-settings-models/client/OwcModelCapabilities
 */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import { readModelField, writeModelField } from './model-path.ts'
import type { ModelRowExtras } from './ModelListEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * The input types this family's schema declares, in OWC's own order. Handed
 * to the shared input-type editor, which otherwise offers the narrower set the
 * first-party schemas stop at.
 */
export const OWC_INPUT_MODALITIES: readonly string[] = ['text', 'image', 'video']

/** Reasoning-effort levels a model may offer, in the adapter's own order. */
const EFFORT_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Thinking modes a model may accept, with the label OWC gives each. */
const THINKING_MODES: readonly { readonly id: string; readonly labelKey: ModelsKey }[] = [
  { id: 'adaptive', labelKey: 'owcThinkingAdaptive' },
  { id: 'enabled', labelKey: 'owcThinkingEnabled' },
  { id: 'disabled', labelKey: 'owcThinkingDisabled' },
]

/**
 * How a chat-completions endpoint spells its thinking switch. The empty value
 * is the adapter's own default and stays the first option; every other entry is
 * named by the parameter it sends, as OWC names them.
 */
const THINKING_STYLES: readonly { readonly id: string; readonly labelKey: ModelsKey }[] = [
  { id: 'thinking', labelKey: 'owcStyleThinking' },
  { id: 'enable_thinking', labelKey: 'owcStyleEnableThinking' },
  { id: 'effort_only', labelKey: 'owcStyleEffortOnly' },
  { id: 'fixed', labelKey: 'owcStyleFixed' },
]

/** One box whose declaration is a plain yes, keyed by where it sits. */
interface CapabilityFlag {
  readonly path: readonly string[]
  readonly labelKey: ModelsKey
  /** The value the adapter assumes when the key is absent. */
  readonly whenAbsent: boolean
}

/** Where each editable capability sits inside a model draft. */
const CAPABILITY_PATHS: Readonly<Record<'effort' | 'thinking' | 'style', readonly string[]>> = {
  effort: ['capabilities', 'effort'],
  thinking: ['capabilities', 'thinking'],
  style: ['capabilities', 'thinkingStyle'],
}

/** The single-value declarations, in the order OWC's editor shows them. */
const FLAGS: readonly CapabilityFlag[] = [
  { path: ['capabilities', 'imageOutput'], labelKey: 'owcImageOutput', whenAbsent: false },
  { path: ['capabilities', 'tools'], labelKey: 'owcTools', whenAbsent: true },
  { path: ['capabilities', 'reasoningContent'], labelKey: 'owcReasoningContent', whenAbsent: false },
  { path: ['capabilities', 'responsesEncryptedReplay'], labelKey: 'owcEncryptedReplay', whenAbsent: false },
]

/** The declared members of one string-array capability, ignoring anything else. */
function declaredMembers(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Render one OWC model row's declared capabilities.
 * @param props - the drafted row, its position, and the row's replace action.
 * @returns the thinking, style, effort, modality, and flag controls.
 */
export function OwcModelCapabilities({ model, position, disabled, t, onChange }: ModelRowExtras): ReactNode {
  const modalities = declaredMembers(readModelField(model, ['capabilities', 'modalities']))
  const effort = declaredMembers(readModelField(model, CAPABILITY_PATHS.effort))
  const thinking = declaredMembers(readModelField(model, CAPABILITY_PATHS.thinking))
  const style = readModelField(model, CAPABILITY_PATHS.style)

  /** The `aria-label` every control in a group carries, so rows stay addressable. */
  const groupLabel = (key: ModelsKey): string => `${t(key)} ${String(position)}`

  /**
   * Add or remove one member of a multi-select. The declaration keeps the
   * adapter's own order rather than the click order, and the last removal
   * drops the key: an empty array would claim the capability exists with
   * nothing to choose from.
   */
  const toggleMember = (
    path: readonly string[],
    members: readonly string[],
    current: readonly string[],
    member: string,
    on: boolean,
  ): void => {
    const next = members.filter(value => value === member ? on : current.includes(value))
    onChange(writeModelField(model, path, next.length === 0 ? undefined : next))
  }

  /**
   * Set one single-value declaration. A box left at the value the adapter
   * already assumes drops the key, so the document keeps naming only what this
   * route declares beyond the defaults.
   */
  const setFlag = (flag: CapabilityFlag, on: boolean): void => {
    onChange(writeModelField(model, flag.path, on === flag.whenAbsent ? undefined : on))
  }

  return (
    <>
      <fieldset className={styles['modelCapabilities']} aria-label={groupLabel('owcThinking')}>
        <legend className={styles['modelFieldLabel']}>{t('owcThinking')}</legend>
        <div className={styles['modelInputChoices']}>
          {THINKING_MODES.map(mode => (
            <Checkbox
              key={mode.id}
              label={t(mode.labelKey)}
              checked={thinking.includes(mode.id)}
              disabled={disabled}
              onChange={(checked) => {
                toggleMember(CAPABILITY_PATHS.thinking, THINKING_MODES.map(entry => entry.id), thinking, mode.id, checked)
              }}
            />
          ))}
        </div>
      </fieldset>
      <label className={styles['modelField']}>
        <span className={styles['modelFieldLabel']}>{t('owcThinkingStyle')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={typeof style === 'string' ? style : ''}
          aria-label={groupLabel('owcThinkingStyle')}
          disabled={disabled}
          onChange={(event) => {
            onChange(writeModelField(model, CAPABILITY_PATHS.style,
              event.target.value === '' ? undefined : event.target.value))
          }}
        >
          <option value="">{t('owcThinkingStyleUnset')}</option>
          {THINKING_STYLES.map(choice => <option key={choice.id} value={choice.id}>{t(choice.labelKey)}</option>)}
        </select>
      </label>
      <fieldset className={styles['modelCapabilities']} aria-label={groupLabel('owcEffort')}>
        <legend className={styles['modelFieldLabel']}>{t('owcEffort')}</legend>
        <div className={styles['modelInputChoices']}>
          {EFFORT_LEVELS.map(level => (
            <Checkbox
              key={level}
              label={level}
              checked={effort.includes(level)}
              disabled={disabled}
              onChange={(checked) => { toggleMember(CAPABILITY_PATHS.effort, EFFORT_LEVELS, effort, level, checked) }}
            />
          ))}
        </div>
      </fieldset>
      {/* The vocabulary is the adapter's; the two beyond text are refused where
          they are declared, so the refusal is said beside the input types
          rather than discovered later on the saved row. */}
      {modalities.some(modality => modality !== 'text')
        ? <p className={styles['advancedHint']}>{t('owcModalityRefused')}</p>
        : null}
      {FLAGS.map((flag) => {
        const declared = readModelField(model, flag.path)
        // A box shows the meaning the adapter would apply: an absent `tools`
        // key means tool declarations are sent, so that box opens checked.
        const on = declared === undefined ? flag.whenAbsent : declared === true
        return (
          <fieldset key={flag.labelKey} className={styles['modelCapabilities']} aria-label={groupLabel(flag.labelKey)}>
            <legend className={styles['modelFieldLabel']}>{t(flag.labelKey)}</legend>
            <div className={styles['modelInputChoices']}>
              <Checkbox
                label={t(flag.labelKey)}
                checked={on}
                disabled={disabled}
                onChange={(checked) => { setFlag(flag, checked) }}
              />
            </div>
          </fieldset>
        )
      })}
    </>
  )
}
