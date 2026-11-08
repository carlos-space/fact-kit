import AjvModule from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import {
  EXAMPLE_GROUP_SCHEMA_ID,
  FACT_SCHEMA_ID,
  INDEX_SCHEMA_ID,
  SCHEMA_DIALECT_ID,
  exampleGroupSchema,
  factSchema,
  indexSchema,
  schemaDialect,
} from './meta-schema.ts'

// ajv ships CommonJS with a `default` export; under nodenext the default import is the module object.
const Ajv2020 = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as unknown as typeof AjvModule.default

let ajv: InstanceType<typeof Ajv2020> | undefined

function getAjv() {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false })
    ajv.addSchema(schemaDialect)
    ajv.addSchema(factSchema)
    ajv.addSchema(indexSchema)
    ajv.addSchema(exampleGroupSchema)
  }
  return ajv
}

export interface ValidationIssue {
  /** JSON pointer into the validated value, '' for the root. */
  pointer: string
  message: string
}

export function describe(e: ErrorObject): string {
  const params = e.params as Record<string, unknown>
  switch (e.keyword) {
    case 'required':
      return `missing required property "${String(params.missingProperty)}"`
    case 'additionalProperties':
      return `unknown property "${String(params.additionalProperty)}"`
    case 'enum':
      return `${e.message ?? 'invalid'} (${JSON.stringify(params.allowedValues)})`
    default:
      return e.message ?? 'invalid'
  }
}

/** Turns ajv errors into short lines. Unknown `x-` keywords are named, and the noise around them is dropped. */
export function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const list = errors ?? []
  for (const e of list) {
    if (e.keyword === 'propertyNames') {
      const name = String((e.params as Record<string, unknown>).propertyName)
      issues.push({
        pointer: e.instancePath,
        message: `unknown x- keyword "${name}" (registered: ${Object.keys(schemaDialect.properties).join(', ')})`,
      })
    }
  }
  const unknownKeywordAt = new Set(issues.map((i) => i.pointer))
  for (const e of list) {
    if (e.keyword === 'propertyNames') continue
    // The if/then/enum errors that ajv emits next to a failed propertyNames check.
    if (e.schemaPath.includes('/propertyNames/') || (e.keyword === 'if' && unknownKeywordAt.has(e.instancePath)))
      continue
    // An `if` that failed only repeats the error of its `then`.
    if (e.keyword === 'if') continue
    issues.push({ pointer: e.instancePath, message: describe(e) })
  }
  // The same pointer and message can come from several branches.
  const seen = new Set<string>()
  return issues.filter((i) => {
    const key = `${i.pointer}\0${i.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function run(id: string, value: unknown): ValidationIssue[] {
  const validate = getAjv().getSchema(id)
  if (!validate) throw new Error(`fact-kit: meta-schema ${id} is not registered`)
  return validate(value) ? [] : toIssues(validate.errors)
}

/** Validates one fact against the fact meta-schema. */
export const validateFact = (fact: unknown): ValidationIssue[] => run(FACT_SCHEMA_ID, fact)

/** Validates a whole `index.json`. */
export const validateIndex = (index: unknown): ValidationIssue[] => run(INDEX_SCHEMA_ID, index)

/** Validates a JSON Schema document: 2020-12 plus the registered `x-` keywords only. */
export const validateSchemaDocument = (schema: unknown): ValidationIssue[] => run(SCHEMA_DIALECT_ID, schema)

/** Validates one example group. */
export const validateExampleGroup = (group: unknown): ValidationIssue[] => run(EXAMPLE_GROUP_SCHEMA_ID, group)

/**
 * Validates `value` against any JSON Schema (2020-12), for example one that another package publishes. Uses its own
 * ajv instance, so the meta-schemas of the shared one are untouched. `files` are the `schemas/<file>` documents the
 * schema may `$ref`, registered under that relative name. Throws an `Error` when the schema can not be compiled,
 * for example because it is not a valid schema, or a `$ref` does not resolve.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  files: readonly { file: string; schema: unknown }[] = [],
): ValidationIssue[] {
  const own = new Ajv2020({ allErrors: true, strict: false })
  for (const f of files) own.addSchema(f.schema as object, `schemas/${f.file}`)
  const validate = own.compile(schema as object)
  return validate(value) ? [] : toIssues(validate.errors)
}
