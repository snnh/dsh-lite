/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { composeEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit, type Document } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

/** One row of a profile patch, as the patch itself addresses it. */
export interface RowConfig {
  /** The row id: the patch's addressing key. */
  readonly id: string
  /** The plugin name a row this call creates declares. */
  readonly name: string
  /**
   * The row's complete next config, or `undefined` to drop the row's own
   * config and restore the value it inherits.
   */
  readonly config: Record<string, unknown> | undefined
}

/** The profile facts a patch write needs. */
export interface ProfilePatchTarget {
  /** The profile directory holding `package.json`. */
  readonly dir: string
  /** The profile's own patch file. */
  readonly patchPath: string
}

/** The refusal every entry point states for a patch file that is not a sequence. */
const PATCH_SEQUENCE_ERROR = 'Profile patch must be a YAML sequence'

/**
 * The `!!js` scalar tag: a patch value that is a JavaScript expression
 * evaluated against the row's context rather than literal data.
 */
const JS_EXPRESSION_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/**
 * Parse a profile patch file's text into an editable document.
 *
 * The `!!js` tag is resolved to its expression source rather than evaluated, so
 * a rewrite cannot change what a row's config means; only {@link applyRowConfig}
 * decides where a row's config goes.
 * @param before - the patch file's text, or an empty sequence for an absent file.
 * @returns the parsed document, still a sequence.
 */
function parsePatchDocument(before: string): Document {
  const document = parseDocument(before, { customTags: [JS_EXPRESSION_TAG] })
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isSeq(document.contents)) throw new Error(PATCH_SEQUENCE_ERROR)
  return document
}

/**
 * Read a profile patch file's text, treating an absent file as an empty
 * sequence.
 * @param path - the patch file's absolute path.
 * @returns the file's text, or the empty sequence when there is no file.
 */
async function readPatchText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return '[]\n'
  }
}

/**
 * Write one row's config into a profile patch document.
 *
 * A row is addressed by id and plugin name, never by position, so the edit
 * lands on the row the Loader composed no matter which layer declared it or
 * what another writer appended meanwhile. A `config` that matches no row
 * appends one; `config: undefined` removes the row's own config, restoring the
 * value the row inherits, and then removes a row left carrying neither config
 * nor identity. Existing `!!js` expressions anywhere in the document survive
 * the rewrite, and unrelated rows are left untouched.
 *
 * @param document - a document from `parseDocument`, holding a YAML sequence.
 * @param row - the row to write.
 * @returns nothing; `document` is mutated in place.
 */
export function applyRowConfig(document: Document, row: RowConfig): void {
  const sequence = document.contents
  if (!isSeq(sequence)) throw new Error(PATCH_SEQUENCE_ERROR)
  sequence.flow = false
  const index = sequence.items.findLastIndex((item, index) => isMap(item)
    && document.getIn([index, 'id']) === row.id && !item.has('insert')
    && (!item.has('name') || document.getIn([index, 'name']) === row.name))
  if (row.config === undefined) {
    for (let index = sequence.items.length - 1; index >= 0; index--) {
      const candidate = sequence.items[index]
      if (!isMap(candidate) || document.getIn([index, 'id']) !== row.id || candidate.has('insert')) continue
      candidate.delete('config')
      if (candidate.items.length === Number(candidate.has('id')) + Number(candidate.has('name'))) document.delete(index)
    }
  } else if (index < 0) document.add(document.createNode({ id: row.id, name: row.name, config: row.config }))
  else document.setIn([index, 'config'], document.createNode(row.config))
  visit(document, { Map(_key, node) {
    if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
    const expression = new Scalar(node.get('__jsExpr'))
    expression.tag = 'tag:yaml.org,2002:js'
    return expression
  } })
}

/**
 * Persist one row's config into a profile's own patch file.
 *
 * The profile's patch layer is applied after every bundle layer, so a value
 * written here outlives the defaults a bundle ships and stays the one place a
 * caller reads it back from. The write is a read-render-commit cycle held under
 * the same `package.json` writer lock the configuration editor takes — two
 * writers cannot resurrect each other's state — and the file is replaced
 * atomically with owner-only permissions. Loader reconciliation belongs to the
 * caller: a plugin activating this write must not await the Loader it is part
 * of.
 *
 * @param profile - the active profile's directory and patch path.
 * @param row - the row to write.
 * @returns fulfillment after the patch file is committed.
 */
export async function writeProfileRowConfig(profile: ProfilePatchTarget, row: RowConfig): Promise<void> {
  await withFileLock(join(profile.dir, 'package.json'), async () => {
    const document = parsePatchDocument(await readPatchText(profile.patchPath))
    applyRowConfig(document, row)
    await writeFileAtomic(profile.patchPath, String(document), { mode: 0o600 })
  })
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry) || entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const inherited = this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor))
        const next = change(current, inherited)
        const fiber = entry.fiber
        if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
        const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
        resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
        const before = await readPatchText(path)
        const document = parsePatchDocument(before)
        // An edit that lands on the inherited value is the removal form: the row
        // states nothing, so it follows whatever the layers above it decide.
        applyRowConfig(document, {
          id: entry.options.id,
          name: entry.options.name,
          config: isDeepStrictEqual(next, inherited) ? undefined : next,
        })
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [entry.options.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}

export default ConfigEditor
