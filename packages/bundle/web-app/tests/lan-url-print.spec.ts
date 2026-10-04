/**
 * Which LAN address the ready line prints beside the application URL.
 *
 * The line carries the access token, so naming a `docker0`/`wg`/`169.254`
 * address is naming a URL the operator's browser cannot open. Selection and
 * ordering come from the LAN row's own ranking (`listLanCandidates` +
 * `rankLanCandidates`); the trust fence this bundle publishes stays a superset,
 * because `0.0.0.0` exposure is the bind's decision and not this line's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals, resolveLanTrust } from '../src/index.ts'

/** Interfaces `node:os` reports for the test in flight. */
let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {}

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => interfaces,
}))

const originalResolve = internals.resolveDistIndex

afterEach(() => {
  vi.restoreAllMocks()
  internals.resolveDistIndex = originalResolve
  interfaces = {}
})

/** One IPv4 record as `node:os` shapes it. */
function ipv4(literal: string, mac: string): NetworkInterfaceInfo {
  return { address: literal, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: `${literal}/24` }
}

/** A loopback record, which every candidate list excludes. */
const LOOPBACK: NetworkInterfaceInfo[] = [
  { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
]

/**
 * The `dsh web:` readiness line one boot prints for the given bind.
 * @param host - the webserver's bind host.
 * @returns the printed URL line, or undefined when the boot printed none.
 */
async function readyLine(host: string): Promise<string | undefined> {
  internals.resolveDistIndex = () => '/nonexistent/dist/index.html'
  const ctx = new Context()
  ctx.provide('webServer', {
    host,
    port: 4567,
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
  } as unknown as WebServer)
  ctx.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl)
      url.searchParams.set('token', 'test-token')
      return url.href
    },
  } as never)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  apply(ctx, new Config({ openBrowser: false, printUrl: true, surfaceContext: false, trustedHosts: ['lab.internal'] }))
  await new Promise(resolve => setTimeout(resolve, 0))
  const line = log.mock.calls.map(call => String(call[0])).find(message => message.startsWith('dsh web: http'))
  await ctx.fiber.dispose()
  return line
}

describe('the ready line LAN candidate', () => {
  it('ranks the display list physical-first while the fence still admits every published address', () => {
    // `0.0.0.0` exposure is the bind's decision: the fence keeps the bridge and
    // the link-local literal it publishes. Only the display list is chosen
    // (physical first, link-local dropped), and only its head is printed.
    interfaces = {
      lo0: LOOPBACK,
      docker0: [ipv4('172.17.0.1', 'aa:bb:cc:00:00:03')],
      en0: [ipv4('169.254.10.20', 'aa:bb:cc:00:00:02')],
      wlan0: [ipv4('192.168.1.5', 'aa:bb:cc:00:00:01')],
    }
    const { lanAddresses, trustedHosts } = resolveLanTrust('0.0.0.0', ['lab.internal'])
    expect(lanAddresses).toEqual(['192.168.1.5', '172.17.0.1'])
    expect(trustedHosts).toHaveLength(4)
    expect(trustedHosts).toEqual(expect.arrayContaining([
      '192.168.1.5', '169.254.10.20', '172.17.0.1', 'lab.internal',
    ]))
  })

  it('names the physical address, not the tunnel reported before it', async () => {
    // A container-style host where the tunnel enumerates first: the line names
    // the routable address rather than the first one the platform reports.
    interfaces = {
      lo0: LOOPBACK,
      wg0: [ipv4('10.9.0.2', 'aa:bb:cc:00:00:02')],
      en0: [ipv4('192.168.1.5', 'aa:bb:cc:00:00:01')],
    }
    expect(await readyLine('0.0.0.0')).toBe(
      'dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)',
    )
  })

  it('still prints the tunnel when it is the only address this machine holds', async () => {
    interfaces = { lo0: LOOPBACK, wg0: [ipv4('10.9.0.2', 'aa:bb:cc:00:00:02')] }
    expect(await readyLine('0.0.0.0')).toBe(
      'dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://10.9.0.2:4567/?token=test-token)',
    )
  })

  it('skips a link-local literal the enumeration reports before a routable one', async () => {
    interfaces = {
      lo0: LOOPBACK,
      en0: [ipv4('169.254.10.20', 'aa:bb:cc:00:00:01')],
      en1: [ipv4('192.168.1.5', 'aa:bb:cc:00:00:02')],
    }
    expect(await readyLine('0.0.0.0')).toBe(
      'dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)',
    )
  })

  it('prints no LAN link when every candidate is link-local or carries no address', async () => {
    interfaces = {
      lo0: LOOPBACK,
      en0: [ipv4('169.254.10.20', 'aa:bb:cc:00:00:01')],
      en1: [ipv4('', 'aa:bb:cc:00:00:02')],
    }
    expect(await readyLine('0.0.0.0')).toBe('dsh web: http://127.0.0.1:4567/?token=test-token')
  })

  it('prints no LAN link when this machine holds no candidate at all', async () => {
    interfaces = { lo0: LOOPBACK }
    expect(await readyLine('0.0.0.0')).toBe('dsh web: http://127.0.0.1:4567/?token=test-token')
  })

  it('keeps the loopback application URL on an all-interfaces bind', async () => {
    // `0.0.0.0` is not an address a browser can open: the local URL stays
    // loopback and only the LAN link carries the sampled interface address.
    interfaces = { lo0: LOOPBACK, en0: [ipv4('192.168.1.5', 'aa:bb:cc:00:00:01')] }
    const line = await readyLine('0.0.0.0')
    expect(line?.startsWith('dsh web: http://127.0.0.1:4567/?token=test-token')).toBe(true)
    expect(line).toContain('(LAN: http://192.168.1.5:4567/?token=test-token)')
  })

  it('prints no LAN link on a specific-address bind, whose URL already carries it', async () => {
    interfaces = { lo0: LOOPBACK, en0: [ipv4('192.168.1.5', 'aa:bb:cc:00:00:01')] }
    expect(await readyLine('192.168.1.5')).toBe('dsh web: http://192.168.1.5:4567/?token=test-token')
  })
})
