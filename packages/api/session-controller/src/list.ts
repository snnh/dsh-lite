/** Cold-safe Session list and search projection. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError, type SessionRecord, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionProjectionHints, SessionProjectionValues, SessionSearchItem,
  SessionSearchValue, SessionSummary,
} from './types.ts'

const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Cold rows whose projection-cache reads may be in flight at once.
 *
 * Each cold row costs one durable point read of its own cache document, and
 * those reads are independent of each other, so a strictly one-at-a-time pass
 * leaves the medium idle for the whole of every read. The window stays small
 * because only the first part of a read happens off this thread: the file read
 * overlaps, while the decode, the JSON parse, and the record validation run
 * here as each read resolves. A wider window therefore queues more of that
 * work in front of the next event-loop turn without shortening the sum of it,
 * which is what the responsiveness budget prices.
 *
 * Measured on the benchmark's `tail` corpus — 300 listed rows, ~883 KB stored
 * per row — as that benchmark reports each figure (median of three fresh
 * children, on the list + JSON time it asserts):
 *
 * | In flight | First list | Repeat list | Worst callback delay |
 * |---|---:|---:|---:|
 * | 1 | 3,262 ms | 3,183 ms | 4.0 ms |
 * | 2 | 3,211 ms | 3,109 ms | 4.8 ms |
 * | 4 | 3,210 ms | 3,115 ms | 52.2 ms (children 44.4 / 52.2 / 69.9) |
 *
 * Over the domain's point reads alone the same corpus measured 2,369 ms one at
 * a time, 2,240 ms with 2 in flight, 2,213 ms with 4 (its floor), 2,355 ms
 * with 8, and 2,382 ms with 16.
 *
 * Two is the setting to keep. The overlap is worth about 2 % of the listing
 * and no more, because only the file read leaves this thread: the decode, the
 * JSON parse, and the record validation are most of a row's cost and run here
 * either way. Wider windows bought no further time and four already spends
 * most of the 75 ms callback budget the benchmark enforces.
 */
export const COLD_READ_WINDOW = 2

/**
 * Swallow one queued read's rejection; the drain that awaits it still observes
 * it. A cold summary only rejects when the listing is already failing — the
 * projection read itself is fail-soft and answers `undefined` — so this handler
 * exists to keep a rejection the window has not drained yet from surfacing as
 * an unhandled rejection, and is not a branch a caller can reach.
 */
/* v8 ignore next 2 -- defensive: only a failing listing rejects a cold summary */
const ignoreRejection = (): void => {}

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param workSliceMs - Resolved positive integral list-work budget in milliseconds.
   */
  constructor(private readonly ctx: Context, private readonly workSliceMs: number) {
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.liveProjectionsFor(session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      formatStatus: 'current',
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read every visible attached and persisted Session without activating an Agent.
   * Cold rows each cost one projection-cache point read, so they are read
   * {@link COLD_READ_WINDOW} at a time and emitted in row order.
   * @param signal - optional cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  async list(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    const items: SessionSummary[] = []
    const cold: SessionRecord[] = []
    let yieldDeadline = performance.now() + this.workSliceMs
    for (const record of records) {
      signal?.throwIfAborted()
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        items.push(this.summaryFor(live))
      } else if (record.header.cwd !== undefined) {
        cold.push(record)
      }
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    // Cold rows are read with {@link COLD_READ_WINDOW} of them in flight and
    // emitted in row order, so a listing overlaps the medium's latency without
    // reordering its rows. Every exit from this loop — the awaited result, the
    // yield, and the return — re-checks the signal, so a cancellation still
    // stops the list at a row boundary and never returns a partial list.
    const pending: Promise<SessionSummary>[] = []
    const emitNext = async (): Promise<void> => {
      const next = pending.shift()
      /* v8 ignore next -- every caller drains a non-empty window */
      if (next === undefined) return
      items.push(await next)
      signal?.throwIfAborted()
      if (performance.now() >= yieldDeadline) {
        await scheduler.yield()
        signal?.throwIfAborted()
        yieldDeadline = performance.now() + this.workSliceMs
      }
    }
    for (const record of cold) {
      signal?.throwIfAborted()
      const summary = this.summarizeCold(record)
      // A read the window (or a cancellation) never awaits must not surface as
      // an unhandled rejection; the drain below still observes its failure.
      void summary.catch(ignoreRejection)
      pending.push(summary)
      if (pending.length >= COLD_READ_WINDOW) await emitNext()
    }
    while (pending.length > 0) await emitNext()
    signal?.throwIfAborted()
    items.sort((left, right) => right.updatedAt - left.updatedAt)
    return items
  }

  private async summarizeCold({ header, formatStatus }: SessionRecord): Promise<SessionSummary> {
    const projections = await this.projectionsFor(header)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      ...(formatStatus === undefined ? {} : { formatStatus }),
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  /**
   * The projection block the live registry computed for an attached Session.
   * Synchronous on purpose: `api-session/added` carries a complete summary out
   * of an event listener, the registry holds this Session's cells in memory,
   * and a live block is never read from the persisted cache.
   * @param session - the attached Session to summarize.
   * @returns the sequenced block, or `undefined` when the registry or the row failed.
   */
  private liveProjectionsFor(session: Session): SessionProjectionHints | undefined {
    try {
      // The live registry computed the block for this Session: its watermark
      // shares the sequence space of the Session's baselines and frames.
      return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${session.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }

  /**
   * The projection block a cold row reads from the persisted cache by header
   * alone. The cache serves seeded and unseeded lifecycles alike because a
   * listing never seeds a fold, and the watermark is the stored record's own.
   * The read is asynchronous: the cache answers a hot session from its
   * resident copy and pays one point read of that session's stored document
   * when it is cold.
   * @param header - the listed session's header (no log read).
   * @returns the cached block, or `undefined` when the cache served none.
   */
  private async projectionsFor(header: SessionHeader): Promise<SessionProjectionHints | undefined> {
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf('cached', await cache?.cachedSnapshot(header) ?? await cache?.cachedPredecessorTitle(header))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Wrap one projection block as Session-list hints of the named sequence space.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @returns the hints, or `undefined` when the block is absent or carries no value.
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  // Listing hints contain every wire value the source currently holds but
  // remain partial: missing cells and cache rows are never materialized here.
  return { kind, asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
