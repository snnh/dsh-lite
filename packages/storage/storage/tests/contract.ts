/**
 * Shared KV-backend conformance suite. Each backend's spec file calls
 * {@link runKvBackendContract} with a factory bound to its own medium; the
 * suite asserts every clause of the `src/backend.ts` contract so both
 * backends are held to identical semantics.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { KvUnitDescriptor, StorageBackend } from '../src/backend.ts'

/** One conformance run: a fresh backend plus a way to reopen the same medium (crash simulation). */
export interface KvBackendContractHarness {
  /** The backend under test, freshly created over an empty medium. */
  backend: StorageBackend
  /** Open a NEW backend instance over the SAME medium, as after a process restart. */
  reopen(): Promise<StorageBackend>
  /**
   * Whether this backend stamps a unit version per record document in the
   * `per-record` layout. Such a backend opens a unit whose descriptor version
   * moved on and drops only the affected records; a backend that stamps one
   * version per unit (the `single` layout, a row store) refuses the whole unit
   * with `version-mismatch` instead. Omitted means per-unit stamps.
   */
  readonly perRecordVersionStamps?: boolean
}

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'contract_unit',
  version: 3,
  tables: ['alpha', 'beta'],
  hasGlobal: true,
}

/**
 * The same shape in the `per-record` layout: that layout's record documents
 * carry their own version stamp, which is what the unaccepted-version clause
 * observes. A backend serving only one layout reads such a unit as a foreign
 * document and keeps its own per-unit stamp, so the clause branches on
 * {@link KvBackendContractHarness.perRecordVersionStamps}.
 */
const PER_RECORD: KvUnitDescriptor = {
  name: 'contract_records',
  version: 3,
  tables: ['alpha', 'beta'],
  hasGlobal: true,
  layout: 'per-record',
}

/**
 * Run the shared conformance suite against one backend implementation.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvBackendContract(label: string, create: () => Promise<KvBackendContractHarness>) {
  describe(`kv backend contract: ${label}`, () => {
    it('opens a missing unit as empty and serves loadAll immediately', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const snapshot = await unit.loadAll()
      expect(snapshot.tables).toEqual({ alpha: {}, beta: {} })
      expect(snapshot.global).toBeNull()
      await backend.close()
    })

    it('round-trips records and global durably across reopen', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('alpha', 'k2', { n: 2 })
      await unit.putRecord('beta', 'weird key / with:stuff', { ok: true })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      const snapshot = await unit2.loadAll()
      expect(snapshot.tables['alpha']).toEqual({ k1: { n: 1 }, k2: { n: 2 } })
      expect(snapshot.tables['beta']).toEqual({ 'weird key / with:stuff': { ok: true } })
      expect(snapshot.global).toEqual({ counter: 7 })
      await reopened.close()
    })

    it('putRecord overwrites and deleteRecord is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 'old' })
      await unit.putRecord('alpha', 'k', { v: 'new' })
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'k')
      await unit.deleteRecord('alpha', 'never-existed')
      const snapshot = await unit.loadAll()
      expect(snapshot.tables['alpha']).toEqual({})
      await backend.close()
    })

    it('serves one record or the global on demand, without materializing a table', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      await unit.putRecord('beta', 'k2', { n: 2 })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      // A fresh instance over the same medium: the point read serves exactly the
      // value `loadAll` serves for that table and key, and the global without it.
      const reopened = await harness.reopen()
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      await expect(unit2.readRecord('alpha', 'k1')).resolves.toEqual({ n: 1 })
      await expect(unit2.readRecord('beta', 'k2')).resolves.toEqual({ n: 2 })
      await expect(unit2.readGlobal()).resolves.toEqual({ counter: 7 })
      expect((await unit2.loadAll()).tables['alpha']).toEqual({ k1: { n: 1 } })
      await reopened.close()
    })

    it('reads an absent key, table, or global as absent without rejecting', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k1', { n: 1 })
      // An unwritten key, a declared table holding nothing, and a table the
      // descriptor does not declare — absent to `loadAll`, which only ever
      // surfaces declared tables, so absent to a point read too.
      await expect(unit.readRecord('alpha', 'never-written')).resolves.toBeUndefined()
      await expect(unit.readRecord('beta', 'never-written')).resolves.toBeUndefined()
      await expect(unit.readRecord('undeclared', 'k')).resolves.toBeUndefined()
      // The global slot was never written: `null`, the value `loadAll` reports.
      await expect(unit.readGlobal()).resolves.toBeNull()
      await backend.close()
    })

    it('reads a per-record key spelling the layout cannot hold as absent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(PER_RECORD)
      // These spellings can never be a path segment, so no such document is part
      // of the readable set: a point read reports absence like `loadAll`, rather
      // than rejecting the way the write primitives do.
      await expect(unit.readRecord('alpha', 'a/b')).resolves.toBeUndefined()
      await expect(unit.readRecord('alpha', '..')).resolves.toBeUndefined()
      await expect(unit.readRecord('alpha', 'unsafe%2Fkey')).resolves.toBeUndefined()
      await expect(unit.readRecord('undeclared', 'a/b')).resolves.toBeUndefined()
      await backend.close()
    })

    it('never serves a record whose stored version the descriptor does not accept', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(PER_RECORD)
      await unit.putRecord('alpha', 'stale', { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const bumped = { ...PER_RECORD, version: PER_RECORD.version + 1 }
      if (harness.perRecordVersionStamps === true) {
        // A stamp per document: the unit opens on the version bump and drops
        // only the stale record, which the point read and `loadAll` agree is gone.
        const unit2 = await reopened.kv!.open(bumped)
        await expect(unit2.readRecord('alpha', 'stale')).resolves.toBeUndefined()
        expect((await unit2.loadAll()).tables['alpha']).toEqual({})
      } else {
        // One stamp per unit: the medium refuses the bump outright, so no record
        // is ever served under a version the unit does not accept.
        await expect(reopened.kv!.open(bumped)).rejects.toMatchObject({
          name: 'StorageError',
          code: 'version-mismatch',
        })
      }
      await reopened.close()
    })

    it('rejects a version mismatch on reopen without touching the data', async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord('alpha', 'k', { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      await expect(reopened.kv!.open({ ...DESCRIPTOR, version: 4 })).rejects.toMatchObject({
        name: 'StorageError',
        code: 'version-mismatch',
      })
      // Original version still opens and still holds the data.
      const unit2 = await reopened.kv!.open(DESCRIPTOR)
      expect((await unit2.loadAll()).tables['alpha']).toEqual({ k: { v: 1 } })
      await reopened.close()
    })

    it('rejects operations after unit close, and close is idempotent', async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await unit.close()
      await expect(unit.putRecord('alpha', 'k', {})).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.readRecord('alpha', 'k')).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.readGlobal()).rejects.toMatchObject({ code: 'closed' })
      await backend.close()
      await backend.close()
    })
  })
}
