import type { JsonSchema } from './types.ts'

export interface SchemaRow {
  /** Field path: `a.b` for a property, `a[]` for array items, `a.*` for additional properties. */
  path: string
  /** `string`, `string | number`, `array`, `enum`, `const` and so on. Empty when the schema says nothing. */
  type: string
  required: boolean
  description: string
  /** Allowed values when the schema lists them with `enum` or `const`. */
  values?: unknown[]
  /** The `x-` keywords of the field, with their values. */
  extensions: Record<string, unknown>
  /**
   * Set when the field comes from `anyOf` / `oneOf` branches told apart by a `const` property and only some
   * branches require it: the field is required when that property (`path`) takes one of `values`.
   */
  requiredWhen?: { path: string; values: unknown[] }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

function resolveRef(root: Obj, ref: string): Obj | undefined {
  if (!ref.startsWith('#')) return undefined
  let node: unknown = root
  for (const part of ref.slice(1).split('/').filter(Boolean)) {
    node = isObj(node) ? node[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
  }
  return isObj(node) ? node : undefined
}

/** Merges `allOf` branches and a local `$ref` into the schema itself. Cycles are cut by `seen`. */
function resolve(
  root: Obj,
  schema: Obj,
  seen: ReadonlySet<string>,
): { schema: Obj; seen: ReadonlySet<string> } | undefined {
  let current = schema
  let visited = seen
  for (let guard = 0; guard < 50; guard++) {
    const ref = current.$ref
    if (typeof ref !== 'string') break
    if (visited.has(ref)) return undefined
    const target = resolveRef(root, ref)
    if (!target) break
    visited = new Set([...visited, ref])
    const { $ref: _ref, ...own } = current
    current = { ...target, ...own }
  }
  if (Array.isArray(current.allOf)) {
    const { allOf, ...rest } = current
    let merged: Obj = rest
    for (const part of allOf as unknown[]) {
      if (!isObj(part)) continue
      const r = resolve(root, part, visited)
      if (!r) continue
      const props = {
        ...(isObj(merged.properties) ? merged.properties : {}),
        ...(isObj(r.schema.properties) ? r.schema.properties : {}),
      }
      const required = [...new Set([...asStrings(r.schema.required), ...asStrings(merged.required)])]
      merged = {
        ...r.schema,
        ...merged,
        ...(Object.keys(props).length ? { properties: props } : {}),
        ...(required.length ? { required } : {}),
      }
    }
    current = merged
  }
  return { schema: current, seen: visited }
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function typeOf(s: Obj): string {
  const t = s.type
  const base = Array.isArray(t) ? t.join(' | ') : typeof t === 'string' ? t : ''
  if (base) return base
  if ('const' in s) return 'const'
  if (Array.isArray(s.enum)) return 'enum'
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key]
    if (Array.isArray(branches)) {
      const names = branches.map((b) =>
        isObj(b) ? typeOf(b) || (typeof b.$ref === 'string' ? (b.$ref.split('/').pop() ?? '') : '') : '',
      )
      if (names.every(Boolean)) return [...new Set(names)].join(' | ')
    }
  }
  return ''
}

function describeRow(path: string, s: Obj, required: boolean): SchemaRow {
  const values = Array.isArray(s.enum) ? s.enum : 'const' in s ? [s.const] : undefined
  return {
    path,
    type: typeOf(s),
    required,
    description: typeof s.description === 'string' ? s.description : '',
    ...(values ? { values } : {}),
    extensions: Object.fromEntries(Object.entries(s).filter(([k]) => k.startsWith('x-'))),
  }
}

const valuesOf = (s: Obj): unknown[] | undefined =>
  Array.isArray(s.enum) ? s.enum : 'const' in s ? [s.const] : undefined

/** A property that is a required `const` in every branch, which is what tells the branches apart. */
function discriminatorOf(branches: readonly Obj[]): string | undefined {
  const [first, ...rest] = branches
  if (!first || rest.length === 0 || !isObj(first.properties)) return undefined
  return Object.keys(first.properties).find((name) =>
    branches.every((b) => {
      const p = isObj(b.properties) ? b.properties[name] : undefined
      return isObj(p) && 'const' in p && asStrings(b.required).includes(name)
    }),
  )
}

/**
 * Flattens a JSON Schema into table rows, one per field, depth first. Local `$ref`s and `allOf` are
 * resolved and recursive references stop at the first repeat. The fields of `anyOf` / `oneOf` object
 * branches are merged by name: the allowed values are the union over the branches, the field is required
 * when every branch requires it, and a field only some branches require gets `requiredWhen` when the
 * branches are told apart by a `const` property. The root itself gets no row.
 */
export function flattenSchema(schema: JsonSchema): SchemaRow[] {
  if (!isObj(schema)) return []
  const rows: SchemaRow[] = []

  const visit = (raw: Obj, path: string, required: boolean, seen: ReadonlySet<string>, isRoot: boolean): void => {
    const resolved = resolve(schema, raw, seen)
    if (!resolved) {
      if (!isRoot) rows.push(describeRow(path, raw, required))
      return
    }
    const s = resolved.schema
    if (!isRoot) rows.push(describeRow(path, s, required))
    const join = (name: string) => (path ? `${path}.${name}` : name)

    const props = isObj(s.properties) ? s.properties : {}
    const req = new Set(asStrings(s.required))
    for (const [name, child] of Object.entries(props)) {
      if (isObj(child)) visit(child, join(name), req.has(name), resolved.seen, false)
    }
    if (isObj(s.additionalProperties)) visit(s.additionalProperties, join('*'), false, resolved.seen, false)
    if (isObj(s.items)) visit(s.items, `${path}[]`, false, resolved.seen, false)
    for (const key of ['anyOf', 'oneOf'] as const) {
      const raw = s[key]
      if (!Array.isArray(raw)) continue
      const branches = raw.flatMap((b) => {
        const r = isObj(b) ? resolve(schema, b, resolved.seen) : undefined
        return r && isObj(r.schema.properties) ? [r] : []
      })
      const propsOf = (b: (typeof branches)[number]) => b.schema.properties as Obj
      const discriminator = discriminatorOf(branches.map((b) => b.schema))
      const names = [...new Set(branches.flatMap((b) => Object.keys(propsOf(b))))]
      for (const name of names) {
        if (rows.some((row) => row.path === join(name))) continue
        const holders = branches.filter((b) => isObj(propsOf(b)[name]))
        const first = holders[0]
        if (!first) continue
        const requiring = branches.filter((b) => asStrings(b.schema.required).includes(name))
        const at = rows.length
        visit(propsOf(first)[name] as Obj, join(name), requiring.length === branches.length, first.seen, false)
        const row = rows[at]
        if (!row) continue
        const childValues = holders.map((b) => {
          const child = propsOf(b)[name] as Obj
          return valuesOf(resolve(schema, child, b.seen)?.schema ?? child)
        })
        let merged: SchemaRow = row
        if (holders.length > 1 && childValues.every(Boolean)) {
          const values = [...new Set(childValues.flat())]
          merged = { ...merged, type: values.length > 1 ? 'enum' : merged.type, values }
        }
        if (discriminator && name !== discriminator && requiring.length > 0 && requiring.length < branches.length) {
          const values = requiring.map((b) => (propsOf(b)[discriminator] as Obj).const)
          merged = { ...merged, requiredWhen: { path: join(discriminator), values } }
        }
        rows[at] = merged
      }
    }
  }

  visit(schema, '', false, new Set(), true)
  return rows
}

/** Renders rows as a Markdown table (path, type, required, description, `x-` keywords). */
export function schemaRowsToMarkdown(rows: readonly SchemaRow[]): string {
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines = ['| Field | Type | Required | Description | Extensions |', '| :--- | :--- | :--- | :--- | :--- |']
  for (const r of rows) {
    const ext = Object.entries(r.extensions)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(', ')
    const values = r.values ? ` (${r.values.map((v) => JSON.stringify(v)).join(', ')})` : ''
    const required = r.required
      ? 'yes'
      : r.requiredWhen
        ? `when \`${r.requiredWhen.path}\` is ${r.requiredWhen.values.map((v) => JSON.stringify(v)).join(' or ')}`
        : 'no'
    lines.push(
      `| \`${cell(r.path)}\` | ${cell(r.type)}${cell(values)} | ${cell(required)} | ${cell(r.description)} | ${cell(ext)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}
