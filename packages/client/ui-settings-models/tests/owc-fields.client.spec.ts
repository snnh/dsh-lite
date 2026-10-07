/**
 * The OWC family's pure helpers: nested model paths, the numeric profile
 * fields' text round-trip, and the extra-body JSON parse.
 */
import { describe, expect, it } from 'vitest'
import { readModelField, segmentsOf, writeModelField } from '../src/client/model-path.ts'
import {
  invalidOwcNumbers, numberFieldText, OWC_NUMBER_FIELDS, OWC_NUMBER_LABELS, parseOwcNumber, spelledDefault,
} from '../src/client/owcNumbers.ts'
import { extraBodyFailure, parseExtraBody, spellExtraBody } from '../src/client/owcExtraBody.ts'

describe('model field paths', () => {
  it('names the segments of a flat key and of a nested path', () => {
    expect(segmentsOf('input')).toEqual(['input'])
    expect(segmentsOf(['capabilities', 'modalities'])).toEqual(['capabilities', 'modalities'])
  })

  it('reads a flat field, a nested one, and one whose container is missing', () => {
    expect(readModelField({ input: ['text'] }, 'input')).toEqual(['text'])
    expect(readModelField({ capabilities: { modalities: ['text'] } }, ['capabilities', 'modalities'])).toEqual(['text'])
    // A row that declares no capabilities at all still answers: absent, not a
    // TypeError halfway down a path its schema never materialized.
    expect(readModelField({ id: 'm' }, ['capabilities', 'modalities'])).toBeUndefined()
    expect(readModelField({ capabilities: 'text' }, ['capabilities', 'modalities'])).toBeUndefined()
    expect(readModelField({ capabilities: ['text'] }, ['capabilities', 'modalities'])).toBeUndefined()
    const model = { id: 'm' }
    expect(readModelField(model, [])).toBe(model)
  })

  it('writes a flat field and removes it when the value is unset', () => {
    expect(writeModelField({ id: 'm' }, 'input', ['text', 'image'])).toEqual({ id: 'm', input: ['text', 'image'] })
    expect(writeModelField({ id: 'm', input: ['text'] }, 'input', undefined)).toEqual({ id: 'm' })
  })

  it('writes a nested field without dropping the capability keys beside it', () => {
    const model = { id: 'm', capabilities: { thinkingStyle: 'fixed', effort: ['low'] } }
    expect(writeModelField(model, ['capabilities', 'modalities'], ['text', 'image'])).toEqual({
      id: 'm',
      capabilities: { thinkingStyle: 'fixed', effort: ['low'], modalities: ['text', 'image'] },
    })
    // The row itself is never mutated: the next edit reads what this one wrote.
    expect(model.capabilities).toEqual({ thinkingStyle: 'fixed', effort: ['low'] })
  })

  it('materializes a missing container, and replaces one that is not an object', () => {
    expect(writeModelField({ id: 'm' }, ['capabilities', 'modalities'], ['text'])).toEqual({
      id: 'm',
      capabilities: { modalities: ['text'] },
    })
    expect(writeModelField({ id: 'm', capabilities: 'text' }, ['capabilities', 'reasoningContent'], true)).toEqual({
      id: 'm',
      capabilities: { reasoningContent: true },
    })
    expect(writeModelField({ id: 'm', capabilities: ['text'] }, ['capabilities', 'reasoningContent'], true)).toEqual({
      id: 'm',
      capabilities: { reasoningContent: true },
    })
  })

  it('removes a nested field, and the container once it is the last one', () => {
    expect(writeModelField(
      { id: 'm', capabilities: { effort: ['low'], thinkingStyle: 'fixed' } },
      ['capabilities', 'effort'],
      undefined,
    )).toEqual({ id: 'm', capabilities: { thinkingStyle: 'fixed' } })
    expect(writeModelField({ id: 'm', capabilities: { effort: ['low'] } }, ['capabilities', 'effort'], undefined))
      .toEqual({ id: 'm' })
  })

  it('leaves the row alone for a path that names no segment', () => {
    const model = { id: 'm' }
    expect(writeModelField(model, [], 'ignored')).toBe(model)
  })
})

describe('numeric profile fields', () => {
  it('spells a stored count, unreadable text, and nothing at all', () => {
    expect(numberFieldText(3)).toBe('3')
    // Kept as text so an unreadable entry stays on screen while it is refused.
    expect(numberFieldText('3ms')).toBe('3ms')
    expect(numberFieldText(undefined)).toBe('')
    expect(numberFieldText(true)).toBe('')
  })

  it.each([
    ['8', 8],
    [' 8 ', 8],
    ['0', 0],
    ['abc', Number.NaN],
    ['1.5', Number.NaN],
    ['', Number.NaN],
    ['1e3', Number.NaN],
  ])('reads %j as %j', (text, expected) => {
    expect(parseOwcNumber(text)).toBe(expected)
  })

  it('names the fields the adapter would refuse, in card order', () => {
    expect(invalidOwcNumbers({})).toEqual([])
    expect(invalidOwcNumbers({ maxConcurrent: 3, streamIdleTimeoutMs: 300_000 })).toEqual([])
    expect(invalidOwcNumbers({ maxConcurrent: 'abc' })).toEqual(['maxConcurrent'])
    expect(invalidOwcNumbers({ maxConcurrent: 1.5 })).toEqual(['maxConcurrent'])
    expect(invalidOwcNumbers({ maxConcurrent: 0 })).toEqual(['maxConcurrent'])
    expect(invalidOwcNumbers({ maxConcurrent: 1, defaultMaxTokens: 0, streamIdleTimeoutMs: 'x' }))
      .toEqual(['streamIdleTimeoutMs', 'defaultMaxTokens'])
  })

  it('shows an inherited default, or nothing when the schema declares none', () => {
    expect(spelledDefault(262_144)).toBe('262144')
    expect(spelledDefault(undefined)).toBe('')
  })

  it('labels every field it edits', () => {
    expect(OWC_NUMBER_FIELDS.map(field => OWC_NUMBER_LABELS[field])).toEqual([
      'owcMaxConcurrent', 'owcStreamIdleTimeout', 'owcDefaultContextWindow', 'owcDefaultMaxTokens',
    ])
  })
})

describe('extra request body', () => {
  it('spells a stored object as pretty JSON and anything else as empty text', () => {
    expect(spellExtraBody({ temperature: 0.2, top_p: 0.9 })).toBe('{\n  "temperature": 0.2,\n  "top_p": 0.9\n}')
    expect(spellExtraBody(undefined)).toBe('')
    expect(spellExtraBody([1, 2])).toBe('')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['{"temperature":0.2}', 'object'],
    ['[1]', 'invalid'],
    ['not json', 'invalid'],
    ['{"tools":[]}', 'reserved'],
    ['{"stream_options":{"include_usage":true}}', 'reserved'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(parseExtraBody(text).kind).toBe(kind)
  })

  it('carries the parsed object, and refuses only the top-level fields it owns', () => {
    expect(parseExtraBody('{"temperature":0.2}')).toEqual({ kind: 'object', value: { temperature: 0.2 } })
    // A nested key is the endpoint's own business: only the request's own
    // top-level fields belong to the harness.
    expect(parseExtraBody('{"metadata":{"tools":1}}').kind).toBe('object')
  })

  it('explains a refusal with the copy key of its cause', () => {
    expect(extraBodyFailure(parseExtraBody('nope'))).toBe('owcExtraBodyInvalid')
    expect(extraBodyFailure(parseExtraBody('{"system":"x"}'))).toBe('owcExtraBodyReserved')
    expect(extraBodyFailure(parseExtraBody('{"temperature":0.2}'))).toBeUndefined()
    expect(extraBodyFailure(parseExtraBody(''))).toBeUndefined()
  })
})
