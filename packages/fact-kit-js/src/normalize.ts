// Normalizes JSON Schema documents from other sources to the 2020-12 dialect that facts use.
import { DRAFT_2020_12 } from './convert.ts'
import { X_KEYWORDS } from './meta-schema.ts'
import type { JsonSchema } from './types.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

// Keywords whose value is a map of name -> subschema, a single subschema, or a list of subschemas.
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SCHEMA_SINGLE = [
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems']

export interface NormalizeOptions {
  /** Called for each `description`; return the text to keep. */
  describe?: (text: string) => string
  /** Keywords to drop at any depth, besides unregistered `x-` ones (which are always dropped). */
  drop?: readonly string[]
  /** Records what was dropped or rewritten, for the converter's report. */
  notes?: Map<string, number>
}

/** Rewrites a `#/definitions/` pointer to `#/$defs/`. */
const fixRef = (ref: string): string => ref.replace(/^#\/definitions\//, '#/$defs/')

/**
 * Applies the rules below to one schema and everything under it. Keywords are only touched where a
 * schema is expected, so a property that happens to be named `items` or `deprecated` is left alone.
 * - `definitions` becomes `$defs`, and `#/definitions/` references follow.
 * - A tuple `items: [...]` becomes `prefixItems`, with `additionalItems` becoming `items`.
 * - A string `deprecated` (a JSDoc message) becomes `true`, and the message is appended to `description`.
 * - `nullable: true` becomes a `null` member of `type`.
 * - `dependencies` splits into `dependentRequired` and `dependentSchemas`.
 * - `x-` keywords that fact-kit does not register, `$id`, `id` and the keywords in `drop` are removed.
 */
export function normalizeSchema(input: JsonSchema, options: NormalizeOptions = {}): JsonSchema {
  const note = (key: string) => options.notes?.set(key, (options.notes.get(key) ?? 0) + 1)
  const drop = new Set(options.drop ?? [])

  const visit = (value: unknown): unknown => {
    if (!isObj(value)) return value
    const out: Obj = {}
    for (const [key, v] of Object.entries(value)) {
      if (drop.has(key)) {
        note(`dropped ${key}`)
        continue
      }
      if (key.startsWith('x-') && !(key in X_KEYWORDS)) {
        note(`dropped ${key}`)
        continue
      }
      if (key === '$id' || key === 'id') {
        note('dropped $id')
        continue
      }
      if (key === '$ref' && typeof v === 'string') out.$ref = fixRef(v)
      else if (key === 'definitions') out.$defs = mapOf(v)
      else if (SCHEMA_MAPS.includes(key)) out[key] = mapOf(v)
      else if (key === 'items' && Array.isArray(v)) {
        note('tuple items -> prefixItems')
        out.prefixItems = v.map(visit)
      } else if (key === 'additionalItems') {
        out.items = visit(v)
      } else if (SCHEMA_SINGLE.includes(key)) out[key] = visit(v)
      else if (SCHEMA_LISTS.includes(key) && Array.isArray(v)) out[key] = v.map(visit)
      else if (key === 'dependencies' && isObj(v)) {
        for (const [name, dep] of Object.entries(v)) {
          if (Array.isArray(dep)) ((out.dependentRequired ??= {}) as Obj)[name] = dep
          else ((out.dependentSchemas ??= {}) as Obj)[name] = visit(dep)
        }
      } else if (key === 'description' && typeof v === 'string')
        out.description = options.describe ? options.describe(v) : v
      else out[key] = v
    }
    if (typeof out.deprecated === 'string') {
      note('deprecated message -> true')
      const message = out.deprecated
      out.deprecated = true
      const base = typeof out.description === 'string' ? `${out.description}\n\n` : ''
      out.description = `${base}Deprecated: ${message}`
    }
    if (out.nullable === true) {
      note('nullable -> type null')
      const type = out.type
      out.type = Array.isArray(type) ? [...type, 'null'] : type !== undefined ? [type, 'null'] : undefined
      if (out.type === undefined) delete out.type
    }
    delete out.nullable
    return out
  }
  const mapOf = (v: unknown): unknown =>
    isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)])) : v

  const result = visit(input)
  if (!isObj(result)) return result as JsonSchema
  const { $schema: _old, ...rest } = result
  return { $schema: DRAFT_2020_12, ...rest }
}
