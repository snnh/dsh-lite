/** Host WebSocket owner for multiplexed Typert Remote streams. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError, remoteErrorOf, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { REMOTE_STREAM_FRAME_TOO_LARGE, REMOTE_STREAM_RESYNC_UNAVAILABLE } from './remote-error-codes.ts'
import {
  parseRemoteStreamClientMessage,
  REMOTE_STREAM_FIRST_SEQ,
  type RemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/**
 * Open one validated Remote stream for a decoded wire request on behalf of one
 * Peer. `uplink` carries the Client's items; `control` cancels the logical
 * stream, and aborting it with a Remote failure as the reason delivers that
 * failure to the Client.
 */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  peer: PeerScope,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

/** The opener one socket uses: its Peer is fixed at upgrade time. */
type BoundStreamOpener = (
  endpoint: string,
  payload: unknown,
  uplink: AsyncIterable<unknown>,
  control: AbortController,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

const MAX_MISSED_HEARTBEATS = 2

/**
 * Default byte cap on one encoded downlink frame.
 *
 * The mux never splits an item, so the cap must clear the largest item a Host
 * method legitimately produces: the workspace file service returns a whole file
 * as one byte array up to its own 32 MiB cap, and the Client codec expands those
 * bytes before framing. 64 MiB clears that with room for JSON escaping while
 * still bounding what one item makes the Host encode, buffer, and hold for a
 * peer that reads slowly.
 */
const DEFAULT_DOWNLINK_MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Default deadline for one frame's carrier write callback.
 *
 * ws reports a frame written once the socket accepted it, so the callback waits
 * on drain: a peer that stopped reading leaves it pending while the frame stays
 * queued. One minute is generous for the bytes one frame may carry — the largest
 * admitted frame leaves the transport ~1 MiB/s — so the deadline fails a peer
 * that reads nothing, not one on a slow link.
 */
const DEFAULT_DOWNLINK_SEND_TIMEOUT_MS = 60_000

/**
 * Default item frames one logical stream's replay window retains.
 *
 * The window exists so a reconnecting Client can be resent the tail it missed,
 * not so the Host becomes a buffer for the whole stream: a resume that reaches
 * past it is refused, and the Client starts the stream over.
 */
const DEFAULT_REPLAY_WINDOW_ITEMS = 64

/**
 * Default retained frame bytes of one logical stream's replay window.
 *
 * The count cap bounds the window in entries, this cap bounds it in memory: a
 * slow stream of file-sized items would otherwise pin hundreds of MiB per
 * stream. 256 KiB spans a long run of ordinary items and a handful of large
 * ones, and the oldest frames leave the window once it is exceeded.
 */
const DEFAULT_REPLAY_WINDOW_BYTES = 256 * 1024

/**
 * Default replay windows the mux retains, across every logical stream it has
 * served. Resumable streams are rare and their windows are only useful while a
 * Client is reconnecting, so this cap — not time — bounds how much replay
 * memory one Host process may hold: `retainedStreams * replayWindowBytes`.
 */
const DEFAULT_RETAINED_STREAMS = 32

/**
 * Downlink limits one mux enforces; each option carries a default when absent.
 * The frame caps and the write deadline are per accepted socket; the replay
 * retention is mux-wide, because a resume request arrives on a later socket than
 * the one whose frames it asks for.
 */
export interface RemoteStreamDownlinkLimits {
  /**
   * Byte cap on one encoded downlink frame. A larger frame fails its logical
   * stream with `gateway/downlink-frame-too-large` and leaves the socket open,
   * because the oversized item is no defect of the carrier.
   * @default 67108864
   */
  readonly maxFrameBytes?: number
  /**
   * Deadline for one frame's `socket.send` callback. A callback that arrives
   * later fails the logical stream and closes the socket: the frame is still
   * queued behind a peer that stopped reading, so every later frame would wait
   * behind it.
   * @default 60000
   */
  readonly sendTimeoutMs?: number
  /**
   * Item frames one logical stream's replay window retains for a later resume
   * request. The window drops its oldest frames beyond this count, so what a
   * resume can be served with is bounded, never the whole stream.
   * @default 64
   */
  readonly replayWindowItems?: number
  /**
   * Retained frame bytes of one logical stream's replay window. Frames that no
   * longer fit leave the window oldest-first, so one oversized item empties the
   * window it joins and a resume from before it is refused instead of served
   * with a gap.
   * @default 262144
   */
  readonly replayWindowBytes?: number
  /**
   * Replay windows the mux retains across the physical sockets it serves.
   * Resumes arrive on the socket after the one that carried the items, so this
   * table — not the connection — owns the windows, and its cap is what bounds
   * replay memory: `retainedStreams * replayWindowBytes`. `0` retains nothing,
   * which makes every stream non-resumable.
   * @default 32
   */
  readonly retainedStreams?: number
}

/** One retained item frame of a logical stream's replay window. */
interface RetainedItemFrame {
  readonly seq: number
  readonly text: string
  readonly bytes: number
}

/**
 * Bounded replay window of one resumable logical stream: the item frames the
 * mux most recently handed to the carrier, keyed by their sequence number.
 *
 * The window owns the stream's sequence counter, so the number a frame carries
 * is decided where the frame is retained and the two can never disagree. Both
 * caps are enforced oldest-first after every retained frame, so the memory one
 * stream holds for replay stays within `maxBytes` plus the frame that just
 * arrived — a single frame above `maxBytes` therefore empties the window it
 * would join.
 */
class DownlinkReplayWindow {
  private readonly frames: RetainedItemFrame[] = []
  private bytes = 0
  private next = REMOTE_STREAM_FIRST_SEQ

  /**
   * @param maxItems - retained frames beyond which the oldest leave the window.
   * @param maxBytes - retained frame bytes beyond which the oldest leave the window.
   */
  constructor(private readonly maxItems: number, private readonly maxBytes: number) {}

  /** Sequence number the stream's next item frame carries. */
  get nextSeq(): number {
    return this.next
  }

  /**
   * Retain one encoded item frame under this window's next sequence number and
   * drop whatever no longer fits the two caps.
   * @param text - encoded item frame the carrier was handed.
   */
  retain(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    this.frames.push({ seq: this.next, text, bytes })
    this.bytes += bytes
    this.next += 1
    this.trim()
  }

  /** Drop the oldest retained frames until both caps hold again. */
  private trim(): void {
    let keep = this.frames.length
    let bytes = this.bytes
    for (const frame of this.frames) {
      if (keep <= this.maxItems && bytes <= this.maxBytes) break
      keep -= 1
      bytes -= frame.bytes
    }
    const dropped = this.frames.length - keep
    if (dropped === 0) return
    this.frames.splice(0, dropped)
    this.bytes = bytes
  }

  /**
   * Encoded item frames from one sequence number on.
   * @param fromSeq - first sequence number the Client still wants.
   * @returns the retained frames in stream order, or `undefined` when the
   * request cannot be served without a gap: the frames were never retained,
   * have been evicted, or the Client claims more than the stream produced.
   */
  suffixFrom(fromSeq: number): readonly string[] | undefined {
    if (fromSeq === this.next) return []
    if (fromSeq > this.next) return undefined
    const oldest = this.frames[0]
    if (oldest === undefined || fromSeq < oldest.seq) return undefined
    return this.frames.filter(frame => frame.seq >= fromSeq).map(frame => frame.text)
  }
}

/**
 * Replay windows of the resumable logical streams this mux serves, keyed by
 * stream id. A window outlives the physical socket that carried its items, which
 * is the whole point: the resume request necessarily arrives on a later socket.
 * The table retains at most `capacity` windows in open order, so the replay
 * memory one Host process may hold is bounded by the cap and the per-window caps
 * rather than by the traffic it serves.
 */
class DownlinkReplayTable {
  private readonly windows = new Map<string, DownlinkReplayWindow>()

  /**
   * @param capacity - windows retained; `0` disables retention entirely.
   * @param items - item frames each window retains.
   * @param bytes - retained frame bytes each window holds.
   */
  constructor(
    private readonly capacity: number,
    private readonly items: number,
    private readonly bytes: number,
  ) {}

  /**
   * Start the replay window of one logical stream, replacing any window retained
   * under the same id: a fresh open is a new generation of that stream, so an
   * older generation's frames must never be replayed into it.
   * @param streamId - logical stream being opened.
   * @param retain - whether the Client asked for a resumable stream.
   * @returns the window to fill, or `undefined` when nothing is retained.
   */
  begin(streamId: string, retain: boolean): DownlinkReplayWindow | undefined {
    this.windows.delete(streamId)
    if (!retain || this.capacity === 0) return undefined
    const window = new DownlinkReplayWindow(this.items, this.bytes)
    this.windows.set(streamId, window)
    for (const stale of this.windows.keys()) {
      if (this.windows.size <= this.capacity) break
      this.windows.delete(stale)
    }
    return window
  }

  /**
   * Retained suffix one resume request asks for.
   * @param streamId - logical stream the Client names.
   * @param fromSeq - first sequence number the Client still wants.
   * @returns the frames to resend, or `undefined` when the request cannot be served.
   */
  resume(streamId: string, fromSeq: number): readonly string[] | undefined {
    return this.windows.get(streamId)?.suffixFrom(fromSeq)
  }
}

/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly connections = new Set<Promise<void>>()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  private readonly replay: DownlinkReplayTable
  private heartbeatTimer: NodeJS.Timeout | undefined

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
   * @param streamInboxBytes - buffered uplink frame bytes one logical stream may hold before it fails.
   * @param downlinkLimits - byte cap and write deadline per downlink frame, plus the bounded replay retention resumable streams use.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    private readonly streamInboxBytes: number,
    private readonly downlinkLimits: RemoteStreamDownlinkLimits = {},
  ) {
    this.replay = new DownlinkReplayTable(
      downlinkLimits.retainedStreams ?? DEFAULT_RETAINED_STREAMS,
      downlinkLimits.replayWindowItems ?? DEFAULT_REPLAY_WINDOW_ITEMS,
      downlinkLimits.replayWindowBytes ?? DEFAULT_REPLAY_WINDOW_BYTES,
    )
  }

  /**
   * Upgrade one admitted request and begin serving its logical streams. Every
   * stream the socket opens speaks for the Peer admitted at upgrade, and the
   * socket closes when that Peer's scope is disposed.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   * @param peer - Peer the upgrade was admitted as.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerScope): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const release = bindPeer(websocket, peer)
      if (release === undefined) return
      this.missedHeartbeats.set(websocket, 0)
      websocket.on('pong', () => { this.missedHeartbeats.set(websocket, 0) })
      this.startHeartbeat()
      const bound: BoundStreamOpener = (endpoint, payload, uplink, control) =>
        this.open(endpoint, payload, uplink, peer, control)
      const connection = new RemoteStreamMuxConnection(
        websocket,
        bound,
        this.failure,
        this.streamInboxBytes,
        this.downlinkLimits,
        this.replay,
      )
      const done = connection.run()
      this.connections.add(done)
      void done.then(() => {
        this.connections.delete(done)
        void release()
      })
    })
  }

  /** Terminate all sockets and wait until every iterator has returned. */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    await closed.promise
    await Promise.all(this.connections)
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              socket.terminate()
            }
          })
          continue
        }
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  readonly inbox: UplinkInbox
  /**
   * Replay window of a stream the Client asked to be resumable, or `undefined`
   * for one whose items carry no sequence number. The window owns the stream's
   * sequence counter.
   */
  readonly window: DownlinkReplayWindow | undefined
  /** Cancel the logical stream and end any Host read still waiting on its uplink. */
  readonly stop: (reason: Error) => void
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  /**
   * Resume replies still being written. They own no logical stream — a resumed
   * stream only resends retained frames and is gone — so the connection tracks
   * them apart from `streams` and the socket close waits for them.
   */
  private readonly replays = new Set<Promise<void>>()
  private writes = Promise.resolve()
  private readonly maxFrameBytes: number
  private readonly sendTimeoutMs: number
  /**
   * Set once one frame's write callback missed `sendTimeoutMs`. A peer that
   * stopped reading leaves that frame queued, so every later frame on this
   * socket waits behind it: the connection refuses to write another one.
   */
  private stalled = false

  constructor(
    private readonly socket: WebSocket,
    private readonly open: BoundStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly streamInboxBytes: number,
    downlinkLimits: RemoteStreamDownlinkLimits,
    private readonly replay: DownlinkReplayTable,
  ) {
    this.maxFrameBytes = downlinkLimits.maxFrameBytes ?? DEFAULT_DOWNLINK_MAX_FRAME_BYTES
    this.sendTimeoutMs = downlinkLimits.sendTimeoutMs ?? DEFAULT_DOWNLINK_SEND_TIMEOUT_MS
  }

  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.stop(new Error('Remote stream socket closed'))
    await Promise.all([...active.map(stream => stream.done), ...this.replays])
  }

  /**
   * Dispatch one frame. `item`, `end`, and `cancel` for a stream this connection
   * no longer owns are dropped: a finished stream leaves the table while the
   * Client's in-flight frames are still arriving. A duplicate `open` is the one
   * protocol violation that closes the socket.
   */
  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    switch (message.type) {
      case 'open': {
        this.openStream(message)
        return
      }
      case 'item': {
        this.streams.get(message.streamId)?.inbox.push(message.value, Buffer.byteLength(text, 'utf8'))
        return
      }
      case 'end': {
        this.streams.get(message.streamId)?.inbox.end()
        return
      }
      case 'cancel': {
        this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled'))
        return
      }
      /* v8 ignore next 4 -- parseRemoteStreamClientMessage admits only the four frame types above. */
      default: {
        const unknown: never = message
        throw new Error(`api gateway: unknown Remote stream client message ${JSON.stringify(unknown)}`)
      }
    }
  }

  private openStream(message: Extract<RemoteStreamClientMessage, { readonly type: 'open' }>): void {
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    // A resume names a stream this connection never opened: the retained window
    // of the generation that carried the items answers it, so nothing here is
    // re-opened and `resumable` is irrelevant to the reply.
    if (message.resumeFromSeq !== undefined) {
      this.resumeStream(message.streamId, message.resumeFromSeq)
      return
    }
    const abort = new AbortController()
    // Created before the opener resolves so items the Client sends right
    // after `open` wait in the inbox instead of being lost.
    const inbox = new UplinkInbox(this.streamInboxBytes, message.endpoint, (error) => { abort.abort(error) })
    const active: ActiveStream = {
      abort,
      inbox,
      window: this.replay.begin(message.streamId, message.resumable === true),
      stop: (reason) => {
        abort.abort(reason)
        inbox.fail(reason)
      },
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    let outcome: { readonly failed: false } | { readonly failed: true; readonly error: unknown }
    try {
      const source = await this.open(endpoint, payload, active.inbox, active.abort)
      for await (const value of source) {
        await this.sendItem(streamId, value, active)
      }
      outcome = { failed: false }
    } catch (error) {
      outcome = { failed: true, error }
    }
    // The downlink has settled; later uplink frames cannot change the outcome.
    active.inbox.fail(new Error('Remote stream ended'))
    if (active.abort.signal.aborted) {
      // A Remote failure as the abort reason is the Gateway or this mux failing
      // the stream (a rejected or overflowing uplink item, or an item after
      // end); the Client is still waiting for that terminal frame. Any other
      // abort is a cancellation.
      const reason: unknown = active.abort.signal.reason
      if (remoteErrorOf(reason) !== undefined) await this.sendFailure(streamId, reason)
      return
    }
    if (outcome.failed) {
      await this.sendFailure(streamId, outcome.error)
      return
    }
    try {
      await this.send({ type: 'end', streamId })
    } catch (error) {
      await this.sendFailure(streamId, error)
    }
  }

  private async sendFailure(streamId: string, error: unknown): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      await this.send({ type: 'error', streamId, error: this.failure(error) })
    } catch {
      // A terminal frame that cannot be encoded or written leaves the
      // logical stream ambiguous, so fail the physical generation.
      this.socket.close(1011, 'Remote stream failure could not be delivered')
    }
  }

  /**
   * Answer one resume request and track its reply.
   *
   * A resumed stream is a replay, not a newer generation: the Host stops a
   * producer when the socket that carried it goes away rather than keeping file
   * handles, subscriptions, or a running turn alive for a Client that may never
   * return. So the reply resends the retained tail the Client missed and ends
   * the stream; the Client is then caught up on the stream it lost and opens a
   * fresh one for anything the Host produces from now on. A request the windows
   * cannot serve without a gap fails the stream with
   * `gateway/downlink-resync-unavailable`, which is the Client's instruction to
   * start over instead.
   * @param streamId - logical stream the Client names.
   * @param fromSeq - first sequence number the Client still wants.
   */
  private resumeStream(streamId: string, fromSeq: number): void {
    const retained = this.replay.resume(streamId, fromSeq)
    const done = retained === undefined
      ? this.sendFailure(streamId, new RemoteError(
        REMOTE_STREAM_RESYNC_UNAVAILABLE,
        `api gateway: Remote stream ${JSON.stringify(streamId)} cannot resume from seq ${String(fromSeq)}: those items are no longer retained`,
        { streamId, resumeFromSeq: fromSeq },
      ))
      : this.replayItems(streamId, retained)
    this.replays.add(done)
    const settle = (): void => { this.replays.delete(done) }
    void done.then(settle, settle)
  }

  /**
   * Resend one retained suffix in stream order and end the resumed stream. Frames
   * are already encoded and were admitted under the same cap, so they go to the
   * carrier as they are.
   * @param streamId - logical stream being resumed.
   * @param retained - encoded item frames, oldest first.
   */
  private async replayItems(streamId: string, retained: readonly string[]): Promise<void> {
    try {
      for (const text of retained) await this.enqueue(text, streamId)
      await this.send({ type: 'end', streamId })
    } catch (error) {
      await this.sendFailure(streamId, error)
    }
  }

  /**
   * Encode and write one item frame. A stream the Client asked to be resumable
   * stamps the frame with the stream's next sequence number and retains it for a
   * later resume; every other stream writes exactly the frame the pre-resume
   * protocol defined. The sequence number is consumed only once the frame is
   * accepted, so a stream never numbers a frame it never handed to the carrier,
   * and a resume can never skip it.
   * @param streamId - logical stream the item belongs to.
   * @param value - Host item.
   * @param active - stream the item belongs to, carrying its replay window.
   */
  private sendItem(streamId: string, value: unknown, active: ActiveStream): Promise<void> {
    const window = active.window
    if (window === undefined) return this.send({ type: 'item', streamId, value })
    const text = this.encode({ type: 'item', streamId, value, seq: window.nextSeq })
    window.retain(text)
    return this.enqueue(text, streamId)
  }

  /**
   * Encode and write one downlink frame behind the connection's serial write
   * chain — the backpressure that stops a slow peer from making the Host buffer
   * unbounded items. Two limits end a logical stream instead of writing a frame:
   * a frame above `maxFrameBytes`, which is that item's own defect, and a write
   * callback that misses `sendTimeoutMs`, which means the peer stopped reading.
   * @param message - frame to write.
   * @throws {Error} when the frame cannot be encoded; every caller already awaits
   * this inside its own failure handling, which receives the throw directly.
   */
  private send(message: RemoteStreamServerMessage): Promise<void> {
    return this.enqueue(this.encode(message), message.streamId)
  }

  /**
   * Encode one frame, refusing what cannot legally reach this peer: an item that
   * is not JSON serializable, or a frame above the connection's byte cap.
   * @param message - frame to encode.
   * @returns the encoded frame.
   */
  private encode(message: RemoteStreamServerMessage): string {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      throw new Error('api gateway: Remote stream item is not JSON serializable', { cause })
    }
    const frameBytes = Buffer.byteLength(text, 'utf8')
    if (frameBytes > this.maxFrameBytes) {
      throw new RemoteError(
        REMOTE_STREAM_FRAME_TOO_LARGE,
        `api gateway: Remote stream ${message.type} frame of ${String(frameBytes)} bytes exceeds the ${String(this.maxFrameBytes)} byte cap`,
        { streamId: message.streamId },
      )
    }
    return text
  }

  /**
   * Queue one encoded frame behind the connection's serial write chain.
   * @param text - encoded frame.
   * @param streamId - logical stream the frame belongs to.
   */
  private enqueue(text: string, streamId: string): Promise<void> {
    const delivery = this.writes.then(() => {
      // A frame whose write already missed its deadline left the peer's backlog
      // undrained, so this frame could only queue behind it: fail it now rather
      // than arm a second deadline that the same peer cannot clear either.
      if (this.stalled) throw new Error('api gateway: Remote stream socket is stalled by an unwritten frame')
      return this.write(text, streamId)
    })
    this.writes = delivery.catch(() => undefined)
    return delivery
  }

  /**
   * Hand one encoded frame to the carrier and settle when ws reports it written.
   * The callback waits on the peer draining its socket, so a peer that stopped
   * reading leaves it pending while the frame stays queued: the deadline marks
   * the connection stalled and fails this frame, and `sendFailure` then closes a
   * socket it cannot deliver a terminal frame over.
   * @param text - encoded frame.
   * @param streamId - logical stream the frame belongs to.
   */
  private write(text: string, streamId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      const timer = setTimeout(() => {
        this.stalled = true
        reject(new Error(`api gateway: Remote stream ${streamId} frame write exceeded ${String(this.sendTimeoutMs)}ms`))
      }, this.sendTimeoutMs)
      // ws throws synchronously only for a socket it no longer has open, which
      // the check above already excluded, so every settled frame clears the
      // deadline here: no armed timer is left to mark a healthy socket stalled.
      this.socket.send(text, (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

interface UplinkEntry {
  readonly value: unknown
  readonly bytes: number
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * Bounded single-consumer uplink queue of one logical stream, the source the
 * Host method reads through `invocation.uplink()`. Buffered frame bytes are
 * capped: overflow, and an item after the Client's `end`, fail the queue and
 * report a Remote failure that the connection uses to fail the logical stream.
 */
class UplinkInbox implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue = new Deque<UplinkEntry>()
  private bytes = 0
  private ended = false
  private closed = false
  private taken = false
  private failure: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    private readonly maxBytes: number,
    private readonly endpoint: string,
    private readonly onViolation: (error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>) => void,
  ) {}

  push(value: unknown, frameBytes: number): void {
    if (this.failure !== undefined || this.closed) return
    if (this.ended) {
      this.violate(new RemoteError(
        'gateway/protocol',
        'api gateway: Remote stream uplink item after end',
        { endpoint: this.endpoint },
      ))
      return
    }
    if (this.bytes + frameBytes > this.maxBytes) {
      this.violate(new RemoteError(
        'gateway/uplink-overflow',
        `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`,
        { endpoint: this.endpoint },
      ))
      return
    }
    this.queue.pushBack({ value, bytes: frameBytes })
    this.bytes += frameBytes
    this.signal()
  }

  /** Client half-close; idempotent. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.signal()
  }

  /** End the consumer's next read with `error`; idempotent, drops buffered items. */
  fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.queue.clear()
    this.bytes = 0
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error('api gateway: Remote stream uplink inbox already has a consumer')
    this.taken = true
    return this
  }

  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      const entry = this.queue.popFront()
      if (entry !== undefined) {
        this.bytes -= entry.bytes
        return { value: entry.value, done: false }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error('api gateway: Remote stream uplink inbox has one pending read')
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /** Consumer stopped reading: later items are dropped, a pending read ends. */
  return(): Promise<IteratorResult<unknown>> {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.signal()
    return Promise.resolve(UPLINK_DONE)
  }

  private violate(error: RemoteError<'gateway/protocol' | 'gateway/uplink-overflow'>): void {
    this.fail(error)
    this.onViolation(error)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Close the socket when the Peer's scope is disposed. A scope that is already
 * disposed leaves no Peer for the socket to speak for, so the socket closes now.
 * @returns the registration's disposer, or `undefined` when the socket was closed.
 */
function bindPeer(websocket: WebSocket, peer: PeerScope): (() => unknown) | undefined {
  try {
    return peer.ctx.effect(
      () => () => { websocket.close(1001, 'peer left') },
      'api-gateway: Remote stream socket bound to its Peer',
    )
  } catch {
    websocket.close(1001, 'peer left')
    return undefined
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
