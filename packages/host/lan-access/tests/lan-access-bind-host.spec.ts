/**
 * The bind-host grammar: the one table every host this row will bind is read
 * through, and the refusal a stated host outside it earns.
 *
 * The table is exhaustive on purpose. The row and the settings page that
 * persists its posture share this classification, so a shape that one admits
 * and the other refuses is a posture that can be saved and then never start —
 * the failure this suite exists to make impossible.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ACCESS_TOKEN_FILENAME } from '@deepseek-ai/dsh-access-token'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  classifyBindHost,
  isLoopbackHost,
  LAN_ACCESS_SERVICE,
  LOOPBACK_HOST,
  type BindHostKind,
  type LanAccessValues,
} from '../src/index.ts'

/** Every host the grammar accepts, with the kind it must classify as. */
const ACCEPTED: readonly (readonly [string, BindHostKind])[] = [
  // Every loopback spelling, which names this machine alone however the stack
  // spells it: the names, the mapped literals, a dotted-quad tail, a zone, and
  // the rest of the loopback network.
  ['127.0.0.1', 'loopback'],
  ['localhost', 'loopback'],
  ['::1', 'loopback'],
  ['[::1]', 'loopback'],
  ['127.0.0.2', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['::0.0.0.1', 'loopback'],
  ['::1%lo', 'loopback'],
  // The IPv4 wildcard: every IPv4 interface, and no IPv6 one.
  ['0.0.0.0', 'wildcard'],
  // Any other IPv4 literal, the whole IPv4 form space included.
  ['192.168.1.5', 'address'],
  ['10.0.0.1', 'address'],
  ['255.255.255.255', 'address'],
]

/** Every host the grammar refuses, with what is wrong with it. */
const REFUSED: readonly (readonly [string, string])[] = [
  ['', 'nothing stated at all'],
  ['   ', 'whitespace only'],
  [' 127.0.0.1', 'leading whitespace'],
  ['127.0.0.1 ', 'trailing whitespace'],
  ['\t127.0.0.1', 'a tab in place of the leading space'],
  ['0'.repeat(46), 'one character past the length bound'],
  ['::', 'the IPv6 wildcard, which this row does not publish'],
  ['fe80::1', 'a non-loopback IPv6 literal'],
  ['2001:db8::1', 'a non-loopback IPv6 literal'],
  ['::ffff:0.0.0.0', 'the IPv4 wildcard in its mapped spelling, which is not the literal this row publishes'],
  ['fe80::1%lo', 'a non-loopback IPv6 literal, zone or not'],
  ['example.com', 'a hostname'],
  ['localhost.', 'a hostname that only looks like localhost'],
  ['999.1.1.1', 'an IPv4 literal with an out-of-range octet'],
  ['1.2.3', 'an incomplete IPv4 literal'],
  ['192.168.1.5:3080', 'an address with a port attached'],
]

let home: string
const contexts: Context[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-lan-grammar-'))
  vi.stubEnv('DSH_HOME', home)
  // The exposure warning of an accepted non-loopback bind has its own suite;
  // keep it out of this one's output.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** A context under test, disposed with the suite. */
function contextOf(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const provided = (ctx: Context): LanAccessValues | undefined => ctx.get(LAN_ACCESS_SERVICE)
const tokenPath = (): string => join(home, ACCESS_TOKEN_FILENAME)

/** A profile whose patch file does not exist yet: a fixture for the write path. */
function unwrittenProfile(): ProfileContext {
  const dir = join(home, 'profiles', 'grammar')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile-fixture"}\n')
  return {
    name: 'grammar', startedBundles: [], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
}

/** The failure one refused activation produced. */
async function refusalOf(run: () => Promise<void>): Promise<Error> {
  const failure = await run().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  return failure as Error
}

describe('classifyBindHost', () => {
  it('classifies every accepted shape, loopback spellings included', () => {
    for (const [host, kind] of ACCEPTED) {
      expect([host, classifyBindHost(host)]).toEqual([host, kind])
    }
  })

  it('refuses every shape this row cannot bind', () => {
    for (const [host, reason] of REFUSED) {
      expect([host, classifyBindHost(host), reason]).toEqual([host, undefined, reason])
    }
  })

  it('answers isLoopbackHost from the same table', () => {
    for (const [host] of ACCEPTED) {
      expect([host, isLoopbackHost(host)]).toEqual([host, classifyBindHost(host) === 'loopback'])
    }
    for (const [host] of REFUSED) {
      expect([host, isLoopbackHost(host)]).toEqual([host, false])
    }
  })
})

describe('resolveHost, through apply', () => {
  it('admits a loopback IPv6 bind as a loopback bind', async () => {
    const ctx = contextOf()
    await apply(ctx, { host: '::1' })
    // Loopback means "this machine alone", so the IPv6 spelling needs no token
    // and earns no warning — exactly like its IPv4 counterpart.
    expect(provided(ctx)?.host).toBe('::1')
    expect(existsSync(tokenPath())).toBe(false)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('refuses an unbindable --host instead of falling back to the row config', async () => {
    const ctx = contextOf()
    ctx.provide('webStartup', { host: '::' })
    const failure = await refusalOf(() => apply(ctx, { host: LOOPBACK_HOST }))
    // The row config states a bindable address, and the invocation outranks it;
    // refusing beats quietly binding the config's.
    expect(provided(ctx)).toBeUndefined()
    expect(failure.message).toContain('refusing to bind "::"')
    expect(failure.message).toContain('binds an IPv4 address or a loopback address only')
    expect(failure.message).toContain('any loopback spelling — 127.0.0.1, localhost, ::1, [::1]')
    expect(failure.message).toContain('0.0.0.0, the IPv4 wildcard, for every IPv4 interface this machine holds')
    expect(failure.message).toContain('never an IPv6 one')
    expect(failure.message).toContain('an IPv6 literal that names no loopback address (:: included)')
    expect(failure.message).toContain('anything longer than 45 characters')
    expect(failure.message).toContain('"host:" configuration')
    expect(failure.message).toContain('--host 127.0.0.1 for one run')
    expect(failure.message).toContain('web-address settings page')
    // Nothing downstream of the decision ran: no token for a bind that never
    // happened, and no posture persisted.
    expect(existsSync(tokenPath())).toBe(false)
  })

  it('refuses an unbindable row config instead of binding the shipped posture', async () => {
    const ctx = contextOf()
    const profile = unwrittenProfile()
    ctx.provide('profileContext', profile)
    const failure = await refusalOf(() => apply(ctx, { host: 'example.com' }))
    expect(provided(ctx)).toBeUndefined()
    expect(failure.message).toContain('refusing to bind "example.com"')
    // The first-run persist is not a fallback for a value the row cannot bind.
    expect(existsSync(profile.patchPath)).toBe(false)
  })

  it('refuses a padded or over-long stated host, never rewriting it', async () => {
    for (const host of [' 127.0.0.1', '0'.repeat(46)]) {
      const ctx = contextOf()
      const failure = await refusalOf(() => apply(ctx, { host }))
      expect(provided(ctx)).toBeUndefined()
      expect(failure.message).toContain(`refusing to bind ${JSON.stringify(host)}`)
    }
  })

  it('still treats an empty stated host as unstated, binding the shipped posture', async () => {
    const ctx = contextOf()
    ctx.provide('webStartup', { host: '' })
    await apply(ctx, { host: '' })
    // The contrast that keeps the refusal from swallowing the "name nothing"
    // case: an empty value is not a bad host, it is no host.
    expect(provided(ctx)?.host).toBe('0.0.0.0')
  })
})
