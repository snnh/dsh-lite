/**
 * Pinned behavior: a container that publishes its port to the host does not
 * recognize the host address peers reach it by.
 *
 * `docker run -p 3080:3080` serves the harness on a host address the container
 * cannot see. Inside the container the only non-internal interface is `eth0`
 * (`172.17.0.2`), while the operator's phone opens `http://192.168.1.5:3080`
 * and therefore sends `Host: 192.168.1.5:3080`. `--host 0.0.0.0` samples what
 * the container holds, so the published authority is absent from
 * `trustedHosts`: the /api browser-trust fence refuses every remote request
 * (403), and the printed LAN link carries the same unroutable address. The
 * escape hatch is declaring the address the operator published
 * (`--trusted-host 192.168.1.5`), which the fence then admits.
 *
 * This is the behavior as it stands, recorded rather than endorsed: a
 * container cannot derive an address it was never told, and `resolveLanTrust`
 * samples once per bind instead of re-reading the host's interfaces at request
 * time, so a changed host address never follows along on its own.
 *
 * The two halves are asserted together on purpose. `resolveLanTrust` (the
 * exposure row, `@deepseek-ai/dsh-host-lan-access`) derives the fence's `trustedHosts`, and `isTrustedApiRequest`
 * (client-connection, which owns the /api route) consumes them; each half is
 * covered by its own suite already, and only the seam between them is the
 * reported defect.
 */

import { describe, expect, it, vi } from 'vitest'
import { isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection/src/api-request-trust.ts'
import { resolveLanTrust } from '@deepseek-ai/dsh-host-lan-access'

/** `node:os` as the container sees it: loopback plus this container's own bridge address. */
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '172.17.0.2' }],
  }),
}))

/** The container's own address — the only non-internal IPv4 its `networkInterfaces()` reports. */
const CONTAINER_ADDRESS = '172.17.0.2'

/** The host's LAN address: what `-p 3080:3080` publishes, and what a peer dials. */
const HOST_LAN_ADDRESS = '192.168.1.5'

/** The request facts a browser on that LAN sends to the published port. */
const publishedRequest = { headers: { host: `${HOST_LAN_ADDRESS}:3080` } }

describe('container port publishing vs the /api Host fence', () => {
  it('samples only the container interface, so fence and printed LAN link both name the container address', () => {
    const runtime = resolveLanTrust('0.0.0.0', [])
    // The fence keeps what the bind publishes; inside the container that is 172.17.0.2 alone.
    expect(runtime.trustedHosts).toEqual([CONTAINER_ADDRESS])
    // The URL line prints that same address, which no peer's browser can route to.
    expect(runtime.lanAddresses).toEqual([CONTAINER_ADDRESS])
  })

  it('refuses the published host address — the root cause of the remote 403', () => {
    const { trustedHosts } = resolveLanTrust('0.0.0.0', [])
    // `192.168.1.5:3080` is neither a loopback name nor a sampled literal, so the
    // fence refuses it. Remote /api is 403 until the address is declared.
    expect(isTrustedApiRequest(publishedRequest, trustedHosts)).toBe(false)
  })

  it('admits the published host address once it is declared, on any port', () => {
    const { trustedHosts } = resolveLanTrust('0.0.0.0', [HOST_LAN_ADDRESS])
    expect(trustedHosts).toEqual([CONTAINER_ADDRESS, HOST_LAN_ADDRESS])
    // `--trusted-host 192.168.1.5` joins as a port-less literal, which the fence
    // matches on any port — the port is OS-assigned and unknowable at resolve time.
    expect(isTrustedApiRequest(publishedRequest, trustedHosts)).toBe(true)
  })

  it('derives nothing extra for a specific bind: a changed host address does not follow along', () => {
    const runtime = resolveLanTrust(HOST_LAN_ADDRESS, [])
    // No sampling happens for a stated address, so this snapshot cannot observe
    // the host moving networks, and nothing is printed beside the URL that
    // already carries it.
    expect(runtime.trustedHosts).toEqual([HOST_LAN_ADDRESS])
    expect(runtime.lanAddresses).toEqual([])
  })
})
