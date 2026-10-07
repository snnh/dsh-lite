/**
 * The numeric fields of an OWC provider profile, and how their text is read
 * back.
 *
 * The card shows a field's text and stores what that text means, so the two
 * directions have to round-trip: a readable count is stored as the count, and
 * text the adapter could not accept is stored as the text itself while the
 * card refuses to write. That is what keeps an unreadable entry on screen —
 * as the characters the user typed, rather than a `NaN` the field could never
 * explain — until they correct it.
 *
 * @module dsh-client-ui-settings-models/client/owcNumbers
 */

import type { ModelsKey } from './locales.ts'

/** One numeric field of an OWC provider profile. */
export type OwcNumberField =
  | 'maxConcurrent'
  | 'streamIdleTimeoutMs'
  | 'defaultContextWindow'
  | 'defaultMaxTokens'

/** Every numeric profile field, in the order the card offers them. */
export const OWC_NUMBER_FIELDS: readonly OwcNumberField[] = [
  'maxConcurrent',
  'streamIdleTimeoutMs',
  'defaultContextWindow',
  'defaultMaxTokens',
]

/** Copy key naming each numeric field. */
export const OWC_NUMBER_LABELS: Readonly<Record<OwcNumberField, ModelsKey>> = {
  maxConcurrent: 'owcMaxConcurrent',
  streamIdleTimeoutMs: 'owcStreamIdleTimeout',
  defaultContextWindow: 'owcDefaultContextWindow',
  defaultMaxTokens: 'owcDefaultMaxTokens',
}

/**
 * Spell one numeric field's drafted value back as the field's text.
 * @param value - the drafted value: a stored count, unreadable text, or nothing.
 * @returns the text the field shows.
 */
export function numberFieldText(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? value : ''
}

/**
 * Read one numeric field's text as a whole count.
 * @param text - the field text.
 * @returns the count, or `NaN` for text that is not a whole number.
 */
export function parseOwcNumber(text: string): number {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

/**
 * The numeric fields of one drafted profile that the adapter would refuse.
 * @param profile - the drafted profile.
 * @returns the offending field names, in card order; empty when all are usable.
 */
export function invalidOwcNumbers(profile: Record<string, unknown>): OwcNumberField[] {
  return OWC_NUMBER_FIELDS.filter((field) => {
    const value = profile[field]
    if (value === undefined) return false
    return typeof value !== 'number' || !Number.isInteger(value) || value < 1
  })
}

/**
 * One numeric field's inherited default, as the placeholder of an empty field.
 * @param value - the pinned or schema-supplied default, when one exists.
 * @returns the placeholder text, or the empty string when nothing supplies one:
 * the adapter's own defaults live in its schema, and a deployment that
 * overrides them is not reflected here.
 */
export function spelledDefault(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}
