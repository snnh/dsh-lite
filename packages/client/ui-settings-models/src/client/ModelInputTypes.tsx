/** Input-type declarations shared by the DeepSeek, pi-ai, and OWC catalog editors. */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { readModelField, writeModelField } from './model-path.ts'
import type { ModelFieldPath } from './model-path.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * The label each declared input type is shown under, as pairs rather than a
 * keyed record: an object whose own key is `text` reads to the locale checker
 * as interface copy.
 */
const INPUT_TYPE_LABELS: readonly { readonly id: string; readonly labelKey: ModelsKey }[] = [
  { id: 'text', labelKey: 'modelInputText' },
  { id: 'image', labelKey: 'modelInputImage' },
  { id: 'video', labelKey: 'modelInputVideo' },
]

/** Props of {@link ModelInputTypes}. */
interface ModelInputTypesProps {
  /** Effective model row, including fields outside the curated editor. */
  model: DeepSeekModelDraft
  /**
   * Adapter-owned field: a top-level key for the families that declare input
   * types flat, or OWC's nested `capabilities.modalities`. Every family
   * inherits the types when the field is absent or empty.
   */
  field: ModelFieldPath
  /** One-based row position for the accessible group label. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Installed model or provider defaults when the row does not declare input types. */
  fallback?: readonly string[] | undefined
  /**
   * The vocabulary this family accepts, in the order its boxes are shown.
   * OWC declares video input as well; the DeepSeek and pi-ai schemas stop at
   * text and image, so the wider set arrives with the family that declares it.
   */
  modalities?: readonly string[] | undefined
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: DeepSeekModelDraft) => void
}

/**
 * Edit a nonempty set of input types, displaying inherited types before an override exists.
 * @param props - model declaration and row replacement action.
 * @returns one labeled checkbox per type in the family's vocabulary.
 */
export function ModelInputTypes({
  model, field, position, disabled, fallback, modalities, t, onChange,
}: ModelInputTypesProps): ReactNode {
  const vocabulary = modalities ?? ['text', 'image']
  const declared = readModelField(model, field)
  const selected = Array.isArray(declared) && declared.length > 0 ? declared : fallback ?? ['text']
  return (
    <fieldset className={styles['modelInputTypes']} aria-label={`${t('modelInputTypes')} ${String(position)}`}>
      <legend className={styles['modelFieldLabel']}>{t('modelInputTypes')}</legend>
      <div className={styles['modelInputChoices']}>
        {vocabulary.map(modality => (
          <Checkbox
            key={modality}
            label={t(INPUT_TYPE_LABELS.find(entry => entry.id === modality)?.labelKey ?? 'modelInputText')}
            checked={selected.includes(modality)}
            disabled={disabled || (selected.length === 1 && selected.includes(modality))}
            onChange={(checked) => {
              const nextSelected = vocabulary.filter(value =>
                value === modality ? checked : selected.includes(value))
              const next = writeModelField(model, field, [...nextSelected])
              // DeepSeek rejects image request limits on a text-only model.
              if (field === 'inputModalities' && !nextSelected.includes('image')) {
                Reflect.deleteProperty(next, 'imagePixelBudget')
                Reflect.deleteProperty(next, 'imageMaxBytes')
              }
              onChange(next)
            }}
          />
        ))}
      </div>
    </fieldset>
  )
}
