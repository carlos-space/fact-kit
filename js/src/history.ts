import type { FactContent, FactVariant, JsonSchema, Os, Since, Text } from './types.ts'

/** Raised by `keyed` and `history` when what the author wrote does not fit. The message names the key. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryError'
  }
}

/** Where `keyed` hides the key fields. A symbol under `Symbol.for`, so two copies of fact-kit agree. */
const KEYS = Symbol.for('fact-kit.keys')

const keysOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? ((value as unknown as Record<symbol, readonly string[] | undefined>)[KEYS] ?? undefined)
    : undefined

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)

/** JSON with sorted object keys, so equal values give equal strings. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return show(value)
}

/** The key of one item: the item itself without key fields, the field value for one, an array for several. */
function keyOf(item: unknown, keys: readonly string[], where: string): unknown {
  if (keys.length === 0) return item
  if (!isObject(item))
    throw new HistoryError(`${where}: item ${show(item)} is not an object, so it has no key ${show(keys)}`)
  const parts = keys.map((k) => {
    if (!(k in item))
      throw new HistoryError(`${where}: item ${show(item)} has no field "${k}" of the key ${show(keys)}`)
    return item[k]
  })
  return keys.length === 1 ? parts[0] : parts
}

/** Checks the key an author wrote in `remove` or `replace` against the key fields, and returns it as a lookup string. */
function lookup(spec: unknown, keys: readonly string[], where: string): string {
  if (keys.length > 1 && (!Array.isArray(spec) || spec.length !== keys.length)) {
    throw new HistoryError(
      `${where}: the key of ${show(keys)} is written as an array of ${keys.length} values in that order, got ${show(spec)}`,
    )
  }
  return canonical(spec)
}

function describeKeys(target: readonly unknown[], keys: readonly string[]): string {
  const all = target.map((item) => show(keyOf(item, keys, 'keys')))
  return all.length > 8 ? `${all.slice(0, 8).join(', ')}, ...` : all.join(', ')
}

/**
 * Declares the fields that identify an item of an array, so a later `history` row can `add`, `remove` and
 * `replace` items by key. One field is written as its value, several as an array in the declared order.
 * Without `keys` the items are scalars and identify themselves. Returns a copy of `items`.
 */
export function keyed<T>(items: readonly T[], keys: readonly string[] = []): T[] {
  if (!Array.isArray(items)) throw new HistoryError(`keyed: expected an array, got ${show(items)}`)
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || k === '')) {
    throw new HistoryError(`keyed: the keys must be a list of field names, got ${show(keys)}`)
  }
  const out = items.map(clone)
  const seen = new Map<string, unknown>()
  for (const item of out) {
    const key = keyOf(item, keys, 'keyed')
    const id = canonical(key)
    if (seen.has(id)) throw new HistoryError(`keyed: two items have the key ${show(key)}`)
    seen.set(id, item)
  }
  Object.defineProperty(out, KEYS, { value: [...keys], enumerable: false })
  return out
}

/** A deep copy that keeps the key declarations of `keyed` arrays. */
function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    const out = value.map(clone)
    const keys = keysOf(value)
    if (keys) Object.defineProperty(out, KEYS, { value: keys, enumerable: false })
    return out as T
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clone(v)
    return out as T
  }
  return value
}

// --- JSON Pointer (RFC 6901) --------------------------------------------------------------------------
function parsePointer(pointer: string, where: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) {
    throw new HistoryError(`${where}: "${pointer}" is not a JSON Pointer (it is "" or starts with "/")`)
  }
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~(?![01])/.test(token)) throw new HistoryError(`${where}: "${pointer}" has a "~" that is not "~0" or "~1"`)
      return token.replace(/~1/g, '/').replace(/~0/g, '~')
    })
}

function step(node: unknown, token: string): { found: boolean; value?: unknown } {
  if (Array.isArray(node)) {
    if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= node.length) return { found: false }
    return { found: true, value: node[Number(token)] }
  }
  if (isObject(node) && Object.hasOwn(node, token)) return { found: true, value: node[token] }
  return { found: false }
}

function resolve(root: unknown, tokens: readonly string[]): { found: boolean; value?: unknown } {
  let node = root
  for (const token of tokens) {
    const next = step(node, token)
    if (!next.found) return { found: false }
    node = next.value
  }
  return { found: true, value: node }
}

/** Writes `value` at the pointer. Only the last token may be new. Returns the new root. */
function assign(root: unknown, tokens: readonly string[], value: unknown, pointer: string, where: string): unknown {
  if (tokens.length === 0) return value
  const parent = resolve(root, tokens.slice(0, -1))
  const last = tokens[tokens.length - 1] as string
  if (!parent.found) throw new HistoryError(`${where}: "${pointer}" has no parent to put the value in`)
  const node = parent.value
  if (Array.isArray(node)) {
    const index = last === '-' ? node.length : /^(0|[1-9]\d*)$/.test(last) ? Number(last) : -1
    if (index < 0 || index > node.length) throw new HistoryError(`${where}: "${pointer}" is not an index of the array`)
    node[index] = value
  } else if (isObject(node)) {
    node[last] = value
  } else {
    throw new HistoryError(`${where}: the parent of "${pointer}" is not an object or an array`)
  }
  return root
}

// --- rows ---------------------------------------------------------------------------------------------
export interface HistoryRow {
  since: Since
  /** A full rewrite, or the first row. Exactly one of `value`, `schema` and `statement`. */
  value?: unknown
  schema?: JsonSchema
  statement?: Text
  /** Pointer to a keyed array -> the items to append. */
  add?: Record<string, readonly unknown[]>
  /** Pointer -> the new value. For a keyed array, the items to swap in by key. */
  replace?: Record<string, unknown>
  /** Pointer to a keyed array -> the keys of the items to drop. */
  remove?: Record<string, readonly unknown[]>
  /** Pointer -> the value to put there, which may be new. */
  set?: Record<string, unknown>
  pending?: string
  stability?: 'experimental'
  platforms?: string[]
  os?: Os[]
}

const CONTENT_KEYS = ['value', 'schema', 'statement'] as const
const DIFF_KEYS = ['remove', 'replace', 'add', 'set'] as const
const ROW_KEYS = new Set<string>(['since', 'pending', 'stability', 'platforms', 'os', ...CONTENT_KEYS, ...DIFF_KEYS])

function applyRow(root: unknown, row: HistoryRow, where: string): unknown {
  let current = root
  for (const [pointer, keysToDrop] of Object.entries(row.remove ?? {})) {
    const at = `${where}: remove "${pointer}"`
    const target = resolve(current, parsePointer(pointer, at))
    const keys = keysOf(target.value)
    if (!target.found || !Array.isArray(target.value)) throw new HistoryError(`${at}: there is no array there`)
    if (!keys)
      throw new HistoryError(
        `${at}: the array is not keyed, so items can not be removed by key. Declare it with keyed(items, keys), or replace the whole array`,
      )
    if (!Array.isArray(keysToDrop)) throw new HistoryError(`${at}: expected a list of keys, got ${show(keysToDrop)}`)
    for (const spec of keysToDrop) {
      const wanted = lookup(spec, keys, at)
      const index = target.value.findIndex((item) => canonical(keyOf(item, keys, at)) === wanted)
      if (index === -1) {
        throw new HistoryError(
          `${at}: no item has the key ${show(spec)} (keys there: ${describeKeys(target.value, keys)})`,
        )
      }
      target.value.splice(index, 1)
    }
  }
  for (const [pointer, next] of Object.entries(row.replace ?? {})) {
    const at = `${where}: replace "${pointer}"`
    const tokens = parsePointer(pointer, at)
    const target = resolve(current, tokens)
    if (!target.found) throw new HistoryError(`${at}: nothing is there to replace. Use set to put a new value`)
    const keys = keysOf(target.value)
    if (keys && Array.isArray(target.value) && Array.isArray(next) && !keysOf(next)) {
      for (const item of next) {
        const key = keyOf(item, keys, at)
        const wanted = canonical(key)
        const index = target.value.findIndex((old) => canonical(keyOf(old, keys, at)) === wanted)
        if (index === -1) {
          throw new HistoryError(
            `${at}: no item has the key ${show(key)} (keys there: ${describeKeys(target.value, keys)})`,
          )
        }
        target.value[index] = clone(item)
      }
    } else {
      current = assign(current, tokens, clone(next), pointer, at)
    }
  }
  for (const [pointer, items] of Object.entries(row.add ?? {})) {
    const at = `${where}: add "${pointer}"`
    const target = resolve(current, parsePointer(pointer, at))
    const keys = keysOf(target.value)
    if (!target.found || !Array.isArray(target.value)) throw new HistoryError(`${at}: there is no array there`)
    if (!keys)
      throw new HistoryError(
        `${at}: the array is not keyed, so items can not be added by key. Declare it with keyed(items, keys), or replace the whole array`,
      )
    if (!Array.isArray(items)) throw new HistoryError(`${at}: expected a list of items, got ${show(items)}`)
    for (const item of items) {
      const key = keyOf(item, keys, at)
      const wanted = canonical(key)
      if (target.value.some((old) => canonical(keyOf(old, keys, at)) === wanted)) {
        throw new HistoryError(`${at}: an item with the key ${show(key)} is already there`)
      }
      target.value.push(clone(item))
    }
  }
  for (const [pointer, next] of Object.entries(row.set ?? {})) {
    const at = `${where}: set "${pointer}"`
    current = assign(current, parsePointer(pointer, at), clone(next), pointer, at)
  }
  return current
}

/**
 * Expands the rows of a fact into `variants`. The first row gives the content (`value`, `schema` or `statement`).
 * Each later row either rewrites it whole, or changes the content of the row before it with `remove`, `replace`,
 * `add` and `set`, applied in that order. The targets are JSON Pointers into the content, `''` for the root.
 * `since`, `pending`, `stability`, `platforms` and `os` go to the variant as written.
 */
export function history(...rows: HistoryRow[]): FactVariant[] {
  if (rows.length === 0) throw new HistoryError('history: needs at least one row')
  const variants: FactVariant[] = []
  let kind: (typeof CONTENT_KEYS)[number] | undefined
  let payload: unknown
  for (const [i, row] of rows.entries()) {
    const where = `history row ${i}${isObject(row) && row.since !== undefined ? ` (since ${show(row.since)})` : ''}`
    if (!isObject(row)) throw new HistoryError(`${where}: a row is an object`)
    if (row.since === undefined) throw new HistoryError(`${where}: missing "since"`)
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.has(key)) throw new HistoryError(`${where}: unknown field "${key}"`)
    }
    const written = CONTENT_KEYS.filter((k) => Object.hasOwn(row, k))
    const diffs = DIFF_KEYS.filter((k) => row[k] !== undefined)
    if (written.length > 1)
      throw new HistoryError(`${where}: write one of value, schema and statement, not ${written.join(' and ')}`)
    if (written.length === 1 && diffs.length > 0) {
      throw new HistoryError(`${where}: a row that rewrites the content has no ${diffs.join(', ')}`)
    }
    if (i === 0 && written.length === 0) {
      throw new HistoryError(`${where}: the first row gives the content: value, schema or statement`)
    }
    if (written.length === 1) {
      kind = written[0] as (typeof CONTENT_KEYS)[number]
      payload = clone(row[kind])
    } else {
      payload = applyRow(payload, row, where)
    }
    variants.push({
      since: row.since,
      content: { [kind as string]: clone(payload) } as FactContent,
      ...(row.pending !== undefined ? { pending: row.pending } : {}),
      ...(row.stability !== undefined ? { stability: row.stability } : {}),
      ...(row.platforms !== undefined ? { platforms: row.platforms } : {}),
      ...(row.os !== undefined ? { os: row.os } : {}),
    })
  }
  return variants
}
