/** A Host-wide capacity refusal reaches the Browser view as the localized terminal quota issue. */
import { afterEach, expect, it, vi } from 'vitest'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { streamMethod } from '@deepseek-ai/dsh-remote-mock'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TerminalView, type TerminalRemote } from '../src/client/model.ts'
import type { TerminalEnvironment, WebTerminalId, WebTerminalInfo } from '../src/types.ts'

const sessionId = 'session' as SessionId
const info: WebTerminalInfo = {
  id: 'terminal' as WebTerminalId, shell: { name: 'bash', path: '/bin/bash', args: ['-i'] }, title: 'bash',
  cwd: '/workspace', rows: 24, cols: 80, state: 'running', exitCode: null,
}
const environment: TerminalEnvironment = { cwd: info.cwd, maxInputBytes: 1000, maxCols: 200, maxRows: 100, scrollback: 100 }
const success = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function fixture() {
  const remote: TerminalRemote = {
    retain: vi.fn<TerminalRemote['retain']>(streamMethod<TerminalRemote['retain']>(async function* () { yield { type: 'retained' } })),
    shells: vi.fn<TerminalRemote['shells']>(async () => success([info.shell])),
    environment: vi.fn<TerminalRemote['environment']>(async () => success(environment)),
    list: vi.fn<TerminalRemote['list']>(async () => success([])),
    create: vi.fn<TerminalRemote['create']>(async (_sessionId, request) => success({ ...info, id: request.id })),
    close: vi.fn<TerminalRemote['close']>(async () => success(undefined)),
    rename: vi.fn<TerminalRemote['rename']>(async () => success(undefined)),
    write: vi.fn<TerminalRemote['write']>(async () => success(undefined)),
    resize: vi.fn<TerminalRemote['resize']>(async () => success(undefined)),
    follow: vi.fn<TerminalRemote['follow']>(streamMethod<TerminalRemote['follow']>(async function* () { /* A quota refusal never reaches the output attachment. */ })),
  }
  // Allocation fails before any stream opens, so the reconnecting stream factory stays unused.
  const gateway = { $stream: vi.fn() } as unknown as Pick<ClientRemote, '$stream'>
  const model = new TerminalView(sessionId, remote, gateway, info.id)
  cleanups.push(() => model.dispose())
  return { model, remote }
}

it('reports a Host-wide capacity refusal as the localized terminal quota issue', async () => {
  const { model, remote } = fixture()
  vi.mocked(remote.create).mockResolvedValueOnce({
    ok: false,
    error: new RemoteError('terminal/capacity-reached', 'Host-wide terminal buffer capacity reached while opening a new terminal', {
      limit: 268_435_456, used: 268_435_456, requested: 2_000_000, purpose: 'terminal',
    }),
  })
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({
    phase: 'failed', issue: 'terminalLimit',
    error: 'Host-wide terminal buffer capacity reached while opening a new terminal',
  })
})
