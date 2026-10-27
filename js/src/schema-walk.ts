// Where a JSON Schema 2020-12 keeps subschemas, shared by the build (which turns `ref` into `$ref`) and `check`.

/** Keywords whose value is an object of subschemas, by name. */
export const SUB_MAP: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas'])
/** Keywords whose value is one subschema. */
export const SUB_ONE: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
])
/** Keywords whose value is a list of subschemas. */
export const SUB_LIST: ReadonlySet<string> = new Set(['prefixItems', 'allOf', 'anyOf', 'oneOf'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `schema` and every subschema inside it that is an object, each with its JSON pointer under `pointer`. */
export function* subschemas(
  schema: unknown,
  pointer = '',
): Generator<{ schema: Record<string, unknown>; pointer: string }> {
  if (!isRecord(schema)) return
  yield { schema, pointer }
  for (const [key, value] of Object.entries(schema)) {
    if (SUB_MAP.has(key) && isRecord(value)) {
      for (const [name, sub] of Object.entries(value)) {
        yield* subschemas(sub, `${pointer}/${key}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`)
      }
    } else if (SUB_ONE.has(key)) {
      yield* subschemas(value, `${pointer}/${key}`)
    } else if (SUB_LIST.has(key) && Array.isArray(value)) {
      for (const [i, sub] of value.entries()) yield* subschemas(sub, `${pointer}/${key}/${i}`)
    }
  }
}
