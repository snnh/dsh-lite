/**
 * The `extraBody` field of an OWC provider profile: the text the textarea
 * holds, and what that text means.
 *
 * The textarea is text and the profile is JSON, so the two are kept together
 * by parsing on every keystroke: text that parses leaves the parsed object in
 * the draft, and text that does not is refused with a message instead of being
 * silently written or silently dropped.
 *
 * @module dsh-client-ui-settings-models/client/owcExtraBody
 */

import type { ModelsKey } from './locales.ts'

/**
 * Request-body fields the harness owns for every call. A profile that
 * redeclared one would at best be overwritten at request time and at worst
 * replace the conversation the user is having, so the card refuses them
 * outright rather than letting a save discover it.
 */
const RESERVED_BODY_FIELDS: readonly string[] = ['model', 'messages', 'stream', 'stream_options', 'tools', 'system']

/** What one `extraBody` text edit resolved to. */
export type ExtraBodyParse =
  /** Blank: the profile declares no extra fields. */
  | { readonly kind: 'empty' }
  /** A JSON object to store. */
  | { readonly kind: 'object'; readonly value: Record<string, unknown> }
  /** Unreadable JSON, or readable JSON that is not an object. */
  | { readonly kind: 'invalid' }
  /** A JSON object carrying a field the harness owns. */
  | { readonly kind: 'reserved' }

/** Whether a value is a plain JSON object rather than an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Spell a stored `extraBody` as the textarea shows it.
 * @param value - the stored value, when the profile has one.
 * @returns pretty-printed JSON, or empty text when nothing is stored.
 */
export function spellExtraBody(value: unknown): string {
  return isRecord(value) ? JSON.stringify(value, null, 2) : ''
}

/**
 * Read the textarea's text.
 * @param text - the text as typed.
 * @returns what the card may store — nothing at all, or the object — or why it cannot.
 */
export function parseExtraBody(text: string): ExtraBodyParse {
  if (text.trim().length === 0) return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { kind: 'invalid' }
  }
  if (!isRecord(parsed)) return { kind: 'invalid' }
  return Object.keys(parsed).some(key => RESERVED_BODY_FIELDS.includes(key))
    ? { kind: 'reserved' }
    : { kind: 'object', value: parsed }
}

/**
 * The copy key explaining why one edit cannot be stored.
 * @param parse - the parse of the textarea's current text.
 * @returns the message key, or `undefined` when the text is storable.
 */
export function extraBodyFailure(parse: ExtraBodyParse): ModelsKey | undefined {
  if (parse.kind === 'invalid') return 'owcExtraBodyInvalid'
  if (parse.kind === 'reserved') return 'owcExtraBodyReserved'
  return undefined
}
