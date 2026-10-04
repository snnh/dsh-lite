/**
 * The interface-name table: what each platform mints for the interfaces that
 * carry no LAN, and what it mints for the ones that do.
 *
 * The name is the whole signal, so the table is the behaviour: a name this
 * file pins as virtual ranks behind every name it pins as real, and a name it
 * pins as real can win the bind. The table is a list of prefixes with no
 * exemption, so a name that opens like a bridge or a tunnel — whatever machine
 * minted it — is pinned here as virtual.
 */

import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  detectLanAddress,
  isVirtualInterface,
  listLanCandidates,
  rankLanCandidates,
} from '../src/index.ts'

/** One IPv4 address as `node:os` reports it. */
const ipv4 = (address: string, mac = 'bc:24:11:aa:b6:9e'): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac,
  internal: false,
  cidr: `${address}/24`,
})

// The `node:os` seam, as in the sibling suites: a case states the machine it
// wants by naming that machine's interfaces.
const state = vi.hoisted(() => ({ dict: {} as NodeJS.Dict<NetworkInterfaceInfo[]> }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => state.dict,
}))

/**
 * Every name the table calls virtual: the Linux container and tunnel grammar,
 * the macOS bridge/AirDrop/WiFi-companion grammar, and the Windows Hyper-V
 * switch grammar. A platform never mints another platform's names, so one
 * table holds the union.
 */
const VIRTUAL_NAMES = [
  // Linux: bridges, veth pairs, hypervisor switches, tunnels, overlays.
  'docker0', 'br-1a426df6dda3', 'br-02468ace1357', 'veth9963a84', 'virbr0', 'vmnet8', 'vboxnet0',
  'tun0', 'tap0', 'utun3', 'wg0', 'zt7ff1c2ab9d0e1234', 'tailscale0',
  // Every `br-` name is virtual, a router's own LAN bridge included: the name
  // alone cannot tell one bridge from another.
  'br-guest',
  // macOS: its own VM bridge, AirDrop, and the low-latency WLAN companion.
  'bridge0', 'bridge100', 'awdl0', 'llw0',
  // Windows: every Hyper-V virtual switch, named after the switch it serves.
  'vEthernet (Default Switch)', 'vEthernet (WSL)',
] as const

/** Names a platform mints for the interface that carries the operator's LAN. */
const REAL_NAMES = [
  'eth0', 'ens18', 'enp0s31f6', 'en0', 'wlan0', 'wlp3s0', 'en7',
] as const

describe('isVirtualInterface name table', () => {
  it('marks every bridge, container link, tunnel, and platform shim virtual', () => {
    for (const iface of VIRTUAL_NAMES) expect(isVirtualInterface(iface)).toBe(true)
  })

  it('leaves the names a physical interface carries alone', () => {
    for (const iface of REAL_NAMES) expect(isVirtualInterface(iface)).toBe(false)
  })

  it('demotes a bridge by its prefix alone, whoever minted the name', () => {
    // A bridge is a `br-` name: the table reads the prefix and stops there, so
    // a bridge whose name is not a container-network id loses the rank too —
    // and a machine whose only address is that bridge still binds it, because
    // a demoted candidate is ranked, never dropped.
    for (const iface of ['br-1a426df6dda3', 'br-guest']) {
      expect(isVirtualInterface(iface)).toBe(true)
    }
  })
})

describe('the name table as the ranking reads it', () => {
  it('ranks a machine\'s physical interface ahead of the bridges and shims beside it', () => {
    state.dict = {
      ens18: [ipv4('192.168.1.5')],
      'br-1a426df6dda3': [ipv4('172.20.0.1', '96:4d:8a:6a:63:59')],
      docker0: [ipv4('172.17.0.1', '02:42:1f:0a:2b:3c')],
      awdl0: [ipv4('169.254.9.3', '00:00:00:00:00:00')],
    }
    expect(listLanCandidates().map(entry => entry.iface)).toEqual([
      'ens18', 'br-1a426df6dda3', 'docker0', 'awdl0',
    ])
    expect(rankLanCandidates(listLanCandidates()).map(entry => entry.address)).toEqual([
      '192.168.1.5', '172.20.0.1', '172.17.0.1', '169.254.9.3',
    ])
    expect(detectLanAddress()).toBe('192.168.1.5')
  })

  it('binds a bridge anyway when it is the only address the machine holds', () => {
    state.dict = { 'br-guest': [ipv4('192.168.1.1')] }
    expect(rankLanCandidates(listLanCandidates()).map(entry => entry.address)).toEqual(['192.168.1.1'])
    expect(detectLanAddress()).toBe('192.168.1.1')
  })

  it('demotes a macOS machine whose only LAN address is a VM bridge', () => {
    state.dict = {
      bridge0: [ipv4('192.168.64.1', '5e:11:9f:2a:41:7c')],
      utun3: [ipv4('100.64.0.7', '00:00:00:00:00:00')],
    }
    // Ranked last, never dropped: the row still has an address to bind.
    expect(rankLanCandidates(listLanCandidates()).map(entry => entry.iface)).toEqual(['bridge0', 'utun3'])
    expect(detectLanAddress()).toBe('192.168.64.1')
  })

  it('demotes a Windows Hyper-V switch behind the physical adapter', () => {
    state.dict = {
      'vEthernet (Default Switch)': [ipv4('172.28.128.1', '00:15:5d:0a:2b:3c')],
      'Ethernet 2': [ipv4('192.168.123.50', '3c:52:82:11:22:33')],
    }
    expect(rankLanCandidates(listLanCandidates()).map(entry => entry.iface)).toEqual([
      'Ethernet 2', 'vEthernet (Default Switch)',
    ])
    expect(detectLanAddress()).toBe('192.168.123.50')
  })
})
