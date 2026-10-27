import { factLink } from './author.ts'
import type { FactRef } from './builders.ts'
import { keyed } from './history.ts'
import { BUILDER, BuilderError, isObject, isText, makeBuilt, registerBuilderCheck, setMark } from './markers.ts'
import type { BuiltStatement } from './markers.ts'
import type { FactLike, JsonSchema, Text } from './types.ts'

// --- shapes ------------------------------------------------------------------------------------------------
type Fields = { readonly [name: string]: JsonSchema | FactRef }
type FieldName<F> = keyof F & string

export type ObjectSchema<F> = { type: 'object'; properties: F; required?: FieldName<F>[] }
export type EntitySchema<F> = ObjectSchema<F> & { 'x-identity': FieldName<F> | FieldName<F>[] }

export interface AggregateMember {
  entity: FactLike
  cardinality?: 'one' | 'many'
}

export interface Aggregate {
  root: string
  members: { entity: string; cardinality: 'one' | 'many' }[]
}

export interface UseCaseStep {
  layer: 'application' | 'domain' | 'infrastructure'
  action: string
  rule?: FactLike
  emits?: FactLike
  calls?: FactLike
}

export interface UseCase {
  input?: string | JsonSchema
  output?: string | JsonSchema
  steps: { layer: UseCaseStep['layer']; action: string; rule?: string; emits?: string; calls?: string }[]
  errors: string[]
}

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)
const isName = (value: unknown): value is string => typeof value === 'string' && value !== ''
const LAYERS = ['application', 'domain', 'infrastructure']

// --- checks: what each builder verifies of its own output, at build time and again after every history row --
/** A message for the first key that appears twice in `items`, naming the key. */
function repeated(items: unknown[], what: string, key: (item: unknown) => unknown): string | undefined {
  const seen = new Set<string>()
  for (const item of items) {
    const id = show(key(item))
    if (seen.has(id)) return `${what} has the key ${id} twice`
    seen.add(id)
  }
  return undefined
}

/** The names of an object schema: its properties must be schemas, and `required` and `x-identity` must name them. */
function objectProblem(root: unknown, name: string): string | undefined {
  if (!isObject(root)) return `${name} must be an object, got ${show(root)}`
  const { properties, required } = root
  if (root.type !== 'object') return `${name}: "type" must be "object", got ${show(root.type)}`
  if (!isObject(properties)) return `${name}: "properties" must be an object of fields, got ${show(properties)}`
  const names = Object.keys(properties)
  for (const field of names) {
    const schema = properties[field]
    // A `ref(fact)` is a string until the build.
    if (!isObject(schema) && typeof schema !== 'boolean' && !isName(schema)) {
      return `property ${show(field)} must be a schema or a ref(fact), got ${show(schema)}`
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required)) return `required must be a list of field names, got ${show(required)}`
    const twice = repeated(required, 'required', (item) => item)
    if (twice) return twice
    for (const item of required) {
      if (!names.includes(item as string)) {
        return `required ${show(item)} is not in properties (fields: ${names.map(show).join(', ')})`
      }
    }
  }
  if (name === 'entity') {
    const identity = root['x-identity']
    const list = Array.isArray(identity) ? identity : [identity]
    if (identity === undefined || (Array.isArray(identity) && identity.length < 2)) {
      return `x-identity must be a field name or a list of at least two different field names, got ${show(identity)}`
    }
    const twice = repeated(list, 'x-identity', (item) => item)
    if (twice) return twice
    for (const item of list) {
      if (!isName(item) || !names.includes(item)) {
        return `x-identity ${show(item)} is not in properties (fields: ${names.map(show).join(', ')})`
      }
    }
  }
  return undefined
}

function aggregateProblem(root: unknown): string | undefined {
  if (!isObject(root)) return `an aggregate must be an object, got ${show(root)}`
  if (!isName(root.root)) return `root must be a fact position, got ${show(root.root)}`
  if (!Array.isArray(root.members)) return `members must be a list, got ${show(root.members)}`
  for (const member of root.members) {
    if (!isObject(member) || !isName(member.entity)) {
      return `member ${show(member)} must be an object with an "entity"`
    }
    if (member.cardinality !== 'one' && member.cardinality !== 'many') {
      return `member ${show(member.entity)}: "cardinality" must be "one" or "many", got ${show(member.cardinality)}`
    }
  }
  return repeated(root.members, 'members', (m) => (m as Record<string, unknown>).entity)
}

/** What is wrong with a use case value, or undefined. Also reads a use case from a built index, where the facts are ids. */
export function useCaseProblem(root: unknown): string | undefined {
  if (!isObject(root)) return `a use case must be an object, got ${show(root)}`
  for (const side of ['input', 'output'] as const) {
    const given = root[side]
    if (given !== undefined && !isName(given) && !isObject(given) && typeof given !== 'boolean') {
      return `"${side}" must be a ref(fact) or a schema, got ${show(given)}`
    }
  }
  if (!Array.isArray(root.steps)) return `steps must be a list, got ${show(root.steps)}`
  for (const step of root.steps) {
    if (!isObject(step)) return `step ${show(step)} must be an object`
    if (!isName(step.action)) return `step ${show(step.action)}: "action" must be a non-empty string`
    if (!LAYERS.includes(step.layer as string)) {
      return `step ${show(step.action)}: "layer" is ${show(step.layer)}, which is not one of ${LAYERS.join(', ')}`
    }
    for (const link of ['rule', 'emits', 'calls'] as const) {
      if (step[link] !== undefined && !isName(step[link])) {
        return `step ${show(step.action)}: "${link}" must be a fact position, got ${show(step[link])}`
      }
    }
  }
  const twice = repeated(root.steps, 'steps', (s) => (s as Record<string, unknown>).action)
  if (twice) return twice
  if (!Array.isArray(root.errors) || !root.errors.every(isName)) {
    return `errors must be a list of non-empty strings, got ${show(root.errors)}`
  }
  return repeated(root.errors, 'errors', (e) => e)
}

registerBuilderCheck('valueObject', (root) => objectProblem(root, 'valueObject'), {
  kind: 'schema',
  topic: 'ddd:value-object',
})
registerBuilderCheck('entity', (root) => objectProblem(root, 'entity'), { kind: 'schema', topic: 'ddd:entity' })
registerBuilderCheck('domainEvent', (root) => objectProblem(root, 'domainEvent'), {
  kind: 'schema',
  topic: 'ddd:domain-event',
})
registerBuilderCheck('aggregate', aggregateProblem, { kind: 'value', topic: 'ddd:aggregate' })
registerBuilderCheck('useCase', useCaseProblem, { kind: 'value', topic: 'ddd:use-case' })
registerBuilderCheck('invariant', () => undefined, { kind: 'statement', topic: 'ddd:invariant' })

// --- builders ----------------------------------------------------------------------------------------------
function made<T extends object>(name: string, value: T, problem: (root: unknown) => string | undefined): T {
  setMark(value, BUILDER, name)
  const broken = problem(value)
  if (broken !== undefined) throw new BuilderError(`${name}: ${broken}`)
  return value
}

const listOf = (what: string, value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new BuilderError(`${what} must be a list, got ${show(value)}`)
  return value
}

function fieldsOf(name: string, fields: unknown): Record<string, unknown> {
  if (!isObject(fields))
    throw new BuilderError(`${name}: the fields are an object of name -> schema, got ${show(fields)}`)
  return { ...fields }
}

function requiredOf(name: string, required: unknown): { required: string[] } | {} {
  if (required === undefined) return {}
  return { required: keyed(listOf(`${name}: required`, required) as string[]) }
}

/** The location a step or a member writes for a fact: a placeholder the build replaces. */
function linkOf(what: string, fact: unknown): string {
  if (isObject(fact)) return factLink(fact as unknown as FactLike)
  // A `ref(fact)` or a placeholder that was already made.
  if (isName(fact)) return fact
  throw new BuilderError(`${what} must be a fact object, got ${show(fact)}`)
}

/**
 * A value object as a JSON Schema: `{ type: 'object', properties, required? }`. A property is a schema, or
 * `ref(fact)` for the schema of another fact. `required` is `keyed`, so a `history` row can `add` and `remove`
 * its names, and `remove: { '/properties': [name] }` drops a field by name. Throws `BuilderError` when a name in
 * `required` is not a property, and `history` checks it again after every row, so a row that drops a field
 * `required` still names fails.
 */
export function valueObject<const F extends Fields>(
  fields: F,
  options: { required?: readonly NoInfer<FieldName<F>>[] } = {},
): ObjectSchema<F> {
  const value = {
    type: 'object',
    properties: fieldsOf('valueObject', fields),
    ...requiredOf('valueObject', options?.required),
  }
  return made('valueObject', value, (root) => objectProblem(root, 'valueObject')) as unknown as ObjectSchema<F>
}

/** An event as a JSON Schema, in the same shape and with the same rules as `valueObject`. */
export function domainEvent<const F extends Fields>(
  fields: F,
  options: { required?: readonly NoInfer<FieldName<F>>[] } = {},
): ObjectSchema<F> {
  const value = {
    type: 'object',
    properties: fieldsOf('domainEvent', fields),
    ...requiredOf('domainEvent', options?.required),
  }
  return made('domainEvent', value, (root) => objectProblem(root, 'domainEvent')) as unknown as ObjectSchema<F>
}

/**
 * An entity as a JSON Schema: `{ type: 'object', 'x-identity', properties, required? }`. `identity` is a field
 * name, or a list of at least two. A list of one name is written as the name. Otherwise it follows `valueObject`.
 * Throws `BuilderError` when an identity name is not a property, and `history` checks it again after every row.
 */
export function entity<const F extends Fields>(def: {
  identity: NoInfer<FieldName<F>> | readonly NoInfer<FieldName<F>>[]
  fields: F
  required?: readonly NoInfer<FieldName<F>>[]
}): EntitySchema<F> {
  if (!isObject(def)) throw new BuilderError('entity: expected { identity, fields, required? }')
  const identity = Array.isArray(def.identity) && def.identity.length === 1 ? def.identity[0] : def.identity
  const value = {
    type: 'object',
    'x-identity': Array.isArray(identity) ? [...identity] : identity,
    properties: fieldsOf('entity', def.fields),
    ...requiredOf('entity', def.required),
  }
  return made('entity', value, (root) => objectProblem(root, 'entity')) as unknown as EntitySchema<F>
}

/**
 * A business rule about an entity or value, as a statement that `mf.statement` takes. `subject` goes into
 * `relates`, so `derivedFrom` follows it. A `history` row rewrites the sentence with `statement: invariant(...)`,
 * which carries the new `relates`, or with `set: { '': text }`, which does not.
 */
export function invariant(subject: FactLike, text: Text): BuiltStatement {
  if (!isObject(subject)) throw new BuilderError(`invariant: the subject must be a fact object, got ${show(subject)}`)
  if (!isText(text)) throw new BuilderError(`invariant: the text must be a non-empty text, got ${show(text)}`)
  return makeBuilt(text, [subject], 'invariant')
}

/**
 * An aggregate as a value: `{ root, members }`, each member `{ entity, cardinality }` with `cardinality` `'one'`
 * (the default) or `'many'`. The facts are written as placeholders that the build replaces with their location,
 * and they go into `derivedFrom`. `members` is `keyed` by `entity`, so a `history` row names a member by
 * `factLink(entity)`.
 */
export function aggregate(def: { root: FactLike; members: readonly AggregateMember[] }): Aggregate {
  if (!isObject(def)) throw new BuilderError('aggregate: expected { root, members }')
  if (!isObject(def.root)) throw new BuilderError(`aggregate: root must be a fact object, got ${show(def.root)}`)
  const members = listOf('aggregate: members', def.members).map((member) => {
    if (!isObject(member)) throw new BuilderError(`aggregate: member ${show(member)} must be an object`)
    return {
      entity: linkOf('aggregate: member entity', member.entity),
      cardinality: member.cardinality ?? 'one',
    }
  })
  const value = { root: linkOf('aggregate: root', def.root), members: keyed(members, ['entity']) }
  return made('aggregate', value, aggregateProblem) as unknown as Aggregate
}

/**
 * An application use case as a value: `{ input?, output?, steps, errors }`. `input` and `output` are a
 * `ref(fact)` or a schema. Each step is `{ layer, action, rule?, emits?, calls? }`, and the facts in `rule`,
 * `emits` and `calls` become placeholders that the build replaces with their location. `steps` is `keyed` by
 * `action`, which no two steps share, and a `history` row can `add` steps only at the end. `errors` is a
 * `keyed` list of codes.
 */
export function useCase(def: {
  input?: FactRef | JsonSchema
  output?: FactRef | JsonSchema
  steps: readonly UseCaseStep[]
  errors?: readonly string[]
}): UseCase {
  if (!isObject(def)) throw new BuilderError('useCase: expected { input?, output?, steps, errors? }')
  const steps = listOf('useCase: steps', def.steps).map((step) => {
    if (!isObject(step)) throw new BuilderError(`useCase: step ${show(step)} must be an object`)
    return {
      layer: step.layer,
      action: step.action,
      ...(step.rule !== undefined ? { rule: linkOf('useCase: rule', step.rule) } : {}),
      ...(step.emits !== undefined ? { emits: linkOf('useCase: emits', step.emits) } : {}),
      ...(step.calls !== undefined ? { calls: linkOf('useCase: calls', step.calls) } : {}),
    }
  })
  const value = {
    ...(def.input !== undefined ? { input: def.input } : {}),
    ...(def.output !== undefined ? { output: def.output } : {}),
    steps: keyed(steps, ['action']),
    errors: keyed(listOf('useCase: errors', def.errors ?? [])),
  }
  return made('useCase', value, useCaseProblem) as unknown as UseCase
}
