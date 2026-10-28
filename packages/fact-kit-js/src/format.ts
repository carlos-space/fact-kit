import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadPeer } from './peer.ts'

/** The part of `prettier` that `writeFormatted` uses. */
interface PrettierModule {
  resolveConfig(file: string): Promise<Record<string, unknown> | null>
  format(text: string, options: Record<string, unknown>): Promise<string>
}

/**
 * Writes `text` formatted with the repository's prettier settings, so reruns give identical files. Needs the
 * optional peer dependency `prettier`, which is loaded when the function runs.
 */
export async function writeFormatted(file: string, text: string): Promise<void> {
  const { format, resolveConfig } = await loadPeer<PrettierModule>('prettier', 'prettier', 'writeFormatted')
  const config = (await resolveConfig(file)) ?? {}
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, await format(text, { ...config, filepath: file }))
}

/** JSON with object keys in a stable order, for generated files. Arrays keep their order. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value), null, 2)
}
