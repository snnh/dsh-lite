/**
 * The bind-host grammar of the `webHost` namespace, read against the row's own
 * authority.
 *
 * The page and the row must agree on what a bind host is, or an operator can
 * save a posture the next start refuses — so every case here is stated twice:
 * once as what `save` does with the value, and once as what the lan-access
 * row's shared classification says about it. A `::1` the page admits is a `::1`
 * a start can bind, and a `::` it refuses is one no start would bind either.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Context as Cordis } from '@deepseek-ai/cordis'
import type { ProfilePatchTarget, RowConfig } from '@deepseek-ai/dsh-config-editor'
import { classifyBindHost } from '@deepseek-ai/dsh-host-lan-access'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsController from '../src/index.ts'
import type { WebHostController } from '../src/web-host.ts'

/**
 * The patch writer, recorded rather than run: this suite is about the grammar a
 * save states, and the file it lands in is the other suite's subject.
 */
const patchWriter = vi.hoisted(() => ({ rows: [] as RowConfig[] }))

vi.mock('@deepseek-ai/dsh-config-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-config-editor')>()
  return {
    ...actual,
    writeProfileRowConfig: async (_profile: ProfilePatchTarget, row: RowConfig): Promise<void> => {
      patchWriter.rows.push(row)
    },
  }
})

/** The plugin specifier a write states when the profile composes no such row. */
const LAN_ACCESS_ROW_NAME = '@deepseek-ai/dsh-host-lan-access'

/** Every host a save must admit, with its kind from the row's own authority. */
const ACCEPTED: readonly (readonly [string, string])[] = [
  ['127.0.0.1', 'loopback'],
  ['localhost', 'loopback'],
  // The unified semantics: these name this machine alone exactly as the IPv4
  // literal does, so the page that persists a posture admits them too.
  ['::1', 'loopback'],
  ['[::1]', 'loopback'],
  ['0.0.0.0', 'wildcard'],
  ['192.168.1.5', 'address'],
  ['10.0.0.9', 'address'],
  ['255.255.255.255', 'address'],
]

/** Every host a save must refuse, with a fragment of the reason it states. */
const REFUSED: readonly (readonly [string, string])[] = [
  ['', 'no surrounding whitespace'],
  ['   ', 'no surrounding whitespace'],
  [' 127.0.0.1', 'no surrounding whitespace'],
  ['127.0.0.1 ', 'no surrounding whitespace'],
  ['0'.repeat(46), 'at most 45 characters'],
  ['::', 'is neither an IPv4 address nor a loopback name'],
  ['fe80::1', 'is neither an IPv4 address nor a loopback name'],
  ['::ffff:127.0.0.1', 'is neither an IPv4 address nor a loopback name'],
  ['example.com', 'is neither an IPv4 address nor a loopback name'],
  ['localhost.', 'is neither an IPv4 address nor a loopback name'],
  ['999.1.1.1', 'is neither an IPv4 address nor a loopback name'],
  ['192.168.1.5:3080', 'is neither an IPv4 address nor a loopback name'],
]

const contexts: Context[] = []

beforeEach(() => {
  patchWriter.rows = []
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** The controller over a profile that has a patch file to write into. */
async function controllerOf(): Promise<WebHostController> {
  const ctx = new Cordis()
  contexts.push(ctx)
  ctx.provide('profileContext', { dir: '/tmp/web-host-grammar', patchPath: '/tmp/web-host-grammar/cordis.patch.yml' })
  await ctx.plugin(SettingsController)
  return ctx.webHostController
}

/** The refusal one save produced, or undefined when it was admitted. */
async function refusalOf(controller: WebHostController, host: string): Promise<unknown> {
  return controller.save(host).then(() => undefined, (error: unknown) => error)
}

describe('the webHost save grammar and the row that binds what it saves', () => {
  it('admits every loopback spelling the row admits, ::1 and [::1] included', async () => {
    const controller = await controllerOf()
    for (const [host, kind] of ACCEPTED) {
      expect([host, classifyBindHost(host)]).toEqual([host, kind])
      await controller.save(host)
    }
    expect(patchWriter.rows.map(row => row.config?.host)).toEqual(ACCEPTED.map(([host]) => host))
    // Every line addresses the row the row itself would persist into, so the
    // next start reads the address back as its composed config.
    expect(patchWriter.rows[0]).toEqual({
      id: 'lan-access',
      name: LAN_ACCESS_ROW_NAME,
      config: { host: '127.0.0.1' },
    })
  })

  it('refuses every shape the row cannot bind, with the reason it states', async () => {
    const controller = await controllerOf()
    for (const [host, reason] of REFUSED) {
      expect(classifyBindHost(host)).toBeUndefined()
      const refusal = remoteErrorOf(await refusalOf(controller, host))
      expect([host, refusal?.code]).toEqual([host, 'web-host/rejected'])
      expect([host, refusal?.details]).toEqual([host, { host }])
      expect([host, refusal?.message.includes(reason)]).toEqual([host, true])
    }
    expect(patchWriter.rows).toEqual([])
  })

  it('agrees with the row case for case, refusing exactly what the row cannot bind', async () => {
    const controller = await controllerOf()
    const hosts = [
      ...ACCEPTED.map(([host]) => host),
      ...REFUSED.map(([host]) => host),
      // Shapes neither table lists, decided by the shared classification alone.
      '127.0.0.2', '0.0.0.0', 'fd00::1', '[::]', 'localhost\n', '10.0.0.9',
    ]
    for (const host of hosts) {
      const refusal = await refusalOf(controller, host)
      expect([host, refusal !== undefined]).toEqual([host, classifyBindHost(host) === undefined])
      if (refusal === undefined) expect(patchWriter.rows.at(-1)?.config?.host).toBe(host)
    }
  })
})
