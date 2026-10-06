/** The persistent access token: environment override, file reuse, generation, and mode. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_ENV,
  MIN_ACCESS_TOKEN_LENGTH,
  accessTokenFromEnv,
  ensureAccessToken,
  readPersistedAccessToken,
} from '../src/index.ts'

/** A value exactly at the floor, so a boundary regression changes the outcome. */
const AT_FLOOR = 'a'.repeat(MIN_ACCESS_TOKEN_LENGTH)
/** A longer configured value, to prove the token is kept verbatim rather than truncated. */
const LONGER = 'b'.repeat(MIN_ACCESS_TOKEN_LENGTH * 2)

let dir: string
let tokenPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-access-token-'))
  // The intermediate directory does not exist: the write path must create it.
  tokenPath = join(dir, 'nested', 'access-token')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('accessTokenFromEnv', () => {
  it('reads a configured token and trims surrounding whitespace', () => {
    expect(accessTokenFromEnv({ [ACCESS_TOKEN_ENV]: `  ${LONGER}\n` })).toBe(LONGER)
  })

  it('accepts a value exactly at the length floor', () => {
    expect(accessTokenFromEnv({ [ACCESS_TOKEN_ENV]: AT_FLOOR })).toBe(AT_FLOOR)
  })

  it('treats unset and blank overrides as absent', () => {
    expect(accessTokenFromEnv({})).toBeUndefined()
    expect(accessTokenFromEnv({ [ACCESS_TOKEN_ENV]: '   ' })).toBeUndefined()
  })

  it('rejects an override below the length floor', () => {
    expect(() => accessTokenFromEnv({ [ACCESS_TOKEN_ENV]: 'short' })).toThrow(
      new RegExp(`${ACCESS_TOKEN_ENV} must be at least ${String(MIN_ACCESS_TOKEN_LENGTH)} characters`, 'u'),
    )
  })
})

describe('readPersistedAccessToken', () => {
  it('is undefined when the file does not exist', async () => {
    expect(await readPersistedAccessToken(tokenPath)).toBeUndefined()
  })

  it('reads a stored token without its trailing newline', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(tokenPath, `${LONGER}\n`)
    expect(await readPersistedAccessToken(tokenPath)).toBe(LONGER)
  })

  it('ignores a stored value below the length floor', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(tokenPath, 'tiny')
    expect(await readPersistedAccessToken(tokenPath)).toBeUndefined()
  })
})

describe('ensureAccessToken', () => {
  it('prefers the environment and persists nothing', async () => {
    expect(await ensureAccessToken(tokenPath, { [ACCESS_TOKEN_ENV]: LONGER })).toBe(LONGER)
    expect(await readPersistedAccessToken(tokenPath)).toBeUndefined()
  })

  it('reuses a persisted token', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(tokenPath, AT_FLOOR)
    expect(await ensureAccessToken(tokenPath, {})).toBe(AT_FLOOR)
  })

  it('generates, persists, and then reuses one owner-only token', async () => {
    const first = await ensureAccessToken(tokenPath, {})
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(await readFile(tokenPath, 'utf8')).toBe(`${first}\n`)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    expect(await ensureAccessToken(tokenPath, {})).toBe(first)
  })

  it('tightens the mode of a file it replaces', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    // A short value is unusable, so the next call regenerates into the same
    // path; the write cannot change an existing file's mode, so the chmod does.
    await writeFile(tokenPath, 'tiny', { mode: 0o644 })
    const replacement = await ensureAccessToken(tokenPath, {})
    expect(replacement).not.toBe('tiny')
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
  })
})
