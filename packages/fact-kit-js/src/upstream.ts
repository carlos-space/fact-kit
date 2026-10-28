import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LoadError } from './load.ts'
import { installedVersion, splitSpec } from './read.ts'
import type { Fact, Problem } from './types.ts'

type Derived = { id: string; from: string; version: string; pointer: string }

function derivedFacts(index: unknown): Derived[] {
  const facts = (index as { facts?: unknown } | null)?.facts
  if (!Array.isArray(facts)) return []
  const out: Derived[] = []
  for (const [i, raw] of facts.entries()) {
    const fact = raw as Partial<Fact> | null
    const source = fact?.source
    if (source?.kind === 'derived' && typeof fact?.id === 'string') {
      out.push({ id: fact.id, from: source.from, version: source.version, pointer: `/facts/${i}/source` })
    }
  }
  return out
}

/**
 * The facts of a built index that were derived from a package whose installed version is not the one they
 * record. `root` is where the upstream packages are installed from.
 */
export function installedVersionProblems(index: unknown, root: string, file: string): Problem[] {
  const problems: Problem[] = []
  for (const d of derivedFacts(index)) {
    let packageName: string
    try {
      packageName = splitSpec(d.from).packageName
    } catch {
      continue
    }
    const installed = installedVersion(root, packageName)
    if (installed === d.version) continue
    problems.push({
      code: 'derive-version',
      message:
        installed === undefined
          ? `${d.id}: derived from ${d.from} ${d.version}, but ${packageName} is not installed`
          : `${d.id}: derived from ${d.from} ${d.version}, but ${installed} is installed`,
      location: `${file}#${d.pointer}`,
    })
  }
  return problems
}

/** The file, next to package.json, that records which upstream version each derived source was built from. */
export const LOCK_FILE = 'derived.lock.json'

/** Upstream spec -> version, for every derived fact in the indexes. */
export function derivedSources(indexes: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const index of indexes) for (const d of derivedFacts(index)) out.set(d.from, d.version)
  return out
}

/** Reads `derived.lock.json`: undefined when there is none. */
export async function readLock(cwd: string): Promise<Record<string, string> | undefined> {
  const file = join(cwd, LOCK_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new LoadError(file, `cannot read ${LOCK_FILE}: ${(error as Error).message}`)
  }
  try {
    const lock = JSON.parse(text) as unknown
    if (typeof lock !== 'object' || lock === null || Object.values(lock).some((v) => typeof v !== 'string')) {
      throw new Error('expected an object of spec -> version')
    }
    return lock as Record<string, string>
  } catch (error) {
    throw new LoadError(file, `cannot read ${LOCK_FILE}: ${(error as Error).message}`)
  }
}

/** The text of the lock file for these sources, in spec order. */
export function lockText(sources: ReadonlyMap<string, string>): string {
  const sorted = Object.fromEntries([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/**
 * The sources whose installed version is not the one the lock records. Rebuilding is blocked until someone has
 * looked at what changed upstream. A source the lock does not know yet is not a problem, the build adds it.
 */
export function lockProblems(
  lock: Record<string, string> | undefined,
  sources: ReadonlyMap<string, string>,
): Problem[] {
  const problems: Problem[] = []
  for (const [spec, installed] of sources) {
    const recorded = lock?.[spec]
    if (recorded === undefined || recorded === installed) continue
    problems.push({
      code: 'derive-version',
      message: `facts are derived from ${spec} ${recorded} (${LOCK_FILE}), but ${installed} is installed. Look at what changed upstream, then build with --accept-upstream`,
      location: LOCK_FILE,
    })
  }
  return problems
}
