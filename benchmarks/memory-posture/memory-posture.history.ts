/**
 * Synthetic Session history the per-session phase opens.
 *
 * Authored through the production `Session.append` path and the production
 * assistant-stream compaction, so the persisted log is the same shape a real
 * conversation leaves — not a hand-written JSONL approximation. Sizes come from
 * reviewed constants; no recorded transcript, user material, or ambient
 * repository is read.
 *
 * @module benchmarks/memory-posture/history
 */

import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { HISTORY } from './memory-posture.constants.ts'

/**
 * Build a deterministic, poorly compressible prompt of the reviewed length.
 *
 * A repeated constant would compress to almost nothing on disk and would let V8
 * share one backing string; a real conversation's log is neither. The suffix is
 * stable for a given turn, so repeated runs persist identical bytes.
 *
 * @param turn - completed turn ordinal.
 * @returns exactly {@link HISTORY.promptChars} characters.
 */
function promptFor(turn: number): string {
  let text = ''
  for (let index = 0; text.length < HISTORY.promptChars; index += 1) {
    text += Math.imul(turn * 31 + index, 2_654_435_761).toString(36)
  }
  return text.slice(0, HISTORY.promptChars)
}

function chunksFor(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Author one deterministic completed-turn history through the production Session API.
 * @param id - the Session identity the events belong to.
 * @returns detached current-generation events with fixed ids and timestamps.
 */
export function syntheticHistory(id: SessionId): SessionEvent[] {
  const session = Session.create(id)
  for (let turn = 1; turn <= HISTORY.turns; turn += 1) {
    const reply = `acknowledged turn ${String(turn)}`
    const chunks = chunksFor(reply)
    const stream = new AssistantStreamAccumulator()
    chunks.forEach((chunk, index) => {
      stream.push({ time: HISTORY.timeZero + turn * 1_000 + index, chunk })
    })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: MessageId(`posture-prompt-${String(turn)}`),
      role: 'user',
      content: [{ type: 'text', text: promptFor(turn) }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: {
        id: MessageId(`posture-reply-${String(turn)}`),
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      stream: [...stream.snapshot()],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents().map(event => ({ ...event, time: HISTORY.timeZero + event.seq }))
}
