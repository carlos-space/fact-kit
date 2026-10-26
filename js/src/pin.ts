import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { InputError } from './load.ts'
import { loadOxc } from './oxc.ts'
import { readConfig } from './project.ts'
import { applyEdits, findRows } from './rows.ts'
import type { Edit } from './rows.ts'
import { CODE, lineOf, walk } from './rules.ts'
import { parseVersion } from './version.ts'

export interface PinOptions {
  /** The version `next` becomes. Semver 2.0.0; a pre-release such as `0.49.0-alpha.1` is pinned whole. */
  version: string
  /** Component package directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Config file path. Defaults to `fact-kit.config.json` in `cwd` when it exists. */
  configFile?: string
  /** Fact sources, relative to `cwd`. Defaults to the config, then `facts`. */
  factsDir?: string
}

export interface PinResult {
  /** Files that changed, relative to `cwd`, with the number of `next` that became the version. */
  changed: { file: string; pinned: number }[]
  /** Rows left as they are because a spread or computed key may hide a `pending` label. */
  skipped: string[]
}

/**
 * Pins every `next` in the `since` of the rows under the facts directory to `options.version`: a `since` that is
 * `'next'`, or an array that ends in `'next'`. A row with a `pending` label stays. Only the text of the literal is
 * replaced, so nothing else in the file moves. `<factsDir>/_lib` is not read, `describes` is not touched, and a
 * second run finds nothing to change. Nothing is written unless every file could be read and parsed.
 */
export async function pinVersion(options: PinOptions): Promise<PinResult> {
  if (!parseVersion(options.version)) {
    throw new InputError(`--version expects a semver 2.0.0 version such as 0.49.0, got "${options.version}"`)
  }
  const cwd = resolve(options.cwd ?? process.cwd())
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new InputError(`${cwd} is not a directory`)
  }
  const oxc = await loadOxc()
  const config = await readConfig(cwd, options.configFile)
  const factsDir = join(cwd, options.factsDir ?? config.factsDir ?? 'facts')
  const libDir = join(factsDir, '_lib')
  const files = (await walk(factsDir, CODE)).filter((f) => f !== libDir && !f.startsWith(libDir + sep))

  const plans: { file: string; source: string; text: string; pinned: number }[] = []
  const skipped: string[] = []
  for (const file of files) {
    const rel = relative(cwd, file).split(sep).join('/')
    const source = await readFile(file, 'utf8')
    const parsed = oxc.parseSync(file, source)
    if (parsed.errors.length > 0) {
      throw new InputError(`${rel}: cannot parse: ${(parsed.errors[0] as { message: string }).message}`)
    }
    const edits: Edit[] = []
    for (const row of findRows(parsed.program)) {
      if (!row.since) continue
      const last = row.since.kind === 'string' ? row.since.item : row.since.items[row.since.items.length - 1]
      if (last?.text !== 'next') continue
      if (row.pending === 'unknown') {
        skipped.push(`${rel}:${lineOf(source, row.start)} a spread or computed key may hide "pending", row left as is`)
        continue
      }
      if (row.pending === 'set') continue
      edits.push({ start: last.start + 1, end: last.end - 1, text: options.version })
    }
    if (edits.length > 0) plans.push({ file, source, text: applyEdits(source, edits), pinned: edits.length })
  }
  for (const plan of plans) await writeFile(plan.file, plan.text)
  return {
    changed: plans.map((p) => ({ file: relative(cwd, p.file).split(sep).join('/'), pinned: p.pinned })),
    skipped,
  }
}
