/**
 * Compiled synthetic provider for the memory-posture probe's Session opens.
 *
 * Opening a Session through the production Agent registry needs a provider
 * route that resolves; it never needs a completion. This adapter registers the
 * route the probe names and fails loud if a measured host ever asks it to
 * generate, so a profile change that starts running turns is visible instead of
 * silently measuring a different path.
 *
 * @module benchmarks/memory-posture/model
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { BENCH_MODEL, BENCH_PROVIDER } from './memory-posture.constants.ts'

class MemoryPostureAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 1_000_000 })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(`${BENCH_PROVIDER}/${BENCH_MODEL} is a Session-opening stub and cannot generate`)
  }
}

/** Loader plugin identity. */
export const name = 'memory-posture-benchmark-model'
/** The scripted route requires the production LLM registry. */
export const inject = ['llm']

/**
 * Register the synthetic provider without changing any runtime service or tool.
 * @param ctx - profile-owned plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter([BENCH_PROVIDER], new MemoryPostureAdapter()))
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-llm': import.meta.resolve('@deepseek-ai/dsh-llm'),
})
