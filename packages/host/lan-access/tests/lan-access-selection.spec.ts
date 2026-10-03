/**
 * Address selection: which candidate wins on a machine that carries several.
 *
 * The machine's own interfaces are the fixture here, not a stub — a container
 * bridge reported before the physical interface is the case this ranking
 * exists for, and that ordering is a property of the host, not of the code.
 */

import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  detectLanAddress,
  isVirtualInterface,
  listLanCandidates,
  rankLanCandidates,
  type LanCandidate,
} from '../src/index.ts'

const candidate = (address: string, iface: string): LanCandidate => ({
  address,
  iface,
  virtual: isVirtualInterface(iface),
})

describe('isVirtualInterface', () => {
  it('recognizes the names container bridges and tunnels carry', () => {
    for (const iface of ['docker0', 'br-1a426df6dda3', 'veth9963a84', 'virbr0', 'vmnet8', 'vboxnet0', 'tun0', 'utun3', 'tailscale0']) {
      expect(isVirtualInterface(iface)).toBe(true)
    }
  })

  it('leaves the names physical interfaces carry alone', () => {
    for (const iface of ['lo', 'eth0', 'ens18', 'en0', 'wlan0', 'wlp3s0', 'enp0s31f6']) {
      expect(isVirtualInterface(iface)).toBe(false)
    }
  })
})

describe('rankLanCandidates', () => {
  it('moves an earlier bridge behind a later physical interface', () => {
    const ranked = rankLanCandidates([
      candidate('172.20.0.1', 'br-1a426df6dda3'),
      candidate('192.168.1.5', 'ens18'),
    ])
    expect(ranked.map(entry => entry.address)).toEqual(['192.168.1.5', '172.20.0.1'])
  })

  it('keeps interface order within a rank', () => {
    const ranked = rankLanCandidates([
      candidate('192.168.1.5', 'ens18'),
      candidate('10.0.0.7', 'wlan0'),
      candidate('172.18.0.1', 'br-a'),
      candidate('172.20.0.1', 'br-b'),
    ])
    expect(ranked.map(entry => entry.address)).toEqual(['192.168.1.5', '10.0.0.7', '172.18.0.1', '172.20.0.1'])
  })

  it('still reports a bridge when it is the only address', () => {
    const only = [candidate('100.64.0.1', 'tailscale0')]
    expect(rankLanCandidates(only).map(entry => entry.address)).toEqual(['100.64.0.1'])
  })

  it('leaves the input untouched', () => {
    const input = [candidate('172.20.0.1', 'br-x'), candidate('192.168.1.5', 'ens18')]
    rankLanCandidates(input)
    expect(input.map(entry => entry.address)).toEqual(['172.20.0.1', '192.168.1.5'])
  })

  it('ranks nothing as nothing', () => {
    expect(rankLanCandidates([])).toEqual([])
  })
})

describe('listLanCandidates', () => {
  it('reports this machine\'s addresses without loopback', () => {
    const candidates = listLanCandidates()
    const reported = new Set(candidates.map(entry => entry.address))
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4') continue
        expect(reported.has(entry.address)).toBe(!entry.internal)
      }
    }
  })

  it('agrees with the address the row binds', () => {
    const best = rankLanCandidates(listLanCandidates())[0]
    expect(detectLanAddress()).toBe(best?.address)
  })
})
