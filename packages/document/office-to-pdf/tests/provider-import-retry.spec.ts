import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Converter, ConverterOptions } from '@deepseek-ai/libreoffice-kit'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import OfficeToPdf, { type OfficeToPdfRequest, OfficeSourceKey } from '../src/index.ts'

const kit = vi.hoisted(() => ({
  create: vi.fn<(options?: ConverterOptions) => Promise<Converter>>(),
  failures: 0,
}))
vi.mock('@deepseek-ai/libreoffice-kit', () => {
  if (kit.failures > 0) {
    kit.failures -= 1
    throw new Error('kit module failed to evaluate')
  }
  return { createConverter: kit.create }
})

const pdf = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')
const input = new Uint8Array([80, 75, 3, 4])
const request: OfficeToPdfRequest = { extension: 'docx', priority: 'foreground', source: {
  key: OfficeSourceKey('source'), version: 'v1', bytes: input.length,
  read: async () => ({ bytes: input, version: 'v1' }),
} }
let ctx: Context

beforeEach(() => {
  ctx = new Context()
  kit.create.mockReset().mockImplementation(async () => ({
    backend: 'native',
    render: vi.fn<Converter['render']>().mockImplementation(async ({ outputPath }) => {
      await writeFile(outputPath, pdf)
      return { backend: 'native', missingFonts: ['Missing Serif'] }
    }),
    dispose: vi.fn<Converter['dispose']>().mockResolvedValue(undefined),
    renderImages: vi.fn<Converter['renderImages']>().mockRejectedValue(new Error('Unexpected Converter.renderImages call')),
    convert: vi.fn<Converter['convert']>().mockRejectedValue(new Error('Unexpected Converter.convert call')),
    recalculate: vi.fn<Converter['recalculate']>().mockRejectedValue(new Error('Unexpected Converter.recalculate call')),
  }))
})
afterEach(async () => { await ctx.fiber.dispose() })

it('retries the kit import after a rejected module load instead of failing every slot forever', async () => {
  await ctx.plugin(OfficeToPdf, {})
  const provider = ctx.officeToPdf
  kit.failures = 1
  const rejection = await provider.convert(request).then(
    () => { throw new Error('expected the conversion to reject') },
    (error: unknown) => error,
  )
  expect(rejection).toMatchObject({ code: 'failed' })
  // The mocked-module rejection arrives wrapped by the test module registry;
  // walk the cause chain for the original evaluation failure.
  let cause = (rejection as { cause?: unknown }).cause
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause
  expect(cause).toMatchObject({ message: 'kit module failed to evaluate' })
  expect(await provider.convert(request)).toMatchObject({ pdf: Uint8Array.from(pdf), missingFonts: ['Missing Serif'] })
  expect(kit.create).toHaveBeenCalledOnce()
})
