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

/**
 * The facts of a new build that were derived from another version of their upstream package than the last
 * build recorded. Rebuilding is blocked until someone has looked at what changed upstream.
 */
export function staleDerivedProblems(previous: unknown, next: unknown, file: string): Problem[] {
  const before = new Map(derivedFacts(previous).map((d) => [d.id, d]))
  const problems: Problem[] = []
  for (const d of derivedFacts(next)) {
    const old = before.get(d.id)
    if (!old || old.from !== d.from || old.version === d.version) continue
    problems.push({
      code: 'derive-version',
      message: `${d.id}: the last build derived it from ${d.from} ${old.version}, but ${d.version} is installed now. Look at what changed upstream, then build again with --accept-upstream (or delete the old build)`,
      location: file,
    })
  }
  return problems
}
