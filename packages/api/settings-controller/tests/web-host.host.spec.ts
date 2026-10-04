/**
 * The `webHost` Remote namespace over a real profile: the posture a web-address
 * page renders, the write that persists the next start's address into the
 * profile's own patch, and everything a save must NOT do — reconcile the
 * Loader, move the running bind, or establish the access token a non-loopback
 * start will demand.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { NetworkInterfaceInfo } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import type { ProfilePatchTarget, RowConfig } from '@deepseek-ai/dsh-config-editor'
import { detectLanAddress } from '@deepseek-ai/dsh-host-lan-access'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsController from '../src/index.ts'
import type { WebHostController } from '../src/web-host.ts'

/**
 * The patch writer, switchable to fail with a value that is not an Error: a
 * foreign writer reached through the same seam can reject with anything, and a
 * refusal that carries "[object Object]" instead of the reason is not a
 * diagnostic. Every case but that one delegates to the real writer, and each
 * save's row is recorded so a case can assert the identity it addressed.
 */
const patchWriter = vi.hoisted(() => ({
  failure: undefined as unknown,
  rows: [] as RowConfig[],
}))

vi.mock('@deepseek-ai/dsh-config-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-config-editor')>()
  return {
    ...actual,
    writeProfileRowConfig: async (profile: ProfilePatchTarget, row: RowConfig): Promise<void> => {
      patchWriter.rows.push(row)
      if (patchWriter.failure !== undefined) throw patchWriter.failure
      await actual.writeProfileRowConfig(profile, row)
    },
  }
})

/**
 * The interfaces `node:os` reports, so the detected address is the same on
 * every host: a physical LAN address, a container bridge beside it, and
 * loopback, which is never detected.
 */
const state = vi.hoisted(() => ({ dict: {} as NodeJS.Dict<NetworkInterfaceInfo[]> }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => state.dict,
}))

/** One IPv4 address as `node:os` reports it. */
const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: 'bc:24:11:aa:b6:9e',
  internal,
  cidr: `${address}/24`,
})

/** The plugin specifier of the row a profile composes for the bind host. */
const LAN_ACCESS_ROW_NAME = '@deepseek-ai/dsh-host-lan-access'

/** What one fixture boot observed, so a case can assert on the live services. */
interface Fixture {
  readonly ctx: Context
  readonly controller: WebHostController
  readonly profile: ProfileContext
  readonly home: string
  /** Counts of the `app-boot/config-reload` event, which no save may produce. */
  readonly reloads: { count: number }
}

const homes: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  patchWriter.failure = undefined
  patchWriter.rows = []
  state.dict = { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('192.168.1.5')], docker0: [ipv4('172.17.0.1')] }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * A real profile: a bundle layer that composes the bind-host row the way the
 * web bundle does, and the profile's own patch stating the posture an operator
 * persisted earlier. The row mounts disabled — this namespace reads the
 * composed row's options, not the row's own runtime — and the address it
 * published at startup is provided the way the mounted row would.
 * @param options - the row id to compose under, and the profile's persisted config.
 * @returns the booted context, the mounted controller, and the profile facts.
 */
async function profileFixture(
  options: { rowId?: string; composed?: boolean; persisted?: readonly [string, string][] } = {},
): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'web-host-')))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const rowId = options.rowId ?? 'lan-access'
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const rows = options.composed === false ? [] : [
    `    - id: ${rowId}`,
    `      name: ${JSON.stringify(LAN_ACCESS_ROW_NAME)}`,
    '      disabled: true',
  ]
  writeFileSync(join(bundle, 'cordis.patch.yml'), ['- insert:', ...rows, ''].join('\n'))
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, options.persisted === undefined ? '[]\n' : [
    `- id: ${rowId}`,
    '  config:',
    ...options.persisted.map(([key, value]) => `    ${key}: ${value}`),
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath,
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (host) => {
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    // `--host 10.1.2.3`: the invocation's pin, which outranks the persisted line.
    host.provide('webStartup', { host: '10.1.2.3' })
    // The address the composed row published, as the webserver row reads it.
    host.provide('lanAccess', { host: '127.0.0.1' })
  })
  contexts.push(ctx)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsController)
  const reloads = { count: 0 }
  ctx.on('app-boot/config-reload', () => { reloads.count += 1 })
  return { ctx, controller: ctx.webHostController, profile, home, reloads }
}

/** The profile patch's text. */
const patchText = (fixture: Fixture): string => readFileSync(fixture.profile.patchPath, 'utf8')

/** One rejection's RemoteError. */
const refusal = (failure: unknown) => remoteErrorOf(failure)

describe('the webHost Remote namespace a web-address page calls', () => {
  it('publishes the namespace from its own service key, with both operations', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SettingsController)
    const controller = ctx.webHostController
    expect(controller.typertRemote.serviceKey).toBe('webHostController')
    expect(controller.typertRemote.namespace).toBe('webHost')
    expect(remoteMethods(controller)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'save', invocation: { kind: 'direct' } },
    ])
  })

  it('reads each fact that decides the next bind separately', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9']] })
    const status = fixture.controller.status()
    expect(status).toEqual({
      rowFound: true,
      // What this process bound, what the profile persists, what the invocation
      // pinned, and what the machine detects are four different addresses, and
      // the page shows all four: a save moves only the profile's.
      bound: '127.0.0.1',
      persisted: '10.0.0.9',
      pinned: '10.1.2.3',
      detected: '192.168.1.5',
      writable: true,
    })
    // The detection is the row's own answer: the page shows what this machine
    // reports, not a copy the Host kept.
    expect(status.detected).toBe(detectLanAddress())
  })

  it('reports no detected address on a machine with only loopback', async () => {
    state.dict = { lo: [ipv4('127.0.0.1', true)] }
    const fixture = await profileFixture()
    expect(fixture.controller.status()).toEqual({
      rowFound: true,
      bound: '127.0.0.1',
      pinned: '10.1.2.3',
      writable: true,
    })
  })

  it('persists an address into the profile patch and rebinds nothing', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9']] })
    const edit = vi.spyOn(fixture.ctx.configEditor, 'edit')
    expect(readdirSync(fixture.home).sort()).toEqual(['package.json', 'profiles'])
    const saved = await fixture.controller.save('0.0.0.0')
    // The write lands on the line the profile already states, addressed by the
    // id the composition used; the row's module specifier stays where it is,
    // on the bundle layer that composes it.
    expect(patchText(fixture)).toBe([
      '- id: lan-access',
      '  config:',
      '    host: 0.0.0.0',
      '',
    ].join('\n'))
    expect(statSync(fixture.profile.patchPath).mode & 0o777).toBe(0o600)
    expect(saved).toEqual({
      rowFound: true,
      bound: '127.0.0.1',
      persisted: '0.0.0.0',
      pinned: '10.1.2.3',
      detected: '192.168.1.5',
      writable: true,
    })
    expect(patchWriter.rows).toEqual([
      { id: 'lan-access', name: LAN_ACCESS_ROW_NAME, config: { host: '0.0.0.0' } },
    ])
    // Startup configuration only: no Loader reconcile, and no token for the
    // non-loopback address, which is the next start's business alone.
    expect(fixture.reloads.count).toBe(0)
    expect(edit).not.toHaveBeenCalled()
    expect(readdirSync(fixture.home).sort()).toEqual(['package.json', 'profiles'])
  })

  it('keeps the row config a save does not own', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9'], ['futureKey', 'kept']] })
    expect(fixture.controller.status().persisted).toBe('10.0.0.9')
    await fixture.controller.save('192.168.1.5')
    expect(patchWriter.rows).toEqual([
      { id: 'lan-access', name: LAN_ACCESS_ROW_NAME, config: { host: '192.168.1.5', futureKey: 'kept' } },
    ])
    expect(patchText(fixture)).toContain('futureKey: kept')
  })

  it('addresses the row the profile composes, never a shipped id', async () => {
    const fixture = await profileFixture({ rowId: 'web-lan', persisted: [['host', '10.0.0.9']] })
    expect(fixture.controller.status()).toMatchObject({ rowFound: true, persisted: '10.0.0.9' })
    await fixture.controller.save('127.0.0.1')
    expect(patchWriter.rows).toEqual([
      { id: 'web-lan', name: LAN_ACCESS_ROW_NAME, config: { host: '127.0.0.1' } },
    ])
    expect(patchText(fixture)).toBe([
      '- id: web-lan',
      '  config:',
      '    host: 127.0.0.1',
      '',
    ].join('\n'))
  })

  it('mounts without a lan-access row and persists under the shipped identity', async () => {
    const fixture = await profileFixture({ composed: false })
    expect(fixture.controller.status()).toEqual({
      rowFound: false,
      bound: '127.0.0.1',
      pinned: '10.1.2.3',
      detected: '192.168.1.5',
      writable: true,
    })
    // The row is still not composed, so no fact about it appears: the line is
    // written for a composition that mounts the row later, and one that never
    // does skips it in the patch lane rather than failing its boot.
    expect(await fixture.controller.save('192.168.1.5')).not.toHaveProperty('persisted')
    expect(patchText(fixture)).toBe([
      '- id: lan-access',
      `  name: ${JSON.stringify(LAN_ACCESS_ROW_NAME)}`,
      '  config:',
      '    host: 192.168.1.5',
      '',
    ].join('\n'))
  })

  it('states the row identity when the profile has never persisted a host', async () => {
    const fixture = await profileFixture()
    expect(fixture.controller.status()).toEqual({
      rowFound: true,
      bound: '127.0.0.1',
      pinned: '10.1.2.3',
      detected: '192.168.1.5',
      writable: true,
    })
    await fixture.controller.save('192.168.1.5')
    // Nothing addressed the row before, so this patch states its identity
    // beside the config: the layer a later start merges the address from.
    expect(patchText(fixture)).toBe([
      '- id: lan-access',
      `  name: ${JSON.stringify(LAN_ACCESS_ROW_NAME)}`,
      '  config:',
      '    host: 192.168.1.5',
      '',
    ].join('\n'))
  })

  it('reports a value the Loader evaluates as no persisted host', async () => {
    const fixture = await profileFixture({ persisted: [['host', '!!js ctx.webStartup.host']] })
    // The line is an expression the next start evaluates, not an address this
    // page can show or overwrite in place.
    expect(fixture.controller.status()).not.toHaveProperty('persisted')
    expect(patchText(fixture)).toContain('host: !!js ctx.webStartup.host')
  })

  it('accepts localhost and every IPv4 literal, refusing nothing else', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9']] })
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '192.168.1.5', '255.255.255.255']) {
      expect((await fixture.controller.save(host)).persisted).toBe(host)
      expect(patchText(fixture)).toContain(`    host: ${host}`)
    }
  })

  it('refuses every address outside the grammar with its reason', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9']] })
    const before = patchText(fixture)
    const cases: readonly (readonly [string, string])[] = [
      ['', 'must be a non-empty address with no surrounding whitespace'],
      ['   ', 'must be a non-empty address with no surrounding whitespace'],
      [' 127.0.0.1', 'must be a non-empty address with no surrounding whitespace'],
      ['127.0.0.1 ', 'must be a non-empty address with no surrounding whitespace'],
      ['0'.repeat(46), 'a bind host is at most 45 characters'],
      ['::1', 'is an IPv6 address: this row publishes IPv4 interfaces only'],
      ['fe80::1', 'is an IPv6 address: this row publishes IPv4 interfaces only'],
      ['[::1]', 'is neither an IPv4 address nor localhost'],
      ['example.com', 'is neither an IPv4 address nor localhost'],
      ['999.1.1.1', 'is neither an IPv4 address nor localhost'],
      ['192.168.1.5:3080', 'is neither an IPv4 address nor localhost'],
    ]
    for (const [host, reason] of cases) {
      const failure = await fixture.controller.save(host).catch((error: unknown) => error)
      expect(refusal(failure)).toMatchObject({ code: 'web-host/rejected', details: { host } })
      expect(refusal(failure)?.message).toContain(reason)
    }
    expect(patchText(fixture)).toBe(before)
  })

  it('refuses a save whose patch file cannot be read or written', async () => {
    const fixture = await profileFixture({ persisted: [['host', '10.0.0.9']] })
    rmSync(fixture.profile.patchPath)
    mkdirSync(fixture.profile.patchPath)
    const failure = await fixture.controller.save('0.0.0.0').catch((error: unknown) => error)
    expect(refusal(failure)).toMatchObject({
      code: 'web-host/rejected',
      message: expect.stringContaining('the profile patch refused the bind host: ') as string,
      details: { host: '0.0.0.0' },
    })
  })

  it('carries a refusal that is not an Error as its own text', async () => {
    const fixture = await profileFixture()
    patchWriter.failure = 'the disk is full'
    const failure = await fixture.controller.save('0.0.0.0').catch((error: unknown) => error)
    expect(refusal(failure)).toMatchObject({
      code: 'web-host/rejected',
      message: 'the profile patch refused the bind host: the disk is full',
      details: { host: '0.0.0.0' },
    })
  })

  it('reads as read-only outside a launched profile and refuses the write', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SettingsController)
    const controller = ctx.webHostController
    expect(controller.status()).toEqual({
      rowFound: false,
      detected: '192.168.1.5',
      writable: false,
    })
    const failure = await controller.save('127.0.0.1').catch((error: unknown) => error)
    expect(refusal(failure)).toMatchObject({
      code: 'web-host/rejected',
      message: expect.stringContaining('no profile patch to persist a bind host in') as string,
      details: { host: '127.0.0.1' },
    })
  })
})
