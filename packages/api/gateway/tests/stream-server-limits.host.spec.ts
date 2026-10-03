import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  RemoteStreamMuxServer,
  type RemoteStreamDownlinkLimits,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from '../src/stream-server.ts'

interface LimitedMux {
  readonly http: Server
  readonly mux: RemoteStreamMuxServer
  readonly url: string
}

const running = new Set<LimitedMux>()

afterEach(async () => {
  await Promise.all([...running].map(async (entry) => {
    running.delete(entry)
    await entry.mux.close().catch(() => undefined)
    await closeHttp(entry.http)
  }))
})

describe('Remote stream mux downlink limits', () => {
  it('fails one logical stream whose encoded frame exceeds maxFrameBytes and keeps serving the socket', async () => {
    const oversized = 'x'.repeat(4_096)
    const entry = await startLimitedMux(
      async (endpoint, _payload, _uplink) => valueSource(endpoint === 'fixture/large' ? oversized : 'small'),
      { maxFrameBytes: 512 },
    )
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('large', 'fixture/large'))
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'large',
        error: {
          code: 'gateway/downlink-frame-too-large',
          message: `api gateway: Remote stream item frame of ${String(frameBytes(oversized))} bytes exceeds the 512 byte cap`,
          details: { streamId: 'large' },
        },
      }])
    })
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.send(openFrame('small'))
    await vi.waitFor(() => {
      expect(frames.slice(1)).toEqual([
        { type: 'item', streamId: 'small', value: 'small' },
        { type: 'end', streamId: 'small' },
      ])
    })
    client.close()
    await once(client, 'close')
  })

  it('closes the carrier when one frame misses its write deadline', async () => {
    const entry = await startLimitedMux(async () => valueSource('stalled'), { sendTimeoutMs: 25 })
    const client = await connect(entry.url)
    const held = holdWrites(acceptedSocket(entry.mux))

    const closed = once(client, 'close')
    client.send(openFrame('stalled'))
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
    // The terminal error frame never reached the carrier: the connection refused
    // a second write instead of arming another deadline behind the stalled one.
    expect(held.count).toBe(1)
  })

  it('clears one frame deadline once the carrier reports it written', async () => {
    const entry = await startLimitedMux(async () => valueSource('frame'), { sendTimeoutMs: 30 })
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('first'))
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'first', value: 'frame' },
        { type: 'end', streamId: 'first' },
      ])
    })
    // Long past the deadline of both written frames: an uncleared timer would
    // have marked this connection stalled and ended the next stream instead.
    await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
    expect(client.readyState).toBe(WebSocket.OPEN)

    client.send(openFrame('second'))
    await vi.waitFor(() => {
      expect(frames.slice(2)).toEqual([
        { type: 'item', streamId: 'second', value: 'frame' },
        { type: 'end', streamId: 'second' },
      ])
    })
    client.close()
    await once(client, 'close')
  })
})

const mapFailure: RemoteStreamFailureMapper = (error) => {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: remote.details }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** Start one mux whose downlink limits the test injects. */
async function startLimitedMux(open: RemoteStreamOpener, limits: RemoteStreamDownlinkLimits): Promise<LimitedMux> {
  const root = new Context()
  const fiber = root.plugin(() => {})
  await fiber
  const peer: PeerScope = {
    id: 'limits-peer' as PeerId,
    ctx: fiber.ctx,
    dispose: async () => { await fiber.dispose() },
  }
  const mux = new RemoteStreamMuxServer(open, mapFailure, 5_000, 262_144, limits)
  const http = createServer()
  http.on('upgrade', (request, socket, head) => { mux.handleUpgrade(request, socket, head, peer) })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture HTTP server has no TCP port')
  const entry = { http, mux, url: `ws://127.0.0.1:${String(address.port)}` }
  running.add(entry)
  return entry
}

function valueSource(value: unknown): AsyncIterable<unknown> {
  return (async function *(): AsyncIterable<unknown> { yield value })()
}

/** Bytes one downlink item frame carrying `value` encodes to. */
function frameBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify({ type: 'item', streamId: 'large', value }), 'utf8')
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  return socket
}

function acceptedSocket(mux: RemoteStreamMuxServer): WebSocket {
  const exposed = mux as unknown as { server: { clients: Set<WebSocket> } }
  const socket = [...exposed.server.clients][0]
  if (socket === undefined) throw new Error('fixture mux has no accepted socket')
  return socket
}

/** Replace the carrier write with one that never reports a frame written, counting the frames handed to it. */
function holdWrites(serverSocket: WebSocket): { count: number } {
  const held = { count: 0 }
  const mutable = serverSocket as {
    send(data: unknown, callback?: (error?: Error) => void): void
  }
  mutable.send = () => { held.count += 1 }
  return held
}

function collectFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  client.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
  })
  return frames
}

function openFrame(streamId: string, endpoint = 'fixture/small'): string {
  return JSON.stringify({ type: 'open', streamId, endpoint, payload: {} })
}

async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}
