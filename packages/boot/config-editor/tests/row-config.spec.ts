/**
 * Row-addressed patch writes outside the Loader: the pure document edit the
 * configuration editor shares, and the profile write a plugin activating
 * inside the Loader performs for itself.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, parseDocument } from 'yaml'
import { applyRowConfig, writeProfileRowConfig, type ProfilePatchTarget } from '../src/index.ts'

/** Parse patch text the way the writer does, `!!js` expressions included. */
function document(text: string) {
  return parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-row-config-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A profile directory whose patch file holds `text`, when given. */
function profileWith(text?: string): ProfilePatchTarget & { patchPath: string } {
  const dir = join(home, 'profiles', 'test')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile-fixture"}\n')
  const patchPath = join(dir, 'cordis.patch.yml')
  if (text !== undefined) writeFileSync(patchPath, text)
  return { dir, patchPath }
}

describe('applyRowConfig', () => {
  it('appends the row a patch does not carry yet', () => {
    const doc = document('- id: other\n  name: "@x/other"\n')
    applyRowConfig(doc, { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } })
    expect(parse(String(doc))).toEqual([
      { id: 'other', name: '@x/other' },
      { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } },
    ])
  })

  it('writes the row the patch already declares, leaving its siblings alone', () => {
    const doc = document([
      '- id: lan-access',
      '  name: "@x/lan"',
      '',
      '- id: lan-access',
      '  name: "@x/other-lan"',
      '  config:',
      '    host: 192.168.1.5',
      '',
    ].join('\n'))
    applyRowConfig(doc, { id: 'lan-access', name: '@x/lan', config: { host: '127.0.0.1' } })
    expect(parse(String(doc))).toEqual([
      { id: 'lan-access', name: '@x/lan', config: { host: '127.0.0.1' } },
      { id: 'lan-access', name: '@x/other-lan', config: { host: '192.168.1.5' } },
    ])
  })

  it('removes the config of a row returned to its inherited value, and a row left bare', () => {
    const doc = document([
      '- id: lan-access',
      '  name: "@x/lan"',
      '  config:',
      '    host: 0.0.0.0',
      '',
      '- id: kept',
      '  name: "@x/kept"',
      '  config:',
      '    host: 10.0.0.1',
      '',
      '- insert:',
      '    - id: lan-access',
      '',
      '- id: lan-access',
      '  name: "@x/lan"',
      '  config:',
      '    host: 127.0.0.1',
      '',
      '- bare',
      '',
    ].join('\n'))
    applyRowConfig(doc, { id: 'lan-access', name: '@x/lan', config: undefined })
    // A row that holds only its identity disappears; an `insert` row and a
    // plain scalar are never addressed.
    expect(parse(String(doc))).toEqual([
      { id: 'kept', name: '@x/kept', config: { host: '10.0.0.1' } },
      { insert: [{ id: 'lan-access' }] },
      'bare',
    ])
  })

  it('keeps `!!js` expressions and rewrites the ones a caller passes as expressions', () => {
    const doc = document([
      '- id: webserver',
      '  name: "@x/webserver"',
      '  config:',
      '    port: !!js ctx.webStartup.port ?? 3080',
      '',
    ].join('\n'))
    applyRowConfig(doc, { id: 'lan-access', name: '@x/lan', config: { host: { __jsExpr: 'ctx.webStartup.host' } } })
    const text = String(doc)
    expect(text).toContain('port: !!js ctx.webStartup.port ?? 3080')
    expect(text).toContain('host: !!js ctx.webStartup.host')
  })

  it('refuses a document that is not a sequence', () => {
    expect(() => { applyRowConfig(document('{}\n'), { id: 'x', name: '@x/y', config: {} }) })
      .toThrow(/must be a YAML sequence/u)
  })
})

describe('writeProfileRowConfig', () => {
  it('creates an absent patch file with owner-only permissions', async () => {
    const profile = profileWith()
    await writeProfileRowConfig(profile, { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe([
      '- id: lan-access',
      '  name: "@x/lan"',
      '  config:',
      '    host: 0.0.0.0',
      '',
    ].join('\n'))
    expect(statSync(profile.patchPath).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent writers of one patch file under the profile lock', async () => {
    const profile = profileWith('- id: webserver\n  name: "@x/webserver"\n')
    await Promise.all([
      writeProfileRowConfig(profile, { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } }),
      writeProfileRowConfig(profile, { id: 'webserver', name: '@x/webserver', config: { host: '0.0.0.0' } }),
      writeProfileRowConfig(profile, { id: 'third', name: '@x/third', config: { host: '10.0.0.1' } }),
    ])
    expect(parse(readFileSync(profile.patchPath, 'utf8'))).toEqual([
      { id: 'webserver', name: '@x/webserver', config: { host: '0.0.0.0' } },
      { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } },
      { id: 'third', name: '@x/third', config: { host: '10.0.0.1' } },
    ])
  })

  it('leaves a patch it cannot parse exactly as it was', async () => {
    const profile = profileWith('- id: [\n')
    await expect(writeProfileRowConfig(profile, { id: 'lan-access', name: '@x/lan', config: { host: '0.0.0.0' } }))
      .rejects.toThrow()
    expect(readFileSync(profile.patchPath, 'utf8')).toBe('- id: [\n')
  })
})
