/**
 * Where one model row's field sits inside its draft.
 *
 * The adapter families disagree about the shape: pi-ai and DeepSeek declare a
 * row's input types flat (`input`, `inputModalities`), while an OWC model
 * nests them under `capabilities`. Both spellings travel through the helpers
 * here, so one field editor serves every family and a nested edit cannot drop
 * the sibling capability keys the row declares.
 *
 * @module dsh-client-ui-settings-models/client/model-path
 */

/** A model draft's field: a top-level key, or the path to a nested one. */
export type ModelFieldPath = string | readonly string[]

/**
 * The segments one field path names.
 * @param field - a top-level key or a nested path.
 * @returns the segments, in order.
 */
export function segmentsOf(field: ModelFieldPath): readonly string[] {
  return typeof field === 'string' ? [field] : field
}

/**
 * Read one model field, flat or nested.
 * @param model - the drafted row.
 * @param field - the field's location inside it.
 * @returns the value, or `undefined` when the path is absent or a container on
 * the way to it is not an object (an empty path reads the row itself).
 */
export function readModelField(model: Record<string, unknown>, field: ModelFieldPath): unknown {
  let current: unknown = model
  for (const segment of segmentsOf(field)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Write one model field immutably, preserving every sibling — including the
 * capability keys this page does not edit. An `undefined` value removes the
 * leaf, and a container the removal empties goes with it: a row left carrying
 * an empty `capabilities` object would satisfy its schema while telling a
 * reader nothing.
 * @param model - the drafted row.
 * @param field - the field's location inside it.
 * @param value - the replacement value, or `undefined` to remove the field.
 * @returns a copied row carrying the change; the row itself for an empty path.
 */
export function writeModelField(
  model: Record<string, unknown>,
  field: ModelFieldPath,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segmentsOf(field)
  if (head === undefined) return model
  const next = { ...model }
  if (rest.length === 0) {
    if (value === undefined) Reflect.deleteProperty(next, head)
    else next[head] = value
    return next
  }
  const child = next[head]
  const nested = writeModelField(
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? child as Record<string, unknown>
      : {},
    rest,
    value,
  )
  if (Object.keys(nested).length === 0) Reflect.deleteProperty(next, head)
  else next[head] = nested
  return next
}
