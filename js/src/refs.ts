import type { RefDecl } from './author.ts'
import { canonical, pairRows } from './select.ts'
import type { PairedRows } from './select.ts'
import { byLabel, conditions } from './subset.ts'
import type { Fact, FactContent, FactIndex, Problem } from './types.ts'

/** The `ref`s a source writes, with the index they were built into. */
export interface RefInput {
  index: unknown
  refs?: readonly RefDecl[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `$ref` a property can follow to the `$defs` of the same document, a few steps at most. */
function resolveLocal(node: unknown, root: Record<string, unknown>): unknown {
  let current = node
  for (let step = 0; step < 8 && isRecord(current) && typeof current.$ref === 'string'; step++) {
    const m = /^#\/\$defs\/([^/]+)$/.exec(current.$ref)
    const next = m && isRecord(root.$defs) ? root.$defs[m[1] as string] : undefined
    if (next === undefined) return current
    current = next
  }
  return current
}

/**
 * Why `field` (dotted) is not in a schema, or undefined when it is. A schema is walked through `properties`, and
 * a property that is a `$ref` into the `$defs` of the same schema is followed.
 */
function schemaFieldProblem(schema: unknown, field: string): string | undefined {
  if (!isRecord(schema)) return 'it has no schema to read'
  const parts = field.split('.')
  let node: unknown = schema
  for (const [i, part] of parts.entries()) {
    node = resolveLocal(node, schema)
    const properties = isRecord(node) ? node.properties : undefined
    if (isRecord(properties) && Object.hasOwn(properties, part)) {
      node = properties[part]
      continue
    }
    const rest = parts.slice(i).join('.')
    if (isRecord(properties) && Object.hasOwn(properties, rest)) {
      return `"${rest}" is a field name with a dot, and a name with a dot can not be referenced`
    }
    return i === 0 ? `it has no field "${part}"` : `"${parts.slice(0, i).join('.')}" has no field "${part}"`
  }
  return undefined
}

/** Why `field` (dotted) is not in a value, or undefined when it is. A value is walked through its object keys. */
function valueFieldProblem(value: unknown, field: string): string | undefined {
  const parts = field.split('.')
  let node: unknown = value
  for (const [i, part] of parts.entries()) {
    if (isRecord(node) && Object.hasOwn(node, part)) {
      node = node[part]
      continue
    }
    const rest = parts.slice(i).join('.')
    if (isRecord(node) && Object.hasOwn(node, rest)) {
      return `"${rest}" is a field name with a dot, and a name with a dot can not be referenced`
    }
    return i === 0 ? `it has no field "${part}"` : `"${parts.slice(0, i).join('.')}" has no field "${part}"`
  }
  return undefined
}

const kindOf = (content: FactContent): 'schema' | 'value' | 'statement' | undefined =>
  (['schema', 'value', 'statement'] as const).find((k) => isRecord(content) && Object.hasOwn(content, k))

/**
 * Tests every `ref` against the facts it points at, at every version boundary of the two facts. Where a reader
 * gets a row of the fact that writes the `ref`, it must also get a row of the target that has the field, and for a
 * `$ref` the schema in `$defs` must be the schema that reader gets from the target. Each problem is reported once,
 * at the oldest version where it happens.
 */
export function refProblems(inputs: readonly RefInput[]): Problem[] {
  const problems: Problem[] = []
  const bySpec = new Map<string, Map<string, Fact>>()
  const factsOf = (input: RefInput) => {
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
    for (const decl of input.refs ?? []) {
      const colon = decl.target.lastIndexOf(':')
      const target =
        colon === -1 ? own.get(decl.target) : bySpec.get(decl.target.slice(0, colon))?.get(decl.target.slice(colon + 1))
      const writer = own.get(decl.id)
      // A missing fact is reported as `unknown-fact-id`, and an entry that was not loaded can not be checked.
      if (!writer || !target) continue
      const name = decl.field === undefined ? target.id : `${target.id}, "${decl.field}"`
      const found = new Map<string, { what: string; at: Map<string, string> }>()
      const report = (what: string, paired: PairedRows) => {
        const entry = found.get(what) ?? { what, at: new Map() }
        if (!entry.at.has(paired.version)) entry.at.set(paired.version, conditions(paired))
        found.set(what, entry)
      }
      for (const paired of pairRows(writer, target)) {
        if (!paired.a) continue
        if (decl.rows && !decl.rows.includes(paired.a.index)) continue
        if (!paired.b) {
          report(`no row of ${target.id} applies, so ref(${name}) points at nothing`, paired)
          continue
        }
        const kind = kindOf(paired.b.content)
        const content = paired.b.content as Record<string, unknown>
        if (decl.asSchema && kind !== 'schema') {
          report(`ref(${name}) is a $ref, and ${target.id} is not a schema but ${kind ?? 'unreadable'}`, paired)
          continue
        }
        if (decl.field !== undefined) {
          const why =
            kind === 'statement'
              ? `${target.id} is a statement, which has no fields`
              : kind === 'schema'
                ? schemaFieldProblem(content.schema, decl.field)
                : kind === 'value'
                  ? valueFieldProblem(content.value, decl.field)
                  : 'it has no content to read'
          if (why !== undefined) {
            report(`ref(${name}) points at nothing: ${why}`, paired)
            continue
          }
        }
        if (decl.asSchema && Array.isArray(target.variants) && target.variants.length > 1) {
          // What the build embedded is the schema of one row of the target, so a reader of another row gets the wrong one.
          const mine = (writer.variants ?? [{ content: writer.content }])[paired.a.index]?.content
          const embedded = isRecord((mine as Record<string, unknown> | undefined)?.schema)
            ? ((mine as { schema: Record<string, unknown> }).schema.$defs as Record<string, unknown> | undefined)?.[
                target.id
              ]
            : undefined
          const { $defs: _own, ...theirs } = (content.schema ?? {}) as Record<string, unknown>
          if (embedded !== undefined && canonical(embedded) !== canonical(theirs)) {
            report(
              `the schema of ${target.id} in $defs is not the schema this reader gets from ${target.id}, because the rows of the two facts are not aligned`,
              paired,
            )
          }
        }
      }
      for (const { what, at } of found.values()) {
        const labels = [...at.keys()].sort(byLabel)
        const first = labels[0] as string
        const more =
          labels.length > 1 ? `, and at ${labels.length - 1} other reader${labels.length > 2 ? 's' : ''}` : ''
        problems.push({
          code: 'ref',
          message: `${decl.id}: at ${first}${at.get(first)}${more}, ${what}`,
          location: decl.location,
        })
      }
    }
  }
  return problems
}
