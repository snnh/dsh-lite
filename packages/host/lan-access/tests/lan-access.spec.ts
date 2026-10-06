/** The network-exposure row: what it binds by default, and what it refuses. */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ACCESS_TOKEN_ENV, ACCESS_TOKEN_FILENAME } from '@deepseek-ai/dsh-access-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  detectLanAddress,
  isLoopbackHost,
  LAN_ACCESS_SERVICE,
  type LanAccessValues,
} from '../src/index.ts'

let home: string
let tokenPath: string
const contexts: Context[] = []

const newContext = (): Context => {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const provided = (ctx: Context): LanAccessValues | undefined => ctx.get(LAN_ACCESS_SERVICE)

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-lan-access-'))
  tokenPath = join(home, ACCESS_TOKEN_FILENAME)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

describe('detectLanAddress', () => {
  it('reports a non-internal IPv4 address or nothing at all', () => {
    const detected = detectLanAddress()
    if (detected === undefined) return
    expect(detected).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
    expect(detected.startsWith('127.')).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes every loopback spelling', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('treats any other address as reachable', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('lan-access', () => {
  it('binds every IPv4 interface by default and authenticates it', async () => {
    const ctx = newContext()
    await apply(ctx)
    // The shipped posture is the wildcard, and a reachable bind always carries
    // the persistent token.
    expect(provided(ctx)?.host).toBe('0.0.0.0')
    expect((await readFile(tokenPath, 'utf8')).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  })

  it('asks nothing of an explicit loopback bind', async () => {
    const ctx = newContext()
    await apply(ctx, { host: '127.0.0.1' })
    expect(provided(ctx)?.host).toBe('127.0.0.1')
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('admits every interface when asked, and creates the token it needs', async () => {
    const ctx = newContext()
    await apply(ctx, { host: '0.0.0.0' })
    expect(provided(ctx)?.host).toBe('0.0.0.0')
    expect((await readFile(tokenPath, 'utf8')).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
  })

  it('admits one explicit network address with the same requirement', async () => {
    const ctx = newContext()
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('192.168.1.5')
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
  })

  it('reuses a token the environment already supplies', async () => {
    vi.stubEnv(ACCESS_TOKEN_ENV, 'd'.repeat(64))
    const ctx = newContext()
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('192.168.1.5')
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a network bind whose configured token is too short', async () => {
    vi.stubEnv(ACCESS_TOKEN_ENV, 'short')
    const ctx = newContext()
    await expect(apply(ctx, { host: '192.168.1.5' })).rejects.toThrow(/at least 32 characters/u)
    expect(provided(ctx)).toBeUndefined()
  })

  it('refuses a network bind whose token cannot be established', async () => {
    // A regular file where the harness home belongs: resolving the token fails,
    // so no network-reachable service is provided at all.
    const blocked = join(home, 'not-a-home')
    await writeFile(blocked, 'file')
    vi.stubEnv('DSH_HOME', blocked)
    const ctx = newContext()
    await expect(apply(ctx, { host: '192.168.1.5' })).rejects.toThrow()
    expect(provided(ctx)).toBeUndefined()
  })
})
