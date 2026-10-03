import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  parseRemoteStreamClientMessage,
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_FIRST_SEQ,
} from '../src/stream-protocol.ts'
import {
  RemoteStreamMuxServer,
  type RemoteStreamDownlinkLimits,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from '../src/stream-server.ts'

interface ResyncMux {
  readonly http: Server
  readonly mux: RemoteStreamMuxServer
  readonly url: string
}

const running = new Set<ResyncMux>()

afterEach(async () => {
  await Promise.all([...running].map(async (entry) => {
    running.delete(entry)
    await entry.mux.close().catch(() => undefined)
    await closeHttp(entry.http)
  }))
})

describe('Remote stream resume wire protocol', () => {
  it('parses item frames with and without a sequence number', () => {
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: { line: 'ls\n' }, seq: 7,
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: { line: 'ls\n' }, seq: 7 })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1', value: 'legacy',
    }))).toEqual({ type: 'item', streamId: 'stream-1', value: 'legacy' })
    expect(parseRemoteStreamServerMessage(JSON.stringify({
      type: 'item', streamId: 'stream-1',
    }))).toEqual({ type: 'item', streamId: 'stream-1' })
  })

  it.each([-1, 1.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an item frame whose sequence number is not a position: %j',
    (seq) => {
      expect(() => parseRemoteStreamServerMessage(JSON.stringify({
        type: 'item', streamId: 'stream-1', value: 'item', seq,
      }))).toThrow('api gateway: invalid Remote stream server message')
    },
  )

  it('parses every resume-aware open variant and leaves the legacy frame intact', () => {
    const open = { type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: { cursor: 1 } }
    expect(parseRemoteStreamClientMessage(JSON.stringify(open))).toEqual(open)
    expect(parseRemoteStreamClientMessage(JSON.stringify({ ...open, resumable: true })))
      .toEqual({ ...open, resumable: true })
    expect(parseRemoteStreamClientMessage(JSON.stringify({ ...open, resumeFromSeq: 0 })))
      .toEqual({ ...open, resumeFromSeq: 0 })
    expect(parseRemoteStreamClientMessage(JSON.stringify({ ...open, resumable: false, resumeFromSeq: 12 })))
      .toEqual({ ...open, resumable: false, resumeFromSeq: 12 })
  })

  it.each([
    { resumable: 'yes' },
    { resumable: 1 },
    { resumeFromSeq: -1 },
    { resumeFromSeq: 0.5 },
    { resumeFromSeq: '0' },
    { resumeFromSeq: null },
  ])('rejects an open frame with an unusable resume field: %j', (extra) => {
    expect(() => parseRemoteStreamClientMessage(JSON.stringify({
      type: 'open', streamId: 'stream-1', endpoint: 'feed/follow', payload: {}, ...extra,
    }))).toThrow('api gateway: invalid Remote stream client message')
  })
})

describe('Remote stream mux resync', () => {
  it('numbers only the items of a stream the Client asked to be resumable', async () => {
    const entry = await startMux(async () => valueSource('one', 'two', 'three'))
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'resumable', value: 'one', seq: REMOTE_STREAM_FIRST_SEQ },
        { type: 'item', streamId: 'resumable', value: 'two', seq: 1 },
        { type: 'item', streamId: 'resumable', value: 'three', seq: 2 },
        { type: 'end', streamId: 'resumable' },
      ])
    })

    // A stream that never asked for resumability keeps the pre-resume frames
    // byte for byte, which is what an older Client parses.
    client.send(openFrame('plain'))
    await vi.waitFor(() => {
      expect(frames.slice(4)).toEqual([
        { type: 'item', streamId: 'plain', value: 'one' },
        { type: 'item', streamId: 'plain', value: 'two' },
        { type: 'item', streamId: 'plain', value: 'three' },
        { type: 'end', streamId: 'plain' },
      ])
    })
    client.close()
    await once(client, 'close')
  })

  it('resends the retained tail to a reconnecting socket and then ends the resumed stream', async () => {
    const entry = await startMux(async () => valueSource('one', 'two', 'three'))
    const first = await connect(entry.url)
    const firstFrames = collectFrames(first)
    const firstCarrier = acceptedSocket(entry.mux)

    first.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => { expect(firstFrames).toHaveLength(4) })
    // The Client applied everything up to seq 1 before its carrier died.
    const carrierClosed = once(firstCarrier, 'close')
    first.close()
    await carrierClosed

    const second = await connect(entry.url)
    const secondFrames = collectFrames(second)
    second.send(openFrame('resumable', { resumeFromSeq: 1 }))
    await vi.waitFor(() => {
      expect(secondFrames).toEqual([
        { type: 'item', streamId: 'resumable', value: 'two', seq: 1 },
        { type: 'item', streamId: 'resumable', value: 'three', seq: 2 },
        { type: 'end', streamId: 'resumable' },
      ])
    })
    // The replay is not a fresh generation: a resume names no endpoint work, so
    // the socket keeps serving other streams.
    expect(second.readyState).toBe(WebSocket.OPEN)

    // A Client that is already current is told the stream is over, with no item.
    second.send(openFrame('resumable', { resumeFromSeq: 3 }))
    await vi.waitFor(() => {
      expect(secondFrames.slice(3)).toEqual([{ type: 'end', streamId: 'resumable' }])
    })
    second.close()
    await once(second, 'close')
  })

  it('refuses a resume whose items left the replay window and lets the Client start over', async () => {
    const entry = await startMux(async () => valueSource('one', 'two', 'three'), { replayWindowItems: 2 })
    const first = await connect(entry.url)
    const firstCarrier = acceptedSocket(entry.mux)
    const firstFrames = collectFrames(first)

    first.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => { expect(firstFrames).toHaveLength(4) })
    const carrierClosed = once(firstCarrier, 'close')
    first.close()
    await carrierClosed

    const second = await connect(entry.url)
    const frames = collectFrames(second)
    second.send(openFrame('resumable', { resumeFromSeq: 0 }))
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'resumable',
        error: {
          code: 'gateway/downlink-resync-unavailable',
          message: 'api gateway: Remote stream "resumable" cannot resume from seq 0: those items are no longer retained',
          details: { streamId: 'resumable', resumeFromSeq: 0 },
        },
      }])
    })
    expect(second.readyState).toBe(WebSocket.OPEN)

    // The refusal is not a broken connection: the same stream id opens fresh and
    // numbers its items from the start again.
    second.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => {
      expect(frames.slice(1)).toEqual([
        { type: 'item', streamId: 'resumable', value: 'one', seq: 0 },
        { type: 'item', streamId: 'resumable', value: 'two', seq: 1 },
        { type: 'item', streamId: 'resumable', value: 'three', seq: 2 },
        { type: 'end', streamId: 'resumable' },
      ])
    })
    second.close()
    await once(second, 'close')
  })

  it('empties a window whose item cannot fit its byte cap', async () => {
    const entry = await startMux(async () => valueSource('one', 'two'), { replayWindowBytes: 8 })
    const first = await connect(entry.url)
    const firstCarrier = acceptedSocket(entry.mux)
    const firstFrames = collectFrames(first)

    first.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => { expect(firstFrames).toHaveLength(3) })
    const carrierClosed = once(firstCarrier, 'close')
    first.close()
    await carrierClosed

    const second = await connect(entry.url)
    const frames = collectFrames(second)
    second.send(openFrame('resumable', { resumeFromSeq: 0 }))
    await vi.waitFor(() => {
      expect(frames).toEqual([resyncRefusal('resumable', 0)])
    })
    second.close()
    await once(second, 'close')
  })

  it('refuses resumes it never retained and resumes ahead of what the stream produced', async () => {
    const entry = await startMux(async () => valueSource('only'))
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    // No stream by that id was ever opened on this mux.
    client.send(openFrame('unknown', { resumeFromSeq: 0 }))
    await vi.waitFor(() => {
      expect(frames).toEqual([resyncRefusal('unknown', 0)])
    })

    client.send(openFrame('ahead', { resumable: true }))
    await vi.waitFor(() => {
      expect(frames.slice(1)).toEqual([
        { type: 'item', streamId: 'ahead', value: 'only', seq: 0 },
        { type: 'end', streamId: 'ahead' },
      ])
    })

    // One item exists, so seq 2 is beyond anything the Host handed to a Client.
    client.send(openFrame('ahead', { resumeFromSeq: 2 }))
    await vi.waitFor(() => {
      expect(frames.slice(3)).toEqual([resyncRefusal('ahead', 2)])
    })
    client.close()
    await once(client, 'close')
  })

  it('stamps nothing and serves no resume when retention is disabled', async () => {
    const entry = await startMux(async () => valueSource('one'), { retainedStreams: 0 })
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'resumable', value: 'one' },
        { type: 'end', streamId: 'resumable' },
      ])
    })

    client.send(openFrame('resumable', { resumeFromSeq: 0 }))
    await vi.waitFor(() => {
      expect(frames.slice(2)).toEqual([resyncRefusal('resumable', 0)])
    })
    client.close()
    await once(client, 'close')
  })

  it('fails the resumed stream when the replay cannot be written', async () => {
    const entry = await startMux(async () => valueSource('one', 'two'))
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('resumable', { resumable: true }))
    await vi.waitFor(() => { expect(frames).toHaveLength(3) })
    failWrites(acceptedSocket(entry.mux))

    // The replay's first frame cannot reach the carrier, and neither can the
    // terminal failure behind it, so the physical generation ends.
    const closed = once(client, 'close')
    client.send(openFrame('resumable', { resumeFromSeq: 0 }))
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('evicts the oldest window once the mux holds its retained-stream limit', async () => {
    const entry = await startMux(async () => valueSource('item'), { retainedStreams: 1 })
    const client = await connect(entry.url)
    const frames = collectFrames(client)

    client.send(openFrame('first', { resumable: true }))
    await vi.waitFor(() => { expect(frames).toHaveLength(2) })
    client.send(openFrame('second', { resumable: true }))
    await vi.waitFor(() => { expect(frames).toHaveLength(4) })

    // `first` is complete but its window left the table, so only `second` resumes.
    client.send(openFrame('first', { resumeFromSeq: 0 }))
    client.send(openFrame('second', { resumeFromSeq: 0 }))
    await vi.waitFor(() => {
      expect(frames.slice(4)).toEqual([
        resyncRefusal('first', 0),
        { type: 'item', streamId: 'second', value: 'item', seq: 0 },
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
async function startMux(
  open: RemoteStreamOpener,
  limits: RemoteStreamDownlinkLimits = {},
): Promise<ResyncMux> {
  const root = new Context()
  const fiber = root.plugin(() => {})
  await fiber
  const peer: PeerScope = {
    id: 'resync-peer' as PeerId,
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

function valueSource(...values: readonly unknown[]): AsyncIterable<unknown> {
  return (async function *(): AsyncIterable<unknown> { yield *values })()
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

function collectFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  client.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
  })
  return frames
}

function openFrame(streamId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'open', streamId, endpoint: 'fixture/follow', payload: {}, ...extra })
}

/** Make every later carrier write report a failure. */
function failWrites(serverSocket: WebSocket): void {
  const mutable = serverSocket as {
    send(data: unknown, callback: (error?: Error) => void): void
  }
  mutable.send = (_data, callback): void => {
    callback(new Error('fixture ws write failure'))
  }
}

/** The terminal frame one unservable resume answers with. */
function resyncRefusal(streamId: string, resumeFromSeq: number): Record<string, unknown> {
  return {
    type: 'error',
    streamId,
    error: {
      code: 'gateway/downlink-resync-unavailable',
      message: `api gateway: Remote stream ${JSON.stringify(streamId)} cannot resume from seq ${String(resumeFromSeq)}: those items are no longer retained`,
      details: { streamId, resumeFromSeq },
    },
  }
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
