/**
 * The composed web rows over a real profile: `--host` reaches the bind through
 * the lan-access row, a first enable persists the shipped posture into the
 * profile's own patch, and the next boot reads that posture back instead of
 * writing it again.
 *
 * The fixture is the composition the bundle ships, minus every row this
 * decision does not involve: the real `web-startup` and `lan-access` plugins,
 * a Bundle patch mounting them with the same `inject: [webStartup]` the shipped
 * patch declares, and a reader row that reads `ctx.lanAccess.host` the way the
 * webserver row does.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply as lanAccessApply } from '@deepseek-ai/dsh-host-lan-access'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as webStartupApply } from '../src/startup.ts'

/** What the fixture rows observed during one boot. */
interface Observed {
  /** `ctx.lanAccess.host`, as the reader row saw it. */
  lanAccessHost: string | undefined
  /** The reader row's composed config, whose `host` is `!!js ctx.lanAccess.host`. */
  readerConfig: { host?: string } | undefined
  /** Every warning the startup log carried, in order. */
  warnings: string[]
}

const observed: Observed = { lanAccessHost: undefined, readerConfig: undefined, warnings: [] }
const homes: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  observed.lanAccessHost = undefined
  observed.readerConfig = undefined
  observed.warnings = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A profile of one bundle whose patch mounts the three fixture rows. */
function profileFixture(): { profile: ProfileContext; lanRow: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-lan-composition-')))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  const dir = join(home, 'profiles', 'lan')
  initProfile(dir, ['lan-bundle'])
  const rows = join(home, 'rows')
  mkdirSync(rows, { recursive: true })
  const url = (file: string, source: string): string => {
    const path = join(rows, file)
    writeFileSync(path, source)
    return pathToFileURL(path).href
  }
  let lanRow = ''
  const bundle = join(dir, 'node_modules', 'lan-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'lan-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: web-startup',
    `      name: ${url('web-startup.mjs', [
      "export const name = 'web-startup'",
      "export const inject = ['cmdlineArgs']",
      'export const apply = ctx => globalThis.__webStartupApply(ctx)',
      '',
    ].join('\n'))}`,
    '    - id: lan-access',
    `      name: ${lanRow = url('lan-access.mjs', [
      "export const name = 'lan-access'",
      'export const apply = (ctx, config) => globalThis.__lanAccessApply(ctx, config)',
      '',
    ].join('\n'))}`,
    '      inject: [webStartup]',
    '    - id: reader',
    `      name: ${url('reader.mjs', [
      "export const name = 'reader'",
      "export const inject = ['lanAccess']",
      'export function apply(ctx, config) {',
      '  globalThis.__observed.readerConfig = config',
      '  globalThis.__observed.lanAccessHost = ctx.lanAccess.host',
      '}',
      '',
    ].join('\n'))}`,
    '      inject: [lanAccess]',
    '      config:',
    '        host: !!js ctx.lanAccess.host',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'lan', startedBundles: ['lan-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  return { profile, lanRow }
}

/** Boot the composed rows against a fresh temp home, then a reused profile. */
async function bootWith(profile: ProfileContext, args: readonly string[]): Promise<Context> {
  const globals = globalThis as unknown as { __lanAccessApply: typeof lanAccessApply; __webStartupApply: typeof webStartupApply }
  globals.__lanAccessApply = lanAccessApply
  globals.__webStartupApply = webStartupApply
  ;(globalThis as unknown as { __observed: Observed }).__observed = observed
  const ctx = await boot('lan', join(profile.dir, 'cordis.yml'), readProfilePatches('lan', profile), (host) => {
    host.provide('profileContext', profile)
    provideCmdline(host, { args, exit: () => {} })
    host.logger.exporter({
      levels: { default: 3 },
      export: ({ type, args: logged }) => {
        if (type === 'warn') observed.warnings.push(String(logged[0]))
      },
    })
  })
  contexts.push(ctx)
  return ctx
}

describe('web composition over the lan-access row', () => {
  it('composes the shipped posture on the first enable and writes nothing', async () => {
    const { profile } = profileFixture()
    const before = readFileSync(profile.patchPath, 'utf8')
    await bootWith(profile, [])
    expect(observed.lanAccessHost).toBe('0.0.0.0')
    expect(observed.readerConfig).toEqual({ host: '0.0.0.0' })
    // The default comes from the schema, not from an edit: a row that wrote
    // here would make the Loader reconcile a changed entry, and the web server
    // reading this host would rebind on a new port after the start printed its
    // URL.
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
    expect(observed.warnings.join('\n')).toContain('bound 0.0.0.0')
    expect(observed.warnings.join('\n')).toContain(profile.patchPath)
  })

  it('obeys a posture the operator states in the profile patch', async () => {
    const { profile, lanRow } = profileFixture()
    await bootWith(profile, [])
    // The operator states a posture; a later start must obey the patch rather
    // than this release's default, and must not rewrite the line.
    writeFileSync(profile.patchPath, [
      `- id: lan-access`,
      `  name: ${lanRow}`,
      '  config:',
      '    host: 10.1.2.3',
      '',
    ].join('\n'))
    observed.warnings = []
    const stated = readFileSync(profile.patchPath, 'utf8')
    await bootWith(profile, [])
    expect(observed.lanAccessHost).toBe('10.1.2.3')
    expect(observed.readerConfig).toEqual({ host: '10.1.2.3' })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(stated)
    expect(observed.warnings.join('\n')).toContain('bound 10.1.2.3')
  })

  it('binds an explicit --host over the persisted posture, and writes nothing for it', async () => {
    const { profile } = profileFixture()
    await bootWith(profile, [])
    const persisted = readFileSync(profile.patchPath, 'utf8')
    await bootWith(profile, ['--host', '192.168.1.5', '--no-open'])
    expect(observed.lanAccessHost).toBe('192.168.1.5')
    expect(observed.readerConfig).toEqual({ host: '192.168.1.5' })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(persisted)
  })

  it('keeps the loopback-only posture when --host asks for it', async () => {
    const { profile } = profileFixture()
    await bootWith(profile, [])
    observed.warnings = []
    await bootWith(profile, ['--host', '127.0.0.1'])
    expect(observed.lanAccessHost).toBe('127.0.0.1')
    expect(observed.warnings).toEqual([])
  })
})
