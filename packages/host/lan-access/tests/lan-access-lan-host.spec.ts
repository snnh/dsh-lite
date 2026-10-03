/**
 * The LAN-host question, and the candidate ordering it and the bind address
 * agree on.
 *
 * The machine's own interfaces are the default fixture: every assertion that
 * speaks about "this machine" reads whatever `node:os` reports here and
 * compares results with each other, so the suite holds on a workstation and on
 * a container with only loopback. Cases that need a machine this host is not —
 * a laptop whose only address is a tunnel, an interface answering to two names
 * — inject that machine's addresses through the `node:os` seam below.
 */

import type { NetworkInterfaceInfo } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  detectLanAddress,
  isLanHost,
  isVirtualInterface,
  listLanCandidates,
  rankLanCandidates,
  type LanCandidate,
} from '../src/index.ts'

/** The MAC a real interface reports, and the literal one without a MAC uses. */
const SOME_MAC = 'bc:24:11:aa:b6:9e'
const ABSENT_MAC = '00:00:00:00:00:00'

// `node:os` is the seam every case here shares: the fixture starts unset, which
// makes `networkInterfaces` answer with this machine's own interfaces, and a
// case that needs a different machine sets the dict it wants. Hoisted because
// the mock factory runs while the module under test is imported, before this
// file's own statements.
const state = vi.hoisted(() => ({
  machine: undefined as NodeJS.Dict<NetworkInterfaceInfo[]> | undefined,
  fixtures: undefined as NodeJS.Dict<NetworkInterfaceInfo[]> | undefined,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  state.machine ??= actual.networkInterfaces()
  return { ...actual, networkInterfaces: () => state.fixtures ?? state.machine }
})

/** One IPv4 address as `node:os` reports it. */
const ipv4 = (address: string, mac: string = SOME_MAC, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac,
  internal,
  cidr: `${address}/24`,
})

/** One candidate as `listLanCandidates` would report it. */
const candidate = (address: string, iface: string): LanCandidate => ({
  address,
  iface,
  virtual: isVirtualInterface(iface),
})

beforeEach(() => {
  // Unset means "this machine", the fixture every case starts from.
  state.fixtures = undefined
})

describe('isLanHost', () => {
  it('matches the candidate list on this machine', () => {
    expect(isLanHost()).toBe(listLanCandidates().some(entry => !entry.virtual))
  })

  it('agrees with the default bind address this machine resolves', () => {
    // A LAN here is exactly the case where the row has an address to bind;
    // the converse does not hold, because a machine holding only a tunnel
    // still binds that tunnel.
    if (listLanCandidates().some(entry => !entry.virtual)) {
      expect(detectLanAddress()).toBeDefined()
    }
    expect(typeof isLanHost()).toBe('boolean')
  })

  it('reports a LAN when an interface carries a network of its own', () => {
    state.fixtures = {
      lo: [ipv4('127.0.0.1', ABSENT_MAC, true)],
      ens18: [ipv4('192.168.1.5')],
      'br-1a426df6dda3': [ipv4('172.20.0.1', '96:4d:8a:6a:63:59')],
    }
    expect(isLanHost()).toBe(true)
  })

  it('reports no LAN when every address belongs to a bridge or a tunnel', () => {
    state.fixtures = {
      'br-1a426df6dda3': [ipv4('172.20.0.1', '96:4d:8a:6a:63:59')],
      tailscale0: [ipv4('100.64.0.1', ABSENT_MAC)],
    }
    expect(isLanHost()).toBe(false)
    // The two questions stay distinct: this machine still has an address the
    // row would bind, it is just not a LAN address.
    expect(detectLanAddress()).toBe('172.20.0.1')
  })

  it('reports no LAN on a machine with only loopback', () => {
    state.fixtures = { lo: [ipv4('127.0.0.1', ABSENT_MAC, true)] }
    expect(isLanHost()).toBe(false)
    expect(detectLanAddress()).toBeUndefined()
  })
})

describe('listLanCandidates ordering', () => {
  it('keeps the addresses of one interface in one run, names in order', () => {
    state.fixtures = {
      'eth0:1': [ipv4('10.0.0.7')],
      lo: [ipv4('127.0.0.1', ABSENT_MAC, true)],
      eth0: [ipv4('192.168.1.5'), ipv4('192.168.1.6')],
    }
    expect(listLanCandidates().map(entry => entry.address)).toEqual([
      '192.168.1.5',
      '192.168.1.6',
      '10.0.0.7',
    ])
  })

  it('leaves two MAC-less interfaces in the order the platform reports them', () => {
    state.fixtures = {
      wg0: [ipv4('10.9.0.1', ABSENT_MAC)],
      tun0: [ipv4('10.8.0.1', ABSENT_MAC)],
      tailscale0: [ipv4('100.64.0.1', ABSENT_MAC)],
    }
    expect(listLanCandidates().map(entry => entry.address)).toEqual([
      '10.9.0.1',
      '10.8.0.1',
      '100.64.0.1',
    ])
  })

  it('reports the same candidates with or without an interface alias', () => {
    state.fixtures = {
      eth0: [ipv4('192.168.1.5')],
      'eth0:1': [ipv4('10.0.0.7')],
    }
    const aliased = listLanCandidates().map(entry => entry.address)
    state.fixtures = { eth0: [ipv4('192.168.1.5'), ipv4('10.0.0.7')] }
    expect(new Set(aliased)).toEqual(new Set(listLanCandidates().map(entry => entry.address)))
  })
})

describe('rankLanCandidates grouping', () => {
  it('keeps the addresses of one interface adjacent and in order, bridges last', () => {
    // One MAC carrying two addresses is one interface carrying two addresses,
    // because a candidate names its interface and not its MAC.
    const ranked = rankLanCandidates([
      candidate('172.20.0.1', 'br-1a426df6dda3'),
      candidate('192.168.1.5', 'ens18'),
      candidate('192.168.1.6', 'ens18'),
      candidate('100.64.0.1', 'tailscale0'),
      candidate('10.0.0.7', 'wlan0'),
    ])
    expect(ranked.map(entry => entry.address)).toEqual([
      '192.168.1.5',
      '192.168.1.6',
      '10.0.0.7',
      '172.20.0.1',
      '100.64.0.1',
    ])
  })

  it('keeps the addresses of a virtual interface adjacent too', () => {
    const ranked = rankLanCandidates([
      candidate('172.20.0.1', 'br-1a426df6dda3'),
      candidate('192.168.1.5', 'ens18'),
      candidate('172.20.0.2', 'br-1a426df6dda3'),
    ])
    expect(ranked.map(entry => entry.address)).toEqual([
      '192.168.1.5',
      '172.20.0.1',
      '172.20.0.2',
    ])
  })
})
