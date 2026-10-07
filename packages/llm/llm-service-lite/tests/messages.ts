/** Message and request builders shared by the adapter's specs. */

import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ModelMessageSource, ToolSchema } from '@deepseek-ai/dsh-llm'

/** One system-prompt message carrying the given text. */
export function system(text: string, id = 'system'): Message {
  return { id: MessageId(id), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] }
}

/** One user message with the given blocks. */
export function user(content: ContentBlock[], id = 'user'): Message {
  return { id: MessageId(id), role: 'user', source: { kind: 'user' }, content }
}

/** One assistant message produced by the given route. */
export function assistant(
  content: ContentBlock[],
  source: Partial<ModelMessageSource> = {},
  id = 'assistant',
): Message {
  return {
    id: MessageId(id),
    role: 'assistant',
    source: { kind: 'model', provider: 'gateway', model: 'm', ...source },
    content,
  }
}

/** One tool-result message answering the given call. */
export function toolResult(callId: string, text: string, id = `result-${callId}`): Message {
  return {
    id: MessageId(id),
    role: 'tool',
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
  }
}

/** One tool call the model requested. */
export function toolCall(id: string, name: string, args: string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
}

/** Plain text block. */
export function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/** One assembled request with the caller's fields layered onto a minimal call. */
export function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'gateway', model: 'm', messages: [], ...overrides }
}

/** One tool schema. */
export function toolSchema(name = 'shell'): ToolSchema {
  return { name, description: `run ${name}`, parameters: { type: 'object', properties: {} } }
}
