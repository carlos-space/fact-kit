import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fact } from './types.ts'

export interface IndexDiff {
  /** Ids only in the new index. */
  added: string[]
  /** Ids only in the old index. */
  removed: string[]
  /** Ids in both whose fact differs in any field. */
  changed: string[]
}

/** JSON with object keys sorted, so key order never counts as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Compares two lists of facts by id. Each list is sorted by id in the result. */
export function diffFacts(oldFacts: readonly Fact[], newFacts: readonly Fact[]): IndexDiff {
  const before = new Map(oldFacts.map((f) => [f.id, canonical(f)]))
  const after = new Map(newFacts.map((f) => [f.id, canonical(f)]))
  const sort = (ids: string[]) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    added: sort([...after.keys()].filter((id) => !before.has(id))),
    removed: sort([...before.keys()].filter((id) => !after.has(id))),
    changed: sort([...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id))),
  }
}

/** Compares two parsed `index.json` values. */
export function diffIndexes(oldIndex: { facts: readonly Fact[] }, newIndex: { facts: readonly Fact[] }): IndexDiff {
  return diffFacts(oldIndex.facts, newIndex.facts)
}

/** Reads two index.json files (or directories holding one) and compares them. */
export async function diffIndexFiles(oldPath: string, newPath: string): Promise<IndexDiff> {
  const load = async (path: string) => {
    const file = (await stat(path)).isDirectory() ? join(path, 'index.json') : path
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { facts?: Fact[] }
    if (!Array.isArray(parsed.facts)) throw new Error(`${file} is not a fact index`)
    return { facts: parsed.facts }
  }
  return diffIndexes(await load(oldPath), await load(newPath))
}
