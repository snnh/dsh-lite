/** Host-wide buffer ceiling: pre-spawn refusals, Session release, and no eviction of live terminals. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessTerminalEnvironment, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalController, type Config } from '../src/index.ts'
import type { TerminalAttachmentId, WebTerminalId } from '../src/types.ts'

/** One screen at the widest permitted geometry: 100 retained rows × 200 columns × 4 bytes per cell. */
const SCREEN = 80_000
/** One follower queue, well below the screen so each reservation is distinguishable. */
const QUEUE = 10_000
const config: Config = {
  shellCandidates: ['bash'], shell: { path: '/bin/bash', name: 'bash', args: ['--noprofile', '--norc', '-i'] },
  maxTerminals: 8, maxCols: 200, maxRows: 100, scrollback: 100, maxBufferedBytes: QUEUE, maxInputBytes: 1000,
  disposeGraceMs: 100, unattendedTimeoutMs: 0, activityPollIntervalMs: 30_000, cleanupRetryMs: 60_000,
}

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

const terminal = (id: string) => ({ id: id as WebTerminalId, cols: 80, rows: 24 })
const signal = (): AbortSignal => new AbortController().signal

function owner(ctx: Context, id = 'session'): Agent {
  return { id: id as SessionId, ctx, session: { id: id as SessionId, header: {} } } as unknown as Agent
}

type Handle = SubprocessTerminalHandle & { readonly terminate: ReturnType<typeof vi.fn> }

function fixture(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const effects = vi.spyOn(ctx.fiber, 'effect')
  const sandboxPolicy = { defaultMode: 'danger-full-access', workspaceRoot: '/workspace', resolve: vi.fn((): SandboxExecutionPolicy => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' })) }
  // The execution environment resolves the Session's directory through the
  // working-directory service; this fixture states one without filesystem work.
  const workingDirectory = {
    get: vi.fn<(session: Agent['session']) => string>(session => session.header.cwd ?? '/workspace'),
    ensure: vi.fn<(agent: Agent, signal?: AbortSignal) => Promise<string>>(async agent => agent.session.header.cwd ?? '/workspace'),
  }
  ctx.provide('sandboxPolicy', sandboxPolicy as never)
  ctx.provide('workingDirectory', workingDirectory as never)
  // Every allocation gets its own process range, so two live terminals never share an output stream.
  const handles: Handle[] = []
  const handle = (): Handle => {
    const output = new PassThrough()
    const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const minted = {
      pid: handles.length + 1, output, done: done.promise, write: vi.fn(async () => {}), resize: vi.fn(async () => {}),
      inspectActivity: vi.fn(async () => ({ state: 'unknown' as const, revision: 0 })),
      terminate: vi.fn(async () => { output.end(); done.resolve({ exitCode: 0, signal: null }) }),
    }
    handles.push(minted as unknown as Handle)
    return minted as unknown as Handle
  }
  const subprocess = {
    terminalEnvironment: vi.fn(async (): Promise<SubprocessTerminalEnvironment> => ({ platform: 'posix', defaultShell: '/bin/bash' })),
    resolveExecutable: vi.fn(async (path: string) => path),
    spawnTerminal: vi.fn(async () => handle()),
  }
  ctx.provide('subprocess', subprocess as never)
  const controller = new TerminalController(ctx, { ...config, ...overrides })
  const at = (index: number): Handle => {
    const minted = handles[index]
    if (minted === undefined) throw new Error(`No terminal was spawned at index ${index}`)
    return minted
  }
  const disposeEffect = (label: string): Promise<void> => {
    const index = effects.mock.calls.findIndex(call => call[1] === label)
    const result = effects.mock.results[index]
    if (result?.type !== 'return' || typeof result.value !== 'function') throw new Error(`Missing effect: ${label}`)
    return result.value()
  }
  return { ctx, agent: owner(ctx), controller, subprocess, handles, at, mint: handle, disposeEffect }
}

async function snapshot(controller: TerminalController, agent: Agent, id: string, attachment: string) {
  const stream = controller.follow(agent, id as WebTerminalId, attachment as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
  const first = await stream.next()
  if (first.done === true) throw new Error('The terminal stream ended before its snapshot')
  return { stream, frame: first.value }
}

describe('Host-wide terminal buffer capacity', () => {
  it('refuses a new terminal before spawning it and leaves the admitted Session untouched', async () => {
    const { controller, agent, subprocess, at } = fixture({ maxTotalBufferedBytes: SCREEN + QUEUE })
    await controller.create(agent, terminal('one'), signal())
    const failure = await controller.create(agent, terminal('two'), signal()).then(
      () => undefined, (error: unknown) => remoteErrorOf(error))
    expect(failure).toMatchObject({
      code: 'terminal/capacity-reached',
      details: { limit: SCREEN + QUEUE, used: SCREEN, requested: SCREEN, purpose: 'terminal' },
    })
    // The refusal happened before allocation, so no process exists for the refused identity.
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    expect(at(0).terminate).not.toHaveBeenCalled()
    expect(controller.list(agent.id)).toMatchObject([{ id: 'one', state: 'running' }])
    const { stream, frame } = await snapshot(controller, agent, 'one', 'writer')
    expect(frame).toMatchObject({ type: 'snapshot', info: { id: 'one', state: 'running' } })
    await stream.return?.()
    expect(at(0).terminate).not.toHaveBeenCalled()
  })

  it('refuses a follower at the ceiling without detaching or terminating its terminal', async () => {
    const { controller, agent, at } = fixture({ maxTotalBufferedBytes: SCREEN })
    await controller.create(agent, terminal('one'), signal())
    const stream = controller.follow(agent, 'one' as WebTerminalId, 'writer' as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
    const failure = await stream.next().then(() => undefined, (error: unknown) => remoteErrorOf(error))
    expect(failure).toMatchObject({
      code: 'terminal/capacity-reached',
      details: { limit: SCREEN, used: SCREEN, requested: QUEUE, purpose: 'follower' },
    })
    expect(controller.list(agent.id)).toMatchObject([{ id: 'one', state: 'running' }])
    expect(at(0).terminate).not.toHaveBeenCalled()
  })

  it('refunds a follower queue when that attachment detaches', async () => {
    const { controller, agent, at } = fixture({ maxTotalBufferedBytes: SCREEN + QUEUE })
    await controller.create(agent, terminal('one'), signal())
    const first = await snapshot(controller, agent, 'one', 'first')
    const refused = controller.follow(agent, 'one' as WebTerminalId, 'second' as TerminalAttachmentId, signal())[Symbol.asyncIterator]()
    await expect(refused.next()).rejects.toThrow('while opening a new follower')
    // Detaching the first attachment returns its queue to the budget; the terminal itself never moved.
    await first.stream.return?.()
    const second = await snapshot(controller, agent, 'one', 'second')
    expect(second.frame).toMatchObject({ type: 'snapshot', info: { controllerId: 'second' } })
    await second.stream.return?.()
    expect(at(0).terminate).not.toHaveBeenCalled()
  })

  it('releases a Session terminal and its budget when the Session owner is disposed', async () => {
    const { controller, agent, subprocess, at, disposeEffect } = fixture({ maxTotalBufferedBytes: SCREEN })
    await controller.create(agent, terminal('one'), signal())
    await disposeEffect('terminal-controller.owner')
    expect(at(0).terminate).toHaveBeenCalledOnce()
    expect(controller.list(agent.id)).toEqual([])
    // A fresh create only succeeds when the disposed owner record is gone AND its screen was refunded.
    await controller.create(agent, terminal('two'), signal())
    expect(subprocess.spawnTerminal).toHaveBeenCalledTimes(2)
    await controller.close(agent, 'two' as WebTerminalId)
  })

  it('refunds the screen budget of an allocation that fails before its terminal exists', async () => {
    const { controller, agent, subprocess } = fixture({ maxTotalBufferedBytes: SCREEN })
    subprocess.resolveExecutable.mockRejectedValueOnce(new Error('shell vanished'))
    await expect(controller.create(agent, terminal('one'), signal())).rejects.toThrow('shell vanished')
    await controller.create(agent, terminal('two'), signal())
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    await controller.close(agent, 'two' as WebTerminalId)
  })

  it('refunds the screen budget of a cancelled allocation it rolled back', async () => {
    const { controller, agent, subprocess, at, mint } = fixture({ maxTotalBufferedBytes: SCREEN })
    const abort = new AbortController()
    subprocess.spawnTerminal.mockImplementationOnce(async () => { const handle = mint(); abort.abort(new Error('disconnected')); return handle })
    await expect(controller.create(agent, terminal('one'), abort.signal)).rejects.toThrow('disconnected')
    expect(at(0).terminate).toHaveBeenCalledOnce()
    await controller.create(agent, terminal('two'), signal())
    expect(subprocess.spawnTerminal).toHaveBeenCalledTimes(2)
    await controller.close(agent, 'two' as WebTerminalId)
  })

  it('accounts every screen and queue exactly once across a terminal lifetime', async () => {
    const { controller, agent, at } = fixture({ maxTotalBufferedBytes: 2 * SCREEN + 2 * QUEUE })
    // Reserved bytes are the only view of the ledger from outside, so read it directly here.
    const reserved = (): number => (controller as unknown as { budget: { reserved: number } }).budget.reserved
    expect(reserved()).toBe(0)
    await controller.create(agent, terminal('one'), signal())
    expect(reserved()).toBe(SCREEN)
    const first = await snapshot(controller, agent, 'one', 'first')
    expect(reserved()).toBe(SCREEN + QUEUE)
    const second = await snapshot(controller, agent, 'one', 'second')
    expect(reserved()).toBe(SCREEN + 2 * QUEUE)
    await first.stream.return?.()
    expect(reserved()).toBe(SCREEN + QUEUE)
    await second.stream.return?.()
    expect(reserved()).toBe(SCREEN)
    await controller.close(agent, 'one' as WebTerminalId)
    expect(reserved()).toBe(0)
    expect(at(0).terminate).toHaveBeenCalledOnce()
  })

  it('admits screens and followers freely while the ceiling is disabled', async () => {
    const { controller, agent, subprocess } = fixture({ maxTotalBufferedBytes: 0, maxTerminals: 3 })
    await controller.create(agent, terminal('one'), signal())
    await controller.create(agent, terminal('two'), signal())
    const { stream } = await snapshot(controller, agent, 'one', 'writer')
    await stream.return?.()
    // A failed allocation refunds nothing because nothing was reserved.
    subprocess.resolveExecutable.mockRejectedValueOnce(new Error('shell vanished'))
    await expect(controller.create(agent, terminal('three'), signal())).rejects.toThrow('shell vanished')
    await controller.close(agent, 'two' as WebTerminalId)
    expect(controller.list(agent.id)).toMatchObject([{ id: 'one', state: 'running' }])
  })
})
