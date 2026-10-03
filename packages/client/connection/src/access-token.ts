/**
 * The persistent browser access token.
 *
 * A process-local launch token dies with the process, which is enough for the
 * loopback handoff and useless for a link an operator keeps or shares: every
 * restart would print a different URL and invalidate the one already open on
 * another device. This module resolves one token that outlives the process, in
 * the order `DSH_ACCESS_TOKEN`, the harness home's `access-token` file, and a
 * freshly generated value written back with owner-only permissions.
 *
 * The token is the whole authentication input: it mints the signed browser
 * cookie through the same exchange the launch token uses, and it grants nothing
 * beyond the browser session that cookie represents. Deleting the file (or
 * changing the environment value) rotates the token on the next start.
 *
 * @module @deepseek-ai/dsh-connection/access-token
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Environment override; a configured value must meet {@link MIN_ACCESS_TOKEN_LENGTH}. */
export const ACCESS_TOKEN_ENV = 'DSH_ACCESS_TOKEN'

/** File name under the harness home holding the token when the environment names none. */
export const ACCESS_TOKEN_FILENAME = 'access-token'

/**
 * Minimum accepted token length, in characters. A generated token is hex of
 * {@link TOKEN_BYTES} random bytes, so the floor only rejects configured values
 * that would be weaker than the generated one.
 */
export const MIN_ACCESS_TOKEN_LENGTH = 32

/** Random bytes behind a generated token; hex encoding doubles the character count. */
const TOKEN_BYTES = 32

/**
 * Read the configured token.
 * @param env - environment mapping used to read the override.
 * @returns the trimmed token, or undefined when unset or blank.
 * @throws when the configured value is shorter than {@link MIN_ACCESS_TOKEN_LENGTH}.
 */
export function accessTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ACCESS_TOKEN_ENV]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // A blank override means "unset" rather than "no authentication", matching
  // how the harness home treats an empty `DSH_HOME`.
  if (trimmed.length === 0) return undefined
  if (trimmed.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new Error(`${ACCESS_TOKEN_ENV} must be at least ${String(MIN_ACCESS_TOKEN_LENGTH)} characters`)
  }
  return trimmed
}

/**
 * Read the persisted token.
 * @param path - absolute path of the token file.
 * @returns the stored token, or undefined when the file is absent, unreadable, or too short.
 */
export async function readPersistedAccessToken(path: string): Promise<string | undefined> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    // An absent file is the ordinary first-run case; an unreadable one has the
    // same answer here (no usable token) and the write below reports its own
    // failure if it then cannot persist the replacement.
    return undefined
  }
  const trimmed = contents.trim()
  return trimmed.length >= MIN_ACCESS_TOKEN_LENGTH ? trimmed : undefined
}

/**
 * Persist a token with owner-only permissions.
 * @param path - absolute path of the token file.
 * @param token - the token to write.
 */
async function persistAccessToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // `mode` only applies when this call creates the file, so an existing file
  // keeps its old mode; the chmod below is what tightens it either way.
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  try {
    await chmod(path, 0o600)
  } catch {
    /* v8 ignore next -- requires a filesystem that cannot carry an owner-only mode, such as a mounted Windows share. */
    // Windows and permission-less filesystems have no POSIX mode to tighten.
  }
}

/**
 * Resolve the token this process authenticates with, creating and persisting
 * one when neither the environment nor the file provides it.
 * @param path - absolute path of the token file.
 * @param env - environment mapping used to read the override.
 * @returns the resolved token.
 */
export async function ensureAccessToken(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = accessTokenFromEnv(env)
  if (configured !== undefined) return configured
  const persisted = await readPersistedAccessToken(path)
  if (persisted !== undefined) return persisted
  const generated = randomBytes(TOKEN_BYTES).toString('hex')
  await persistAccessToken(path, generated)
  return generated
}
