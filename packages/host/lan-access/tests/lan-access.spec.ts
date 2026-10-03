/** The opt-in network bind: what it admits, and what it refuses. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ACCESS_TOKEN_ENV, ACCESS_TOKEN_FILENAME } from '@deepseek-ai/dsh-access-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, LAN_ACCESS_SERVICE, type LanAccessValues } from '../src/index.ts'

let home: string
let tokenPath: string
const contexts: Context[] = []

const newContext = (): Context => {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

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

describe('lan-access', () => {
  it('admits loopback and asks for no token', async () => {
    const ctx = newContext()
    await apply(ctx)
    expect((ctx.get(LAN_ACCESS_SERVICE) as LanAccessValues).host).toBe('127.0.0.1')
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('admits an explicit loopback configuration without a token', async () => {
    const ctx = newContext()
    await apply(ctx, { host: '127.0.0.1' })
    expect((ctx.get(LAN_ACCESS_SERVICE) as LanAccessValues).host).toBe('127.0.0.1')
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates the persistent token a network bind requires', async () => {
    const ctx = newContext()
    await apply(ctx, { host: '0.0.0.0' })
    expect((ctx.get(LAN_ACCESS_SERVICE) as LanAccessValues).host).toBe('0.0.0.0')
    expect((await readFile(tokenPath, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/u)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
  })

  it('reuses a token a configured environment already supplies', async () => {
    const configured = 'd'.repeat(64)
    vi.stubEnv(ACCESS_TOKEN_ENV, configured)
    const ctx = newContext()
    await apply(ctx, { host: '0.0.0.0' })
    expect((ctx.get(LAN_ACCESS_SERVICE) as LanAccessValues).host).toBe('0.0.0.0')
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a network bind whose token cannot be established', async () => {
    // A regular file where the harness home belongs: resolving the token fails,
    // so no network-reachable service is provided at all.
    const blocked = join(home, 'not-a-home')
    await writeFile(blocked, 'file')
    vi.stubEnv('DSH_HOME', blocked)
    const ctx = newContext()
    await expect(apply(ctx, { host: '0.0.0.0' })).rejects.toThrow()
    expect(ctx.get(LAN_ACCESS_SERVICE)).toBeUndefined()
  })

  it('refuses a network bind whose configured token is too short', async () => {
    vi.stubEnv(ACCESS_TOKEN_ENV, 'short')
    const ctx = newContext()
    await expect(apply(ctx, { host: '0.0.0.0' })).rejects.toThrow(/at least 32 characters/u)
    expect(ctx.get(LAN_ACCESS_SERVICE)).toBeUndefined()
  })

  it('reads an existing token from the harness home', async () => {
    await mkdir(home, { recursive: true })
    await writeFile(tokenPath, `${'e'.repeat(64)}\n`)
    const ctx = newContext()
    await apply(ctx, { host: '0.0.0.0' })
    expect((ctx.get(LAN_ACCESS_SERVICE) as LanAccessValues).host).toBe('0.0.0.0')
  })
})
