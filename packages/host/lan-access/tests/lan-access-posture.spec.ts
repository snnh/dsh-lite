/**
 * The shipped posture: what this row binds with no stated host, that it writes
 * nothing while deciding, and what it says in the startup log about an address
 * anything on the network may reach.
 *
 * The row must not touch the profile patch. A write there makes the Loader
 * reconcile a changed entry, and the web server — which reads this host through
 * its own configuration — tears down and binds again on a new port while the
 * URL the start already printed goes stale.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ACCESS_TOKEN_FILENAME } from '@deepseek-ai/dsh-access-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  BIND_ALL_HOST,
  LAN_ACCESS_SERVICE,
  LOOPBACK_HOST,
  type LanAccessValues,
} from '../src/index.ts'

let home: string
const contexts: Context[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-lan-posture-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** A context under test; services are provided only when the case needs them. */
function contextOf(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const provided = (ctx: Context): LanAccessValues | undefined => ctx.get(LAN_ACCESS_SERVICE)
const tokenPath = (): string => join(home, ACCESS_TOKEN_FILENAME)

/** The warn spy of one context, whose calls the cases assert against. */
const watcher = (ctx: Context) => vi.spyOn(ctx.logger, 'warn')

describe('lan-access shipped posture', () => {
  it('binds every IPv4 interface with no stated host and writes nothing', async () => {
    const ctx = contextOf()
    await apply(ctx)
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
    // Nothing under the harness home was created for the decision itself: only
    // the token the reachable bind requires.
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
    expect((readFileSync(tokenPath(), 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/u)
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600)
  })

  it('takes a host the operator stated', async () => {
    const ctx = contextOf()
    const warn = watcher(ctx)
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('192.168.1.5')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bound 192.168.1.5'))
  })

  it('lets --host outrank the row config', async () => {
    const ctx = contextOf()
    ctx.provide('webStartup', { host: '10.0.0.9' })
    await apply(ctx, { host: '192.168.1.5' })
    expect(provided(ctx)?.host).toBe('10.0.0.9')
  })

  it('treats an empty flag or config value as unstated', async () => {
    const ctx = contextOf()
    ctx.provide('webStartup', { host: '' })
    await apply(ctx, { host: '' })
    expect(provided(ctx)?.host).toBe(BIND_ALL_HOST)
  })

  it('stays silent on a loopback bind, creating no token', async () => {
    const ctx = contextOf()
    const warn = watcher(ctx)
    await apply(ctx, { host: LOOPBACK_HOST })
    expect(provided(ctx)?.host).toBe(LOOPBACK_HOST)
    expect(warn).not.toHaveBeenCalled()
    expect(existsSync(tokenPath())).toBe(false)
  })

  it('warns what it exposed, what guards it, and how to narrow it', async () => {
    const ctx = contextOf()
    const warn = watcher(ctx)
    await apply(ctx)
    expect(warn).toHaveBeenCalledTimes(1)
    // What is bound, what the token is worth, and both ways back to a narrow
    // posture — the exposure warning's whole job.
    for (const fragment of [
      `bound ${BIND_ALL_HOST}, reachable by anything that can route to it`,
      'every IPv4 interface this machine holds, container bridges included, and never an IPv6 one',
      'The persistent access token is the only authenticator on that surface',
      `set "host: ${LOOPBACK_HOST}" in the profile patch cordis.patch.yml`,
      'or one LAN address such as 192.168.1.5 to publish a single network',
      '--host 127.0.0.1 does the same for one run',
    ]) expect(warn).toHaveBeenCalledWith(expect.stringContaining(fragment))
    // The token itself never reaches the log.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(readFileSync(tokenPath(), 'utf8').trim()))
  })
})
