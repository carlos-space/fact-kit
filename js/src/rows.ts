import { nameOf } from './rules.ts'
import type { Node } from './rules.ts'

/**
 * Finds the rows (objects with a `since`) in the program of a source file. `pin` and `merge-since` read them and
 * change only the text of the `since` value, so a row carries the position of that value.
 */

/** Keys whose value is fact content or a change to it. An object there is data, not a row, even if it has a `since`. */
const DATA_KEYS = new Set(['content', 'value', 'schema', 'statement', 'add', 'replace', 'remove', 'set'])

/** One string in a `since`, with the position of the text between its quotes. */
export interface SinceItem {
  text: string
  /** Offsets (UTF-16, as in the source string) of the whole literal, quotes included. */
  start: number
  end: number
  /** The quote character: `'`, `"` or a backtick. */
  quote: string
}

export interface SinceRow {
  /** The nearest enclosing object with a string `id`, or `''` outside any fact. */
  factId: string
  /** Offset of the row object, for line numbers. */
  start: number
  end: number
  /** The `since` value is a single string, or an array of strings. Undefined for any other expression. */
  since?: { kind: 'string'; item: SinceItem } | { kind: 'array'; items: SinceItem[]; start: number; end: number }
  /**
   * `set` when the row has a `pending` label. `unknown` when a spread or a computed key could hide one. Such a
   * row is not part of the next release (or may not be), so no command here changes it.
   */
  pending: 'none' | 'set' | 'unknown'
}

function stringItem(node: unknown): SinceItem | undefined {
  const n = node as Node | null
  if (!n) return undefined
  if (n.type === 'Literal' && typeof n.value === 'string') {
    return { text: n.value, start: n.start, end: n.end, quote: (n.raw as string | undefined)?.[0] ?? "'" }
  }
  if (n.type === 'TemplateLiteral') {
    const quasis = n.quasis as { value: { cooked?: string } }[]
    if ((n.expressions as unknown[]).length === 0 && quasis[0]?.value.cooked !== undefined) {
      return { text: quasis[0].value.cooked, start: n.start, end: n.end, quote: '`' }
    }
  }
  return undefined
}

function sinceOf(value: unknown): SinceRow['since'] {
  const n = value as Node
  const single = stringItem(n)
  if (single) return { kind: 'string', item: single }
  if (n.type === 'ArrayExpression') {
    const items: SinceItem[] = []
    for (const element of n.elements as unknown[]) {
      const item = stringItem(element)
      if (!item) return undefined
      items.push(item)
    }
    return { kind: 'array', items, start: n.start, end: n.end }
  }
  return undefined
}

function rowOf(object: Node, factId: string): SinceRow | undefined {
  let sinceValue: unknown
  let found = false
  let pending: SinceRow['pending'] = 'none'
  for (const p of object.properties as Node[]) {
    if (p.type !== 'Property') {
      if (pending !== 'set') pending = 'unknown' // a spread
      continue
    }
    const computed = p.computed === true
    const name = computed ? undefined : nameOf(p.key)
    if (computed || name === undefined) {
      pending = pending === 'set' ? 'set' : 'unknown'
      continue
    }
    if (name === 'since') {
      found = true
      sinceValue = p.value
    } else if (name === 'pending') {
      const v = p.value as Node
      const absent = v.type === 'Identifier' && v.name === 'undefined' && p.shorthand !== true
      if (!absent) pending = 'set'
    }
  }
  if (!found) return undefined
  const since = sinceOf(sinceValue)
  return { factId, start: object.start, end: object.end, pending, ...(since ? { since } : {}) }
}

function idOf(object: Node): string | undefined {
  for (const p of object.properties as Node[]) {
    if (p.type === 'Property' && p.computed !== true && nameOf(p.key) === 'id') {
      const item = stringItem(p.value)
      if (item) return item.text
    }
  }
  return undefined
}

/** Every row in the program, in source order. Fact content is not searched. */
export function findRows(program: unknown): SinceRow[] {
  const rows: SinceRow[] = []
  const visit = (node: unknown, factId: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, factId)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const n = node as Node
    if (n.type === 'ObjectExpression') {
      const id = idOf(n) ?? factId
      const row = rowOf(n, id)
      if (row) rows.push(row)
      for (const p of n.properties as Node[]) {
        if (p.type === 'Property') {
          if (p.computed !== true && DATA_KEYS.has(nameOf(p.key) ?? '')) continue
          visit(p.value, id)
        } else visit(p, id)
      }
      return
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'type' && typeof value === 'object') visit(value, factId)
    }
  }
  visit(program, '')
  return rows
}

/** A text change at `[start, end)` of the source. */
export interface Edit {
  start: number
  end: number
  text: string
}

/** Applies edits that do not overlap, from the last to the first, so the offsets stay right. */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = source
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
