import { conditions } from './subset.ts'
import { subschemas } from './schema-walk.ts'
import { compareSemver, parseVersion } from './version.ts'
import { factRows, pickRows } from './select.ts'
import type { Row } from './select.ts'
import type { Fact, Since } from './types.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A schema root of one row of the fact that writes `ref`s, with the facts it embeds. */
export interface AlignSlot {
  /** The row of the writer, as `check` counts rows. */
  row: number
  /** The `$defs` the author wrote in this schema, before the build added the embedded schemas. */
  authored: Record<string, unknown>
  /** The facts the schema embeds, resolved, in the order of the `$defs`. */
  targets: Fact[]
}

export interface AlignInput {
  /** The id of the fact that writes the `ref`s. */
  id: string
  /** The fact with the `$defs` of the latest published rows of the targets. */
  fact: Record<string, unknown>
  slots: readonly AlignSlot[]
  /** The `$defs` for a copy of the schema of `slot`, with the row `picks[i]` of `slot.targets[i]` (`undefined`: the latest). */
  defs(slot: AlignSlot, picks: readonly (number | undefined)[]): Record<string, unknown>
  say(message: string): void
}

export interface Aligned {
  fact: Record<string, unknown>
  /** For each row of the fact as it was, the rows it became. */
  rows: Map<number, number[]>
}

/** The rows of a fact as the build holds it: the `variants`, or the whole fact as one row. */
function writerRows(fact: Record<string, unknown>): Row[] {
  if (Array.isArray(fact.variants)) return fact.variants as Row[]
  const when = (fact.when ?? {}) as { since?: Since; platforms?: string[]; os?: string[] }
  return [
    {
      since: when.since,
      content: fact.content as Row['content'],
      ...(when.platforms ? { platforms: when.platforms } : {}),
      ...(when.os ? { os: when.os } : {}),
    },
  ]
}

/** The `since` of a row that applies exactly where all of `parts` apply, or undefined when it can not be written. */
export function combineSince(parts: readonly (Since | undefined)[]): { since: Since | undefined } | undefined {
  const given = parts.filter((p): p is Since => p !== undefined)
  if (given.length === 0) return { since: undefined }
  if (given.length === 1) return { since: given[0] as Since }
  if (!given.every((p) => typeof p === 'string')) return undefined
  const list = given as string[]
  if (list.includes('next')) return { since: 'next' }
  const versions = list.map(parseVersion)
  if (versions.some((v) => !v)) return undefined
  let best = 0
  for (const [i, v] of versions.entries()) if (compareSemver(v!, versions[best]!) > 0) best = i
  return { since: list[best] as string }
}

const sortKey = (since: Since | undefined) => {
  if (since === undefined) return -1
  const list = Array.isArray(since) ? since : [since]
  if (list.includes('next')) return Number.POSITIVE_INFINITY
  const v = list.map(parseVersion).filter((x) => x !== undefined)
  return v.length === 0 ? 0 : Math.max(...v.map((x) => x.major * 1e12 + x.minor * 1e6 + x.patch))
}

const intersect = (lists: readonly (readonly string[] | undefined)[]): string[] | undefined => {
  const given = lists.filter((l): l is readonly string[] => l !== undefined)
  if (given.length === 0) return undefined
  return (given[0] as readonly string[]).filter((x) => given.every((l) => l.includes(x)))
}

/**
 * Gives the fact one row for each combination of rows that some reader gets, when a schema it embeds comes from a
 * fact with several rows. A row of the fact that embeds schemas is replaced by one row for each combination of its
 * own row and the rows of the targets that readers get together, and each has the `$defs` of that combination.
 * Returns undefined when nothing changes, or when the rows can not be written (the reason goes to `say`).
 */
export function alignFact(input: AlignInput): Aligned | undefined {
  const { id, fact, say } = input
  const active = input.slots.filter((s) => s.targets.some((t) => factRows(t).length > 1))
  if (active.length === 0) return undefined
  const byRow = new Map(active.map((s) => [s.row, s]))
  const targets = [...new Set(active.flatMap((s) => s.targets))]
  const names = targets.map((t) => t.id).join(', ')
  const rows = writerRows(fact)

  // Which rows of the targets each reader gets together with a row of the writer that embeds schemas.
  const groups = new Map<number, Map<string, (number | undefined)[]>>()
  for (const r of pickRows([{ ...fact, id } as unknown as Fact, ...targets])) {
    const own = r.picks[0]
    const slot = own ? byRow.get(own.index) : undefined
    if (!own || !slot) continue
    const picks = slot.targets.map((t) => r.picks[1 + targets.indexOf(t)]?.index)
    const forRow = groups.get(own.index) ?? new Map()
    forRow.set(picks.join(','), picks)
    groups.set(own.index, forRow)
  }
  if (groups.size === 0) return undefined

  const made: { row: Row; slot: AlignSlot; picks: (number | undefined)[] }[][] = []
  for (const [i, old] of rows.entries()) {
    const slot = byRow.get(i)
    const forRow = groups.get(i)
    if (!slot || !forRow) {
      made.push([{ row: old, slot: undefined as unknown as AlignSlot, picks: [] }])
      continue
    }
    const out: (typeof made)[number] = []
    for (const picks of forRow.values()) {
      const parts: Row[] = [
        old,
        ...picks.flatMap((p, k) => (p === undefined ? [] : [factRows(slot.targets[k] as Fact)[p] as Row])),
      ]
      const combined = combineSince(parts.map((p) => p.since))
      const pending = [...new Set(parts.flatMap((p) => (p.pending !== undefined ? [p.pending] : [])))]
      if (!combined || pending.length > 1) {
        say(
          `${id}: the rows of ${names} can not be aligned with the rows of ${id}, because ${
            combined
              ? `the rows are pending for ${pending.join(' and ')}`
              : 'the `since` of the rows can not be combined into one'
          }`,
        )
        return undefined
      }
      const { content: _c, since: _s, platforms: _p, os: _o, pending: _pe, ...rest } = old
      const platforms = intersect(parts.map((p) => p.platforms))
      const os = intersect(parts.map((p) => p.os))
      const content = structuredClone(old.content) as Record<string, unknown>
      const schema = content.schema as Record<string, unknown>
      schema.$defs = input.defs(slot, picks)
      out.push({
        row: {
          ...(combined.since !== undefined ? { since: combined.since } : {}),
          content,
          ...(pending[0] !== undefined ? { pending: pending[0] } : {}),
          ...rest,
          ...(platforms ? { platforms } : {}),
          ...(os ? { os } : {}),
        } as Row,
        slot,
        picks,
      })
    }
    out.sort((a, b) => sortKey(a.row.since) - sortKey(b.row.since))
    made.push(out)
  }

  const variants: Row[] = []
  const meta = new Map<number, { slot: AlignSlot; picks: (number | undefined)[] }>()
  const map = new Map<number, number[]>()
  for (const [i, list] of made.entries()) {
    map.set(i, [])
    for (const m of list) {
      map.get(i)?.push(variants.length)
      if (m.slot) meta.set(variants.length, { slot: m.slot, picks: m.picks })
      variants.push(m.row)
    }
  }

  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fact)) {
    if (key === 'variants') next.variants = variants
    else if (key === 'content' && !Array.isArray(fact.variants)) next.variants = variants
    else if (key === 'when' && !Array.isArray(fact.variants)) {
      const { since: _s, platforms: _p, os: _o, ...others } = value as Record<string, unknown>
      if (Object.keys(others).length > 0) next.when = others
    } else next[key] = value
  }

  // Test again what every reader gets from the new rows, against what it gets from the targets.
  const bad = new Map<string, string>()
  for (const r of pickRows([{ ...next, id } as unknown as Fact, ...targets])) {
    const own = r.picks[0]
    const m = own ? meta.get(own.index) : undefined
    if (!m) continue
    for (const [k, t] of m.slot.targets.entries()) {
      if (r.picks[1 + targets.indexOf(t)]?.index !== m.picks[k]) {
        if (!bad.has(r.version)) bad.set(r.version, `${r.version}${conditions({ ...r, a: undefined, b: undefined })}`)
      }
    }
  }
  if (bad.size > 0) {
    const [first, ...more] = [...bad.values()]
    say(
      `${id}: at ${first}${more.length > 0 ? `, and at ${more.length} other reader${more.length > 1 ? 's' : ''}` : ''}, the rows of ${names} can not be aligned with the rows of ${id}: the row of ${id} that reader gets does not carry the schema that reader gets from ${names}`,
    )
    return undefined
  }
  return { fact: next, rows: map }
}

const POINTS_INTO_ROOT = /^#(\/(?!\$defs(\/|$)).*)?$/

/**
 * Makes the `$ref`s that point into the root of `part` point into the place it is embedded at, `#/$defs/<id>`.
 * `#` and `#/properties/x` become `#/$defs/<id>` and `#/$defs/<id>/properties/x`. A pointer into `#/$defs/...` and a
 * plain-name anchor (`#name`) stay, because the `$defs` and the anchors move with the schema. A `$ref` that is not
 * `#`-relative stays. A `part` with an `$id` is a root of its own wherever it goes, so it stays as a whole.
 * Returns why the rest can not be rewritten, and then changes nothing: a `$dynamicRef` or `$recursiveRef`, which
 * depend on the schema they are read in, and a pointer inside a subschema with an `$id`, which is not clearly a
 * pointer into `part`.
 */
export function rewriteRootRefs(part: unknown, id: string): string | undefined {
  if (!isRecord(part) || typeof part.$id === 'string') return undefined
  const subs = [...subschemas(part)]
  const ids = subs.filter((s) => s.pointer !== '' && typeof s.schema.$id === 'string').map((s) => s.pointer)
  const edits: (() => void)[] = []
  for (const { schema: sub, pointer } of subs) {
    for (const keyword of ['$dynamicRef', '$recursiveRef']) {
      if (typeof sub[keyword] === 'string') {
        return `${id} has a ${keyword}, which depends on the schema it is read in and can not be moved into another schema`
      }
    }
    const ref = sub.$ref
    if (typeof ref !== 'string' || !POINTS_INTO_ROOT.test(ref)) continue
    if (ids.some((at) => pointer === at || pointer.startsWith(`${at}/`))) {
      return `${id} has a $ref "${ref}" in a subschema with an $id, so it is not clear whether it points into ${id} or into that subschema, and it can not be rewritten`
    }
    edits.push(() => {
      sub.$ref = `#/$defs/${id}${ref.slice(1)}`
    })
  }
  for (const edit of edits) edit()
  return undefined
}
