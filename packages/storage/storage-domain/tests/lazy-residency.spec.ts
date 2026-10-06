/**
 * Lazy residency: a `residency: 'lazy'` domain materializes no table, so its
 * open reads the global slot alone and its table handle (`LazyKvTable`) reads
 * and writes the medium directly. Every case here pairs the domain surface
 * with the unit primitives it must — or must not — produce, so "never
 * resident" stays an observable claim rather than a comment.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { defineDomain, DomainFacility, domainTable } from '../src/index.ts'
import type { DomainChanged, LazyKvTable } from '../src/index.ts'
import { backupCapableBackend, MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import type { MemoryMedium } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const lazySpec = defineDomain({
  name: 'lazydemo',
  version: 1,
  residency: 'lazy',
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const lazyBareSpec = defineDomain({
  name: 'lazybare',
  version: 1,
  residency: 'lazy',
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

const lazySalvageSpec = defineDomain({
  name: 'lazysalvage',
  version: 1,
  residency: 'lazy',
  invalidRecords: 'backup-and-skip',
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const eagerSpec = defineDomain({
  name: 'eagerdemo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

/**
 * Memory backend whose unit counts what a domain asks of it: `loadAll` and
 * `readGlobal` calls, plus every `readRecord` target. Those counts are what
 * separates an eager open (one `loadAll`) from a lazy one (no `loadAll`, one
 * `readGlobal` when the spec declares a global, nothing otherwise).
 * @param pool - Media to serve; a fresh private pool when omitted.
 * @returns the backend, its counters, and the pool it serves.
 */
function instrumentedBackend(pool: MemoryMediaPool = new MemoryMediaPool()) {
  const memory = new MemoryStorageBackend(pool)
  const calls = { loadAll: 0, readGlobal: 0, readRecord: [] as string[] }
  const backend: StorageBackend = {
    close: () => memory.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await memory.kv.open(descriptor)
        return {
          loadAll: async () => {
            calls.loadAll += 1
            return unit.loadAll()
          },
          readRecord: async (table, key) => {
            calls.readRecord.push(`${table}/${key}`)
            return unit.readRecord(table, key)
          },
          readGlobal: async () => {
            calls.readGlobal += 1
            return unit.readGlobal()
          },
          putRecord: (table, key, value) => unit.putRecord(table, key, value),
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
  }
  return { backend, calls, pool }
}

/** Write one raw record straight onto a pooled medium, bypassing every schema. */
function fabricate(pool: MemoryMediaPool, domain: string, table: string, key: string, record: unknown): void {
  const medium: MemoryMedium = pool.media.get(domain)
    ?? { tables: new Map<string, Map<string, unknown>>(), global: null }
  const records = medium.tables.get(table) ?? new Map<string, unknown>()
  records.set(key, record)
  medium.tables.set(table, records)
  pool.media.set(domain, medium)
}

/** Boot a context with the storage hub, one backend mounted as `memory`, and a facility over it. */
async function harness(backend: StorageBackend, pool?: MemoryMediaPool) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, facility, changes, pool }
}

describe('the residency spec field', () => {
  it('validates the declared value at the runtime boundary and defaults to eager', () => {
    // A spec built from config can carry any value; only the two residency
    // modes are meaningful, so anything else must fail loud at module load.
    expect(() => defineDomain({
      name: 'ok', version: 1, residency: 'quick' as 'lazy', tables: {},
    })).toThrow(/residency must be 'eager' or 'lazy'/)
    expect(defineDomain({ name: 'ok', version: 1, tables: {} })).not.toHaveProperty('residency')
    expect(defineDomain({ name: 'ok', version: 1, residency: 'eager', tables: {} }))
      .toHaveProperty('residency', 'eager')
  })
})

describe('lazy open', () => {
  it('materializes no table and reads its global slot instead', async () => {
    const { backend, calls } = instrumentedBackend()
    const { facility } = await harness(backend)
    const domain = await facility.open(lazySpec)
    expect(calls.loadAll).toBe(0)
    expect(calls.readGlobal).toBe(1)
    expect(calls.readRecord).toEqual([])
    expect(domain.global.get()).toEqual({ theme: 'plain' })
    expect(facility.get('lazydemo')).toBeDefined()
    expect(facility.get('unopened')).toBeUndefined()

    // The same instrumented unit under an eager spec still materializes: the
    // counter proves the lazy path is the one skipping `loadAll`, not the unit.
    const eager = await facility.open(eagerSpec)
    expect(calls.loadAll).toBe(1)
    expect(calls.readGlobal).toBe(1)
    expect(eager.table('items').size).toBe(0)
  })

  it('touches neither loadAll nor the global slot when the spec declares no global', async () => {
    const { backend, calls } = instrumentedBackend()
    const { facility } = await harness(backend)
    await facility.open(lazyBareSpec)
    expect(calls).toEqual({ loadAll: 0, readGlobal: 0, readRecord: [] })
  })

  it('serves a stored global read from the medium, and rejects one that fails its schema', async () => {
    const pool = new MemoryMediaPool()
    const stored = { tables: new Map<string, Map<string, unknown>>(), global: { theme: 'dark' } }
    pool.media.set('lazydemo', stored)
    const { facility } = await harness(instrumentedBackend(pool).backend)
    expect((await facility.open(lazySpec)).global.get()).toEqual({ theme: 'dark' })

    const broken = { ...stored, global: { theme: 42 } }
    pool.media.set('lazydemo', broken)
    const { facility: second } = await harness(instrumentedBackend(pool).backend)
    await expect(second.open(lazySpec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })
})

describe('lazy reads', () => {
  it('reads the medium on every call — no resident copy, absent keys as undefined', async () => {
    const { backend, calls, pool } = instrumentedBackend()
    const { facility } = await harness(backend)
    const domain = await facility.open(lazySpec)
    const table = domain.table('items')
    expect(await table.read('a')).toBeUndefined()
    await table.put('a', { label: 'x', count: 1 })
    expect(await table.read('a')).toEqual({ label: 'x', count: 1 })
    expect(await table.read('a')).toEqual({ label: 'x', count: 1 })
    // Three reads, three point reads: nothing was cached on the way through.
    expect(calls.readRecord).toEqual(['items/a', 'items/a', 'items/a'])

    // Nothing carries over in memory, so a fresh open serves the same record.
    await domain.close()
    const { facility: reopenedFacility } = await harness(instrumentedBackend(pool).backend)
    const reopened = await reopenedFacility.open(lazySpec)
    expect(await reopened.table('items').read('a')).toEqual({ label: 'x', count: 1 })
  })

  it('passes the unit answer through for an unwritten key and an undeclared table', async () => {
    // `readRecord` reports an undeclared table exactly as it reports an
    // unwritten key: absent. This unit answers absent for everything, and the
    // handle must pass that through without inventing or rejecting a record.
    const asked: string[] = []
    const backend: StorageBackend = {
      close: async () => {},
      kv: {
        open: async (): Promise<KvUnit> => ({
          loadAll: async () => ({ tables: {}, global: null }),
          readRecord: async (table, key) => {
            asked.push(`${table}/${key}`)
            return undefined
          },
          readGlobal: async () => null,
          putRecord: async () => {},
          deleteRecord: async () => {},
          setGlobal: async () => {},
          close: async () => {},
        }),
      },
    }
    const { facility } = await harness(backend)
    const table = (await facility.open(lazyBareSpec)).table('rows')
    expect(await table.read('anything')).toBeUndefined()
    expect(asked).toEqual(['rows/anything'])
  })

  it('offers no synchronous view of a table it does not hold', async () => {
    const { backend } = instrumentedBackend()
    const { facility } = await harness(backend)
    const table: LazyKvTable<string, Item> = (await facility.open(lazySpec)).table('items')
    // A synchronous read of a non-resident record could only be a lie, so the
    // lazy handle carries none of the resident surface — not even as a stub.
    // @ts-expect-error a lazy table has no synchronous get: no record is resident
    expect(table.get).toBeUndefined()
    expect(['entries', 'keys', 'size'].filter(member => member in table)).toEqual([])
  })
})

describe('lazy writes', () => {
  it('writes through to the medium and emits domain/changed in order', async () => {
    const { backend, pool } = instrumentedBackend()
    const { facility, changes } = await harness(backend)
    const domain = await facility.open(lazySpec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    expect(pool.media.get('lazydemo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    await table.update('a', current => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    expect(changes).toEqual([
      { domain: 'lazydemo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'lazydemo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'lazydemo', table: 'items', key: 'a', operation: 'deleted' },
    ])
    expect(pool.media.get('lazydemo')!.tables.get('items')!.has('a')).toBe(false)
  })

  it('decides delete existence on raw presence, so an invalid record still deletes', async () => {
    const pool = new MemoryMediaPool()
    fabricate(pool, 'lazydemo', 'items', 'bad', { label: 'x', count: 'NaN' })
    const { backend, calls } = instrumentedBackend(pool)
    const { facility, changes } = await harness(backend)
    const table = (await facility.open(lazySpec)).table('items')
    // Deleting is not reading: the record exists on the medium, so it goes.
    await expect(table.delete('bad')).resolves.toBe(true)
    expect(calls.readRecord).toEqual(['items/bad'])
    expect(changes).toEqual([{ domain: 'lazydemo', table: 'items', key: 'bad', operation: 'deleted' }])
    expect(pool.media.get('lazydemo')!.tables.get('items')!.has('bad')).toBe(false)
  })

  it('serializes concurrent updates on one key without losing increments', async () => {
    const { backend } = instrumentedBackend()
    const { facility } = await harness(backend)
    const table = (await facility.open(lazySpec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    // Each update re-reads at its own chain slot, so no increment is lost
    // even though every read is a durable one.
    await Promise.all(Array.from({ length: 25 }, () =>
      table.update('counter', current => ({ ...current, count: current.count + 1 }))))
    expect(await table.read('counter')).toEqual({ label: 'c', count: 25 })
  })

  it('rejects update on a missing key with missing-key', async () => {
    const { backend } = instrumentedBackend()
    const { facility } = await harness(backend)
    const table = (await facility.open(lazySpec)).table('items')
    await expect(table.update('ghost', value => value)).rejects.toMatchObject({ code: 'missing-key' })
    await expect(table.update('ghost', value => value))
      .rejects.toThrow("domain 'lazydemo' table 'items' has no record 'ghost' to update")
  })

  it('leaves the medium untouched and emits nothing when the backend rejects a write', async () => {
    const { backend, pool } = instrumentedBackend()
    const { facility, changes } = await harness(backend)
    const table = (await facility.open(lazySpec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    const seen = changes.length

    pool.failNextWrites = 3
    await expect(table.put('a', { label: 'x', count: 99 })).rejects.toThrow(/injected/)
    await expect(table.update('a', current => ({ ...current, count: current.count + 1 }))).rejects.toThrow(/injected/)
    await expect(table.delete('a')).rejects.toThrow(/injected/)

    expect(await table.read('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(seen)

    // The chain survives rejections: the next write lands cleanly.
    await table.update('a', current => ({ ...current, count: current.count + 1 }))
    expect(await table.read('a')).toEqual({ label: 'x', count: 2 })
  })
})

describe('lazy record validation', () => {
  it('rejects a stored record that fails its schema at read time, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    fabricate(pool, 'lazydemo', 'items', 'bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness(instrumentedBackend(pool).backend)
    // The open is clean: nothing is validated until a read meets the record.
    const table = (await facility.open(lazySpec)).table('items')
    await expect(table.read('bad')).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
    await expect(table.read('bad')).rejects
      .toThrow("domain 'lazydemo': stored record 'bad' in table 'items' does not match its schema")
    // The rejection is the record's, not the table's: healthy neighbours read.
    await table.put('good', { label: 'x', count: 1 })
    expect(await table.read('good')).toEqual({ label: 'x', count: 1 })
  })

  it('keeps the rejecting default under backup-and-skip when the unit cannot move documents', async () => {
    const pool = new MemoryMediaPool()
    fabricate(pool, 'lazysalvage', 'items', 'bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness(instrumentedBackend(pool).backend)
    const table = (await facility.open(lazySalvageSpec)).table('items')
    await expect(table.read('bad')).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('backs a bad record up and reads it as absent under backup-and-skip', async () => {
    const record = { label: 'x', count: 'NaN' }
    const pool = new MemoryMediaPool()
    fabricate(pool, 'lazysalvage', 'items', 'bad', record)
    const { backend, moved } = backupCapableBackend(pool)
    const { ctx, facility, changes } = await harness(backend)
    const errors = vi.spyOn(ctx.logger, 'error')
    const table = (await facility.open(lazySalvageSpec)).table('items')

    await expect(table.read('bad')).resolves.toBeUndefined()
    expect(moved).toEqual([['items', 'bad']])
    // Same wording family as the eager open, naming what moved where.
    expect(errors).toHaveBeenCalledWith(
      "domain 'lazysalvage': stored record 'bad' in table 'items' failed schema validation; "
      + `moved to 'backup/items/bad.json' and treated as absent. Cause: ${String(itemSchema.safeParse(record).error)}`,
    )
    // Moving a document aside is not a domain write: no change event.
    expect(changes).toEqual([])

    // The document is really gone from the medium, and a write recreates it.
    expect(pool.media.get('lazysalvage')!.tables.get('items')!.has('bad')).toBe(false)
    await table.put('bad', { label: 'x', count: 1 })
    expect(await table.read('bad')).toEqual({ label: 'x', count: 1 })
  })
})

describe('lazy close', () => {
  it('drains queued writes, then rejects further reads and writes', async () => {
    const { backend, pool } = instrumentedBackend()
    const { facility } = await harness(backend)
    const domain = await facility.open(lazySpec)
    const table = domain.table('items')
    const pending = table.put('a', { label: 'x', count: 1 })
    await domain.close()
    await pending
    expect(pool.media.get('lazydemo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    await expect(table.read('a')).rejects.toMatchObject({ code: 'closed' })
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'closed' })
  })
})
