/**
 * The candidate ordering: one interface's addresses stay together, and the
 * order inside and between the runs is the platform's, not the order
 * `node:os` happened to enumerate entries in.
 *
 * Every case states the machine it wants through the `node:os` seam below,
 * because the property under test is about a shape a container host and a
 * workstation need not have — an interface alias, two MAC-less interfaces.
 */

import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  isVirtualInterface,
  listLanCandidates,
  rankLanCandidates,
  type LanCandidate,
} from '../src/index.ts'

/** The MAC a real interface reports, and the literal one without a MAC uses. */
const SOME_MAC = 'bc:24:11:aa:b6:9e'
const ABSENT_MAC = '00:00:00:00:00:00'

/** One IPv4 address as `node:os` reports it. */
const ipv4 = (address: string, mac: string = SOME_MAC, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac,
  internal,
  cidr: `${address}/24`,
})

// The `node:os` seam, as in the sibling suites: a case states the machine it
// wants by naming that machine's interfaces. Hoisted because the mock factory
// runs while the module under test is imported, before this file's statements.
const state = vi.hoisted(() => ({ dict: {} as NodeJS.Dict<NetworkInterfaceInfo[]> }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => state.dict,
}))

/** One candidate as `listLanCandidates` would report it. */
const candidate = (address: string, iface: string): LanCandidate => ({
  address,
  iface,
  virtual: isVirtualInterface(iface),
})

describe('listLanCandidates ordering', () => {
  it('keeps the addresses of one interface in one run, names in order', () => {
    state.dict = {
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
    state.dict = {
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
    state.dict = {
      eth0: [ipv4('192.168.1.5')],
      'eth0:1': [ipv4('10.0.0.7')],
    }
    const aliased = listLanCandidates().map(entry => entry.address)
    state.dict = { eth0: [ipv4('192.168.1.5'), ipv4('10.0.0.7')] }
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
