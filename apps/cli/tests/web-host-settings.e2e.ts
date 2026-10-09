/**
 * The web-address settings page against the real CLI: the `webHost` Remote
 * namespace the General Settings row reads and writes.
 *
 * C5 is a startup-only setting, and every one of its claims is about a
 * different process than the one serving the request, so the package specs
 * cannot prove it: they pin the Host service and the page separately, with the
 * patch writer mocked on one side and the Remote client mocked on the other.
 * What has to be true together is that the shipped web profile actually serves
 * the namespace, that a save lands in the profile's own patch file, that the
 * process serving the request does not move, and that the next start reads the
 * line back and binds it. Only the last of those happens in a second process,
 * and it is the one an operator would notice.
 *
 * The bind is the observable, and it only proves anything when the saved
 * address differs from the shipped default: saving `0.0.0.0` and watching the
 * next start publish every interface would pass just as well with the save
 * deleted. So the save states `localhost`, a loopback name the default never
 * produces, and the second start must come up loopback — no `(LAN: <url>)`
 * suffix. A third start then passes `--host 0.0.0.0` to show the flag still
 * outranks the line, and that an exposed bind says so on the terminal: no
 * shipped bundle mounts a logger exporter, so the exposure notice depends on
 * the console channel rather than on the logger call beside it.
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DSH_SOURCE_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSX_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
/** The profile `dsh web` composes, and the patch file a save is expected to reach. */
const PROFILE_PATCH = join('.dsh', 'profiles', 'web', 'cordis.patch.yml')
const SPAWN_TIMEOUT_MS = 120_000

interface RunningWeb {
  readonly child: ChildProcess
  readonly launchUrl: string
  readonly output: () => string
}

interface JsonObject {
  [key: string]: unknown
}

function redact(output: string): string {
  return output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
}

/** Reserve one concrete loopback port, then release it for the CLI process. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

/**
 * The environment one CLI run sees. Credentials are stripped by name — a token
 * or key from the developer's own shell must not decide what this test
 * resolves, least of all `DSH_ACCESS_TOKEN`, which would replace the token file
 * the non-loopback start is supposed to create.
 * @param root - temporary working directory, the profile's parent.
 * @param dshHome - Harness home holding the profile patch under test.
 * @returns the child environment.
 */
function cleanEnvironment(root: string, dshHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  return {
    ...env,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
  }
}

/** Start the public source CLI and wait for its authenticated readiness URL. */
async function startWeb(
  root: string,
  dshHome: string,
  port: number,
  extraArgs: readonly string[],
): Promise<RunningWeb> {
  const child = spawn(process.execPath, [
    '--import', TSX_LOADER,
    DSH_SOURCE_BIN,
    'web',
    '--no-open',
    '--port', String(port),
    ...extraArgs,
  ], {
    cwd: root,
    env: cleanEnvironment(root, dshHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`dsh web did not become ready:\n${redact(output)}`))
    }, SPAWN_TIMEOUT_MS)
    const append = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-100_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (settled || match?.[1] === undefined) return
      settled = true
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      fail(error)
    })
    child.once('exit', (code) => {
      fail(new Error(`dsh web exited before readiness (${String(code)}):\n${redact(output)}`))
    })
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(running: RunningWeb): Promise<void> {
  if (running.child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => { running.child.once('exit', () => { resolve() }) })
  running.child.kill('SIGTERM')
  const forced = setTimeout(() => { running.child.kill('SIGKILL') }, 10_000)
  forced.unref()
  await exited
  clearTimeout(forced)
}

/** Exchange the launch URL's token for the browser cookie, as a browser would. */
async function exchange(launchUrl: string): Promise<string> {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error('the token exchange omitted Set-Cookie')
  return setCookie.split(';', 1)[0]!
}

/**
 * Call one `webHost` Remote method the way the page does: the same envelope
 * `settings/describe` uses, with the namespace's own method name and named args.
 * @param port - port the running CLI listens on.
 * @param cookie - browser cookie minted by the token exchange.
 * @param method - Remote method name, `webHost/status` or `webHost/save`.
 * @param args - named arguments of that method.
 * @returns the raw response body.
 */
function callWebHost(
  port: number,
  cookie: string,
  method: string,
  args: JsonObject,
): Promise<{ status: number; body: JsonObject }> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `web-host-${method}`,
    method,
    payload: { args },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${String(port)}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        cookie,
      },
    }, (res) => {
      const chunks: Uint8Array[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as JsonObject })
        } catch (error: unknown) {
          reject(new Error(`webHost call ${method} did not answer JSON: ${text}`, { cause: error }))
        }
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

/** The `value` of a successful call, refusing a failure with its own message. */
async function valueOf(
  port: number,
  cookie: string,
  method: string,
  args: JsonObject,
): Promise<JsonObject> {
  const { status, body } = await callWebHost(port, cookie, method, args)
  expect(status, JSON.stringify(body)).toBe(200)
  const result = body.result as { ok?: boolean; value?: JsonObject } | undefined
  expect(result?.ok, JSON.stringify(body)).toBe(true)
  return result?.value ?? {}
}

describe('the web-address settings page against the real CLI', () => {
  it('persists a bind host for the next start and leaves the running one alone', { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-host-settings-'))
    const dshHome = join(root, '.dsh')
    const port = await freePort()
    let first: RunningWeb | undefined
    let second: RunningWeb | undefined
    let third: RunningWeb | undefined
    try {
      // A loopback start: no token file, and `--host` makes the posture explicit
      // so the assertions below separate the pinned address from the saved one.
      first = await startWeb(root, dshHome, port, ['--host', '127.0.0.1'])
      const cookie = await exchange(first.launchUrl)

      const status = await valueOf(port, cookie, 'webHost/status', {})
      expect(status).toMatchObject({
        rowFound: true,
        writable: true,
        bound: '127.0.0.1',
        pinned: '127.0.0.1',
      })

      // The row's own grammar refuses what it cannot bind, with its reason.
      const refused = await callWebHost(port, cookie, 'webHost/save', { host: 'web.example.com' })
      expect(refused.status).toBe(200)
      expect(refused.body.result).toMatchObject({ ok: false })
      expect(JSON.stringify(refused.body)).toContain('neither an IPv4 address nor a loopback address')

      // A loopback name, not the wildcard: the shipped default already publishes
      // every interface, so only an address the default cannot produce makes
      // the next start's bind evidence that the saved line was read.
      const saved = await valueOf(port, cookie, 'webHost/save', { host: 'localhost' })
      expect(saved.persisted).toBe('localhost')

      // The profile's own patch is the storage, and the line is the only thing
      // the save added to it.
      const patch = await readFile(join(root, PROFILE_PATCH), 'utf8')
      expect(patch).toContain('@deepseek-ai/dsh-host-lan-access')
      expect(patch).toContain('host: localhost')

      // Startup-only: the process that served the write still binds loopback,
      // so the save cannot have rebound the server under the open page.
      const after = await valueOf(port, cookie, 'webHost/status', {})
      expect(after.bound).toBe('127.0.0.1')

      await stopWeb(first)
      first = undefined

      // The next start reads the saved line back, so it stays on loopback: a
      // start that ignored the line would publish every interface, which shows
      // up as the LAN suffix on the URL line and as the token file that only a
      // reachable bind creates.
      second = await startWeb(root, dshHome, port, [])
      const secondOutput = redact(second.output())
      // The advertised URL carries the address the line names, not a
      // renormalized one, so this also proves the line reached the URL.
      expect(secondOutput).toContain('dsh web: http://localhost:')
      expect(secondOutput).not.toContain('(LAN: ')
      expect(secondOutput).not.toContain('lan-access: bound ')
      expect(new URL(second.launchUrl).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/u)

      await stopWeb(second)
      second = undefined

      // The flag still outranks the saved line: the same profile publishes one
      // address wider for this run alone, and the notice the operator is meant
      // to act on reaches the terminal. That second half is not decoration —
      // no shipped bundle mounts a logger exporter, so the logger call on its
      // own would leave an exposed bind silent.
      third = await startWeb(root, dshHome, port, ['--host', '0.0.0.0'])
      const thirdOutput = redact(third.output())
      expect(thirdOutput).toContain('(LAN: ')
      expect(thirdOutput).toContain('lan-access: bound 0.0.0.0, reachable by anything that can route to it')
      expect(thirdOutput).toContain('The persistent access token is the only authenticator on that surface')
      expect((await stat(join(dshHome, 'access-token'))).mode & 0o777).toBe(0o600)
    } catch (error) {
      const evidence = [first?.output(), second?.output(), third?.output()]
        .filter(value => value !== undefined).join('\n')
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${redact(evidence)}`, { cause: error })
    } finally {
      if (third !== undefined) await stopWeb(third)
      if (second !== undefined) await stopWeb(second)
      if (first !== undefined) await stopWeb(first)
      await rm(root, { recursive: true, force: true })
    }
  })
})
