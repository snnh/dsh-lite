/**
 * The shape of what the platform reports: an interface whose address list is
 * absent contributes no candidate, and the interfaces that do report addresses
 * decide the answer alone.
 */

import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { detectLanAddress, listLanCandidates } from '../src/index.ts'

/** One IPv4 address as `node:os` reports it. */
const ipv4 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: 'bc:24:11:aa:b6:9e',
  internal: false,
  cidr: `${address}/24`,
})

// `node:os` is the seam: the fixture below is what the platform answers, and a
// case sets the dict it wants before reading the row's answer.
const state = vi.hoisted(() => ({ dict: {} as NodeJS.Dict<NetworkInterfaceInfo[]> }))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => state.dict,
}))

describe('interfaces the platform reports without addresses', () => {
  it('leaves them out and keeps the interfaces that carry a network', () => {
    state.dict = { lo: undefined, eth0: [ipv4('192.168.1.5')], br: undefined }
    expect(listLanCandidates().map(candidate => candidate.address)).toEqual(['192.168.1.5'])
    expect(detectLanAddress()).toBe('192.168.1.5')
  })

  it('answers nothing when no interface carries an address at all', () => {
    state.dict = { lo: undefined, eth0: undefined }
    expect(listLanCandidates()).toEqual([])
    expect(detectLanAddress()).toBeUndefined()
  })
})
