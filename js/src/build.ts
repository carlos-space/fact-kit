import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { aggregateExports, planAggregate, writeAggregate } from './aggregate.ts'
import { checkFacts } from './check.ts'
import type { IndexInput } from './check.ts'
import { loadEntries, readPackageName } from './load.ts'
import type { LoadedEntry } from './load.ts'
import { readConfig } from './project.ts'
import { topLevelContent } from './select.ts'
import type { Fact, FactIndex, Problem } from './types.ts'
import { LOCK_FILE, derivedSources, lockProblems, lockText, readLock } from './upstream.ts'

export interface BuildOptions {
  /** Package directory, holding package.json. Defaults to `process.cwd()`. */
  cwd?: string
  /** Source directory, relative to `cwd`. Defaults to `facts`. */
  factsDir?: string
  /** Output directory, relative to `cwd`. Defaults to `dist`. */
  outDir?: string
  /** Add the `exports` entries that are missing from package.json. Otherwise missing entries are only reported. */
  writeExports?: boolean
  /**
   * Build facts derived from another upstream version than `derived.lock.json` records, and rewrite the lock.
   * Without it the build fails and says what version changed.
   */
  acceptUpstream?: boolean
}

export interface BuildResult {
  /** The problems that stopped the build. Empty when files were written. */
  problems: Problem[]
  /** Entries written, in order. */
  entries: string[]
  /** Files written, relative to `cwd`. */
  files: string[]
  /** `exports` keys package.json lacks (or, with `writeExports`, the keys that were added). */
  missingExports: string[]
  exportsUpdated: boolean
}

/** The index format this version writes. Readers also take 1.0, which has no `indexFormat`. */
export const INDEX_FORMAT = '1.1'

/**
 * A fact as it goes into the index. A fact with `variants` gets the top-level `content` that a reader of format
 * 1.0 uses: the latest published row, else the row on `head`, else the row with the largest bound.
 */
function indexFact(fact: Fact): Fact {
  if (!Array.isArray(fact.variants) || fact.variants.length === 0) return fact
  try {
    const top = topLevelContent(fact)
    return top ? { ...fact, content: top.content } : fact
  } catch {
    // A `since` that is not a version. `check` reports it, and the build stops on it.
    return fact
  }
}

/** The index of one entry, with the top-level fields in the order of the format. */
export function buildIndex(packageName: string, loaded: LoadedEntry): FactIndex {
  const { module } = loaded
  return {
    indexFormat: INDEX_FORMAT,
    package: packageName,
    entry: loaded.entry,
    ...(module.formatVersion !== undefined ? { formatVersion: module.formatVersion } : {}),
    describes: module.describes,
    facts: module.facts.map(indexFact),
  }
}

/** The `exports` map package.json should have for the given entries. */
export function expectedExports(entries: readonly LoadedEntry[], outDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) {
    out[`./${e.entry}/index.json`] = `./${outDir}/${e.entry}/index.json`
    if (e.schemas.length > 0) out[`./${e.entry}/schemas/*`] = `./${outDir}/${e.entry}/schemas/*`
  }
  return out
}

/** Whether `exports` already maps `key` to `target`, directly or through a `*` pattern key. */
export function exportsCover(exports: Record<string, unknown> | undefined, key: string, target: string): boolean {
  if (!exports) return false
  for (const [k, v] of Object.entries(exports)) {
    if (typeof v !== 'string') continue
    if (k === key && v === target) return true
    const star = k.indexOf('*')
    if (star === -1 || k.indexOf('*', star + 1) !== -1) continue
    const prefix = k.slice(0, star)
    const suffix = k.slice(star + 1)
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      const matched = key.slice(prefix.length, key.length - suffix.length)
      if (v.replace('*', matched) === target) return true
    }
  }
  return false
}

/**
 * Builds `facts/<entry>/index.ts` into `<outDir>/<entry>/index.json` and copies `facts/<entry>/schemas/`.
 * Nothing is written when the facts do not pass the format check (path and domain scanning is left to
 * `check`, which runs before publishing).
 */
export async function buildFacts(options: BuildOptions = {}): Promise<BuildResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const factsDir = options.factsDir ?? 'facts'
  const outDir = options.outDir ?? 'dist'
  const result: BuildResult = { problems: [], entries: [], files: [], missingExports: [], exportsUpdated: false }

  const { aggregate } = await readConfig(cwd)
  if (aggregate) return buildAggregate(cwd, aggregate, outDir, options.writeExports)

  const packageName = await readPackageName(cwd)
  const loaded = await loadEntries(join(cwd, factsDir), { cwd, packageName })
  const indexes: IndexInput[] = loaded.map((e) => ({
    origin: `${factsDir}/${e.entry}/index.ts`,
    index: buildIndex(packageName, e),
    schemas: e.schemas,
  }))
  result.problems = [
    ...loaded.flatMap((e) => e.problems.map((p) => ({ ...p }))),
    ...checkFacts({ indexes, scan: false, strict: false }).problems,
  ]
  const sources = derivedSources(indexes.map((i) => i.index))
  const lock = await readLock(cwd)
  if (!options.acceptUpstream) result.problems.push(...lockProblems(lock, sources))
  if (result.problems.length > 0) return result

  for (const [i, e] of loaded.entries()) {
    const base = join(cwd, outDir, e.entry)
    await rm(base, { recursive: true, force: true })
    await mkdir(base, { recursive: true })
    const indexFile = join(base, 'index.json')
    await writeFile(indexFile, `${JSON.stringify(indexes[i]?.index, null, 2)}\n`)
    result.files.push(`${outDir}/${e.entry}/index.json`)
    for (const s of e.schemas) {
      const target = join(base, 'schemas', s.file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(s.schema, null, 2)}\n`)
      result.files.push(`${outDir}/${e.entry}/schemas/${s.file}`)
    }
    result.entries.push(e.entry)
  }

  // The lock records the upstream versions this build used, and goes into version control.
  if (sources.size > 0) {
    const text = lockText(sources)
    if (!existsSync(join(cwd, LOCK_FILE)) || (await readFile(join(cwd, LOCK_FILE), 'utf8')) !== text) {
      await writeFile(join(cwd, LOCK_FILE), text)
      result.files.push(LOCK_FILE)
    }
  }

  await syncExports(cwd, expectedExports(loaded, outDir), options.writeExports, result)
  return result
}

/** Reports (or with `writeExports`, adds) the `exports` keys package.json lacks. */
async function syncExports(
  cwd: string,
  wanted: Record<string, string>,
  writeExports: boolean | undefined,
  result: BuildResult,
): Promise<void> {
  const pkgFile = join(cwd, 'package.json')
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as { exports?: Record<string, unknown> }
  const missing = Object.entries(wanted).filter(([key, target]) => !exportsCover(pkg.exports, key, target))
  result.missingExports = missing.map(([key]) => key)
  if (writeExports && missing.length > 0) {
    pkg.exports = { ...(pkg.exports ?? {}), ...Object.fromEntries(missing) }
    await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
    result.exportsUpdated = true
  }
}

/**
 * Builds an aggregate package: copies the built indexes of its component packages into `<outDir>`, as
 * `fact-kit.config.json` `aggregate` says, and writes them with the published `package`, `entry` and `component`.
 */
async function buildAggregate(
  cwd: string,
  aggregate: Record<string, string>,
  outDir: string,
  writeExports: boolean | undefined,
): Promise<BuildResult> {
  const result: BuildResult = { problems: [], entries: [], files: [], missingExports: [], exportsUpdated: false }
  const plan = await planAggregate(cwd, await readPackageName(cwd), aggregate, outDir)
  result.problems = plan.problems
  if (result.problems.length > 0) return result
  const written = await writeAggregate(cwd, outDir, plan)
  result.problems = written.problems
  if (result.problems.length > 0) return result
  result.files = written.files
  result.entries = plan.placed.map((p) => p.dir || '.')
  await syncExports(cwd, aggregateExports(plan.placed, outDir), writeExports, result)
  return result
}
