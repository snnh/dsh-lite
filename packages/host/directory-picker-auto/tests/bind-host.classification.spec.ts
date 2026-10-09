/**
 * The chooser's bind-host classification, read against the vocabulary the
 * lan-access row resolves binds with ({@link isLoopbackHost}): the literals
 * that name this machine alone keep the native chooser on an attended host,
 * while every exposing bind — the `0.0.0.0` wildcard the row persists on
 * first run, and a concrete LAN address — resolves to `browse` for *every*
 * client, the local operator included, because the boot-time sample cannot
 * tell them apart. Pinning both sides of that table here is what keeps the
 * chooser and the bind decision from drifting apart.
 */

import { describe, expect, it } from 'vitest'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-lan-access'
import { resolveDirectoryPickerBackend } from '../src/resolve.ts'
import type { DirectoryPickerHostFacts } from '../src/resolve.ts'

/** An attended Darwin host: a display platform, so no linux fact decides the case. */
const attended: DirectoryPickerHostFacts = {
  bindHost: '127.0.0.1',
  allowsRemoteAuthorities: false,
  platform: 'darwin',
  ssh: false,
  env: {},
  linuxChooser: false,
}

describe('resolveDirectoryPickerBackend bind hosts', () => {
  it('keeps native for every literal that names this machine alone', () => {
    for (const bindHost of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect([bindHost, resolveDirectoryPickerBackend({ ...attended, bindHost })]).toEqual([bindHost, 'native'])
    }
  })

  it('resolves browse for the all-interfaces wildcard, the machine\'s own browser included', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(resolveDirectoryPickerBackend({ ...attended, bindHost: '0.0.0.0' })).toBe('browse')
  })

  it('resolves browse for a concrete LAN address that admits remote browsers', () => {
    for (const bindHost of ['192.168.1.24', '10.0.4.7', '172.16.31.9']) {
      expect([bindHost, resolveDirectoryPickerBackend({ ...attended, bindHost })]).toEqual([bindHost, 'browse'])
    }
  })

  it('resolves native for the whole loopback network the bind vocabulary treats as local', () => {
    // Loopback is decided by the address a value names, so `127.0.0.2` — which
    // reaches only this machine, exactly as `127.0.0.1` does — keeps the native
    // chooser on an attended host.
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(resolveDirectoryPickerBackend({ ...attended, bindHost: '127.0.0.2' })).toBe('native')
  })

  it('classifies every spelling exactly as the row that resolves the bind does', () => {
    for (const bindHost of [
      '127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '127.0.0.2', '192.168.1.24', 'fd00::1', 'localhost.',
    ]) {
      expect([bindHost, resolveDirectoryPickerBackend({ ...attended, bindHost })])
        .toEqual([bindHost, isLoopbackHost(bindHost) ? 'native' : 'browse'])
    }
  })
})
