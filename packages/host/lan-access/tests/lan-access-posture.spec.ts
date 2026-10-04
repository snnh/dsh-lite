/**
 * The persisted posture: when this row writes `host: 0.0.0.0` into a profile,
 * when it leaves the profile alone, and what it says in the startup log about
 * an address anything on the network may reach.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ACCESS_TOKEN_FILENAME } from '@deepseek-ai/dsh-access-token'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  BIND_ALL_HOST,
  detectLanAddress,
  LAN_ACCESS_SERVICE,
  LOOPBACK_HOST,
  type LanAccessValues,
} from '../src/index.ts'

/** The row this plugin persists its posture in, as the patch file spells it. */
const ROW = '- id: lan-access\n  name: "@deepseek-ai/dsh-host-lan-access"\n'

let home: string
const contexts: Context[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-lan-posture-'))
  vi.stubEnv('DSH_HOME', home)
  // The posture warning must reach the console even when the logger exporter
  // filters warn records; keep it off the test output while asserting it.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** A context under test; services are provided only when the case needs them. */
function contextOf(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** A profile whose patch file holds `patch`, when one is given. */
function profileWith(patch?: string): ProfileContext {
  const dir = join(home, 'profiles', 'lan')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"profile-fixture"}\n')
  const patchPath = join(dir, 'cordis.patch.yml')
  if (patch !== undefined) writeFileSync(patchPath, patch)
  return {
    name: 'lan', startedBundles: [], dir, patchPath,
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
}

const provided = (ctx: Context): LanAccessValues | undefined => ctx.get(LAN_ACCESS_SERVICE)
const tokenPath = (): string => join(home, ACCESS_TOKEN_FILENAME)

/** The warn spy of one context, whose calls the cases assert against. */
const watcher = (ctx: Context) => vi.spyOn(ctx.logger, 'warn')

describe('lan-access persisted posture', () => {
  it('persists the shipped posture into the profile patch on the first enable and binds it', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    ctx.provide('webStartup', {})
    await apply(ctx)
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(`${ROW}  config:\n    host: ${BIND_ALL_HOST}\n`)
    expect(statSync(profile.patchPath).mode & 0o777).toBe(0o600)
  })

  it('persists into the row the Loader is actually running', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    Object.defineProperty(ctx.fiber, 'entry', {
      configurable: true,
      value: { options: { id: 'custom-lan', name: '@example/custom-lan-access' } },
    })
    await apply(ctx)
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(
      '- id: custom-lan\n  name: "@example/custom-lan-access"\n  config:\n    host: 0.0.0.0\n',
    )
  })

  it('leaves a profile that already states a host alone', async () => {
    const persisted = `${ROW}  config:\n    host: ${BIND_ALL_HOST}\n`
    const profile = profileWith(persisted)
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    // A later start composes the persisted value back, so the row states one
    // and the write is skipped: the posture is stable across releases.
    await apply(ctx, { host: BIND_ALL_HOST })
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(persisted)
  })

  it('takes a host the operator stated, and persists nothing for it', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    const warn = watcher(ctx)
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('192.168.1.5')
    expect(existsSync(profile.patchPath)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bound 192.168.1.5'))
  })

  it('lets --host outrank both the persisted posture and the row config', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    ctx.provide('webStartup', { host: '10.0.0.9' })
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('10.0.0.9')
    expect(existsSync(profile.patchPath)).toBe(false)
  })

  it('treats an empty flag or config value as unstated', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    ctx.provide('webStartup', { host: '' })
    await apply(ctx, { host: '' })
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    expect(readFileSync(profile.patchPath, 'utf8')).toContain(`host: ${BIND_ALL_HOST}`)
  })

  it('binds this machine\u2019s LAN address when there is no profile to persist into', async () => {
    const ctx = contextOf()
    await apply(ctx)
    expect(provided(ctx)?.host).toBe(detectLanAddress() ?? LOOPBACK_HOST)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('binds the shipped posture anyway and says so when the profile cannot be written', async () => {
    const ctx = contextOf()
    // A profile directory that does not exist: the patch write cannot take its
    // lock, so the posture stands for this run and the failure is reported.
    ctx.provide('profileContext', {
      name: 'lan', startedBundles: [], dir: join(home, 'absent'),
      patchPath: join(home, 'absent', 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    })
    const warn = watcher(ctx)
    await apply(ctx)
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`could not persist host ${BIND_ALL_HOST}`))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`bound ${BIND_ALL_HOST}`))
  })

  it('warns what it exposed, what guards it, and how to narrow it', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    const warn = watcher(ctx)
    await apply(ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    // What is bound, what the token is worth, and both ways back to a narrow
    // posture — the exposure warning's whole job.
    for (const fragment of [
      `bound ${BIND_ALL_HOST}, reachable by anything that can route to it`,
      'every IPv4 interface this machine holds, container bridges included, and never an IPv6 one',
      'The persistent access token is the only authenticator on that surface',
      `set "host: ${LOOPBACK_HOST}" in ${profile.patchPath}`,
      'or one LAN address such as 192.168.1.5 to publish a single network',
      '--host 127.0.0.1 does the same for one run',
    ]) expect(warn).toHaveBeenCalledWith(expect.stringContaining(fragment))
    // The token itself never reaches the log.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(readFileSync(tokenPath(), 'utf8').trim()))
    // The same warning reaches the console the default web exporter would
    // otherwise filter away.
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`bound ${BIND_ALL_HOST}`))
  })

  it('stays silent on a loopback bind, creating no token and writing no posture', async () => {
    const profile = profileWith()
    const ctx = contextOf()
    ctx.provide('profileContext', profile)
    const warn = watcher(ctx)
    await apply(ctx, { host: LOOPBACK_HOST })
    expect(provided(ctx)?.host).toBe(LOOPBACK_HOST)
    expect(warn).not.toHaveBeenCalled()
    expect(existsSync(tokenPath())).toBe(false)
    expect(existsSync(profile.patchPath)).toBe(false)
  })
})
