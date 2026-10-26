import { readFile } from 'node:fs/promises'
import type { JsonSchema } from './types.ts'

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

/**
 * String literal tuples declared in TypeScript source, by name. Reads
 * `export declare const X: readonly ['a', 'b']` (a `.d.ts`) and `export const X = ['a', 'b'] as const`.
 * Only the syntax is parsed, so imports do not have to resolve. Constants of any other shape are skipped.
 */
export async function readStringTuples(source: string): Promise<Record<string, string[]>> {
  const { default: ts } = await import('typescript5')
  const file = ts.createSourceFile('input.d.ts', source, ts.ScriptTarget.Latest, true)
  const out: Record<string, string[]> = {}

  const literals = (node: import('typescript5').TypeNode | import('typescript5').Expression): string[] | undefined => {
    const values: string[] = []
    let elements: readonly import('typescript5').Node[] | undefined
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return literals(node.type)
    if (ts.isTupleTypeNode(node)) elements = node.elements
    else if (ts.isAsExpression(node)) return literals(node.expression)
    else if (ts.isArrayLiteralExpression(node)) elements = node.elements
    if (!elements) return undefined
    for (const el of elements) {
      if (ts.isLiteralTypeNode(el) && ts.isStringLiteral(el.literal)) values.push(el.literal.text)
      else if (ts.isStringLiteral(el)) values.push(el.text)
      else return undefined
    }
    return values
  }

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const node = decl.type ?? decl.initializer
      const values = node ? literals(node) : undefined
      if (values) out[decl.name.text] = values
    }
  }
  return out
}

/** Reads a `.d.ts` (or `.ts`) file and returns {@link readStringTuples} of it. */
export async function readStringTuplesFromFile(path: string): Promise<Record<string, string[]>> {
  return readStringTuples(await readFile(path, 'utf8'))
}

export interface InterfaceToSchemaOptions {
  /** Path of the `.d.ts` or `.ts` file declaring the type. */
  path: string
  /** Name of the interface or type alias to convert. */
  type: string
  /** tsconfig for resolving imports. Without it the file is read with default options. */
  tsconfig?: string
  /** Whether objects accept unlisted properties. Defaults to false, the generator's own default. */
  additionalProperties?: boolean
  /** Whether JSDoc comments are kept as `description`. Defaults to true. False leaves names, types and enum values only. */
  descriptions?: boolean
}

// Keywords whose value is a map of name -> subschema. The names in it are not keywords, so a property named `description` stays.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas'])
// Keywords whose value is data, not a schema.
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples'])

/** Removes every `description` keyword at any depth, including inside `$defs`, and turns a `deprecated` message into `true`. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description' && typeof v === 'string') continue
    if (key === 'deprecated' && typeof v === 'string')
      out[key] = true // the JSDoc message is prose too
    else if (DATA_KEYWORDS.has(key)) out[key] = v
    else if (SCHEMA_MAPS.has(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, stripDescriptions(sub)]),
      )
    } else out[key] = stripDescriptions(v)
  }
  return out
}

/** Moves a draft-07 document produced by the generator to 2020-12: `definitions` becomes `$defs`. */
function toDraft2020(schema: Record<string, unknown>): Record<string, unknown> {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k === 'definitions' ? '$defs' : k,
          k === '$ref' && typeof v === 'string' ? v.replace('#/definitions/', '#/$defs/') : rewrite(v),
        ]),
      )
    }
    return value
  }
  const { $schema: _draft, ...rest } = rewrite(schema) as Record<string, unknown>
  const defs = rest.$defs as Record<string, unknown> | undefined
  if (defs && Object.keys(defs).length === 0) delete rest.$defs
  return { $schema: DRAFT_2020_12, ...rest }
}

/**
 * Converts an interface or type alias to a JSON Schema 2020-12 document, through the maintained
 * `ts-json-schema-generator`. JSDoc comments become `description`, unless `descriptions` is false, which
 * removes every `description` and leaves names, types and enum values. Type errors in the input are not
 * reported, because a `.d.ts` of a package often imports files that are not installed.
 */
export async function interfaceToJsonSchema(options: InterfaceToSchemaOptions): Promise<JsonSchema> {
  const { createGenerator } = await import('ts-json-schema-generator')
  const generator = createGenerator({
    path: options.path,
    type: options.type,
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
    skipTypeCheck: true,
    jsDoc: 'extended',
    topRef: false,
    additionalProperties: options.additionalProperties ?? false,
  })
  const schema = toDraft2020(generator.createSchema(options.type) as unknown as Record<string, unknown>)
  return options.descriptions === false ? (stripDescriptions(schema) as JsonSchema) : schema
}

/** Reads a JSON Schema file. */
export async function readJsonSchemaFile(path: string): Promise<JsonSchema> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'boolean' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(`${path} is not a JSON Schema document`)
  }
  return parsed as JsonSchema
}
