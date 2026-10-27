import { canonical, pairRows } from './select.ts'
import type { PairedRows } from './select.ts'
import type { Fact, FactContent, FactIndex, Problem } from './types.ts'
import { compareSemver, parseVersion } from './version.ts'

/** A list that `subsetOf` keeps inside the list of another fact, as `resolveEntries` reports it. */
export interface SubsetInput {
  /** The id of the subset fact, in the index it is declared for. */
  id: string
  /** The location of the parent: `<id>` in the same entry, `<spec>:<id>` in another. */
  parent: string
  /** Where the subset fact is declared. */
  location: string
}

export interface SubsetIndex {
  index: unknown
  subsets?: readonly SubsetInput[]
}

const listOf = (content: FactContent | undefined): readonly unknown[] | undefined => {
  const value = (content as { value?: unknown } | undefined)?.value
  return Array.isArray(value) ? value : undefined
}

/** Orders the labels of readers: versions from the oldest, then `latest`, then `head`. */
function byLabel(a: string, b: string): number {
  const rank = (label: string) => (label === 'head' ? 2 : label === 'latest' ? 1 : 0)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  const va = parseVersion(a)
  const vb = parseVersion(b)
  return va && vb ? compareSemver(va, vb) : a < b ? -1 : a > b ? 1 : 0
}

function conditions(p: PairedRows): string {
  const parts = [
    p.platform !== undefined ? (p.platform === 'other' ? 'a platform no row names' : `platform ${p.platform}`) : '',
    p.os !== undefined ? (p.os === 'other' ? 'an os no row names' : `os ${p.os}`) : '',
    ...p.include.map((l) => `pending ${l}`),
  ].filter(Boolean)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/**
 * Tests every list that `subsetOf` declared against the list of its parent, at every version boundary of the two
 * facts. A reader for which the subset has a row but the parent has none, a list that is not a list, and an item
 * the parent does not have are each reported once, at the oldest boundary where they happen.
 */
export function subsetProblems(inputs: readonly SubsetIndex[]): Problem[] {
  const problems: Problem[] = []
  const bySpec = new Map<string, Map<string, Fact>>()
  const factsOf = (input: SubsetIndex) => {
    const index = input.index as Partial<FactIndex> | null
    return new Map((Array.isArray(index?.facts) ? index.facts : []).map((f) => [f?.id, f] as [string, Fact]))
  }
  for (const input of inputs) {
    const index = input.index as Partial<FactIndex> | null
    if (typeof index?.package === 'string' && typeof index.entry === 'string')
      bySpec.set(`${index.package}/${index.entry}`, factsOf(input))
  }
  for (const input of inputs) {
    const own = factsOf(input)
    for (const subset of input.subsets ?? []) {
      const colon = subset.parent.lastIndexOf(':')
      const parent =
        colon === -1
          ? own.get(subset.parent)
          : bySpec.get(subset.parent.slice(0, colon))?.get(subset.parent.slice(colon + 1))
      const child = own.get(subset.id)
      // A missing fact is reported as `unknown-fact-id`, and an entry that was not loaded can not be checked.
      if (!child || !parent) continue
      // One problem is reported once, at the oldest version where it happens and under the plainest conditions.
      const found = new Map<string, { what: string; at: Map<string, string> }>()
      const report = (what: string, paired: PairedRows) => {
        const entry = found.get(what) ?? { what, at: new Map() }
        if (!entry.at.has(paired.version)) entry.at.set(paired.version, conditions(paired))
        found.set(what, entry)
      }
      for (const paired of pairRows(child, parent)) {
        if (!paired.a) continue
        const mine = listOf(paired.a.content)
        const theirs = paired.b ? listOf(paired.b.content) : undefined
        if (!paired.b) report(`no row of ${subset.parent} applies, so nothing in ${subset.id} can be in it`, paired)
        else if (!mine) report(`${subset.id} is not a list`, paired)
        else if (!theirs) report(`${subset.parent} is not a list`, paired)
        else {
          const allowed = new Set(theirs.map(canonical))
          for (const item of mine) {
            if (!allowed.has(canonical(item))) report(`${JSON.stringify(item)} is not in ${subset.parent}`, paired)
          }
        }
      }
      for (const { what, at } of found.values()) {
        const labels = [...at.keys()].sort(byLabel)
        const first = labels[0] as string
        const more =
          labels.length > 1 ? `, and at ${labels.length - 1} other reader${labels.length > 2 ? 's' : ''}` : ''
        problems.push({
          code: 'subset-of',
          message: `${subset.id}: at ${first}${at.get(first)}${more}, ${what}`,
          location: subset.location,
        })
      }
    }
  }
  return problems
}
