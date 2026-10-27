import { keyed } from './history.ts'
import type { HistoryVariants } from './history.ts'
import {
  BuilderError,
  FROM,
  HISTORY,
  RELATES,
  SUBSET,
  collecting,
  copyMarks,
  isBuilt,
  isObject,
  makeBuilt,
  markOf,
  partsOf,
  recordRead,
  refToken,
  setMark,
} from './markers.ts'
import type { BuiltStatement } from './markers.ts'
import type { Fact, FactDecl, FactLike, FactSource, FactVariant, JsonSchema, Text } from './types.ts'

export { BuilderError } from './markers.ts'
export type { BuiltStatement } from './markers.ts'

// --- types the builders give to facts (type-level only) ---------------------------------------------------
declare const VALUE: unique symbol
declare const SCHEMA: unique symbol
declare const STATEMENT: unique symbol

type FactKey = keyof FactDecl
/** Fields of a value that the fact object exposes as read-only getters: object values only, Fact fields win. */
type FieldsOf<V> = V extends readonly unknown[]
  ? {}
  : V extends object
    ? { readonly [K in Exclude<keyof V, FactKey>]: V[K] }
    : {}

/** A fact with one content is a full `Fact`, so it fits the `Fact[]` arrays existing sources declare. */
export type ValueFact<V> = Fact & { readonly [VALUE]: V } & FieldsOf<V>
export type SchemaFact<S> = Fact & { readonly [SCHEMA]: S }
export type StatementFact = Fact & { readonly [STATEMENT]: true }
/** A fact written with `history(...)`: no getters, and its shape is unknown to the type checker. */
export type VersionedFact<K extends 'value' | 'schema' | 'statement'> = K extends 'value'
  ? FactDecl & { readonly [VALUE]: unknown }
  : K extends 'schema'
    ? FactDecl & { readonly [SCHEMA]: unknown }
    : FactDecl & { readonly [STATEMENT]: true }

export interface FactOptions {
  /** Defaults to `name`, the id without `<tool>.` and `<prefix>.`. */
  title?: Text
  /** Added after the topics of the factory. */
  topics?: readonly string[]
  description?: Text
  when?: Fact['when']
  relates?: readonly FactLike[]
  verify?: Fact['verify']
  /** Replaces the source of the factory for this fact. */
  source?: FactSource
  /** Merged into an observed source as `note`. */
  note?: Text
}

export interface FactsOfOptions {
  tool: string
  source: FactSource
  /** The id is `<tool>.<prefix>.<name>`, or `<tool>.<name>` without a prefix. */
  prefix?: string
  topics?: readonly string[]
}

/**
 * Each method takes the content (a value, a schema, a text), the rows of `history(...)`, or a function that
 * returns either. While the function runs, every read of another fact's value fields, scalars included, is
 * collected into this fact's `relates`. A value is JSON, so a function is never a value.
 */
export interface FactsFactory {
  value(name: string, rows: HistoryVariants | (() => HistoryVariants), options?: FactOptions): VersionedFact<'value'>
  value<const V>(name: string, build: () => V, options?: FactOptions): ValueFact<V>
  value<const V>(name: string, value: V, options?: FactOptions): ValueFact<V>
  schema(name: string, rows: HistoryVariants | (() => HistoryVariants), options?: FactOptions): VersionedFact<'schema'>
  schema<const S extends JsonSchema>(name: string, build: () => S, options?: FactOptions): SchemaFact<S>
  schema<const S extends JsonSchema>(name: string, schema: S, options?: FactOptions): SchemaFact<S>
  statement(
    name: string,
    rows: HistoryVariants | (() => HistoryVariants),
    options?: FactOptions,
  ): VersionedFact<'statement'>
  statement(
    name: string,
    text: Text | BuiltStatement | (() => Text | BuiltStatement),
    options?: FactOptions,
  ): StatementFact
}

type ContentOf<F> = F extends { readonly [VALUE]: infer V } ? V : F extends { readonly [SCHEMA]: infer S } ? S : unknown

/** The item type a parent allows: the element type of a typed list, `string` when the parent's shape is unknown. */
type ElementOf<F> = F extends { readonly [VALUE]: infer V }
  ? unknown extends V
    ? string
    : V extends readonly (infer E)[]
      ? E
      : never
  : string

// --- tagged copies -----------------------------------------------------------------------------------------
/** A deep copy that keeps the tags of fact-kit, with every object and array pointing at `fact` as its origin. */
function tagged<T>(value: T, fact: object): T {
  if (Array.isArray(value)) {
    const out = value.map((item) => tagged(item, fact))
    copyMarks(value, out, [FROM])
    setMark(out, FROM, fact)
    return out as T
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = tagged(v, fact)
    copyMarks(value, out, [FROM])
    setMark(out, FROM, fact)
    return out as T
  }
  return value
}

const CONTENT_KINDS = ['value', 'schema', 'statement'] as const
type Kind = (typeof CONTENT_KINDS)[number]

/** The fields of a fact that a value field of the same name would hide. */
const RESERVED = new Set([
  'id',
  'tool',
  'topics',
  'title',
  'description',
  'content',
  'variants',
  'derivedFrom',
  'when',
  'source',
  'verify',
  'relates',
])

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)

/**
 * A copy of the content of one row of a fact (the value, the schema or the text), tagged so the build adds the
 * fact to `derivedFrom` where the copy is embedded. A fact with several rows needs `since`, the `since` of the
 * row to read (for a row written as an array of versions, any one of them).
 */
export function contentOf<F extends FactLike>(fact: F, since?: string): ContentOf<F> {
  if (!isObject(fact)) throw new BuilderError(`contentOf: expected a fact object, got ${show(fact)}`)
  const decl = fact as unknown as { id?: unknown; content?: unknown; variants?: unknown }
  const name = typeof decl.id === 'string' ? decl.id : 'the fact'
  let content: unknown = decl.content
  if (Array.isArray(decl.variants) && decl.variants.length > 0) {
    const rows = decl.variants as FactVariant[]
    if (since === undefined) {
      if (rows.length > 1) {
        throw new BuilderError(
          `contentOf(${name}): the fact has ${rows.length} rows, so say which one to read with since (${rows.map((r) => show(r?.since)).join(', ')})`,
        )
      }
      content = rows[0]?.content
    } else {
      const row = rows.find((r) => r?.since === since || (Array.isArray(r?.since) && r.since.includes(since)))
      if (!row) {
        throw new BuilderError(
          `contentOf(${name}): no row has since ${show(since)} (rows: ${rows.map((r) => show(r?.since)).join(', ')})`,
        )
      }
      content = row.content
    }
  }
  const key = isObject(content) ? CONTENT_KINDS.find((k) => Object.hasOwn(content as object, k)) : undefined
  if (!key) {
    throw new BuilderError(
      `contentOf(${name}): the fact has no content to read (a fact made by derive() has none until the build)`,
    )
  }
  recordRead(fact)
  return tagged((content as Record<string, unknown>)[key], fact) as ContentOf<F>
}

/**
 * A statement written from the content of another fact: `render` gets the tagged copy of it and returns the
 * text. The fact goes into `relates` of the fact the statement is given to, so the text follows the value.
 */
export function statementFrom<F extends FactLike>(
  fact: F,
  render: (value: ContentOf<F>) => Text,
  options: { since?: string } = {},
): BuiltStatement {
  if (typeof render !== 'function') throw new BuilderError('statementFrom: render must be a function')
  const text = render(contentOf(fact, options.since))
  if (!isText(text)) throw new BuilderError(`statementFrom: render must return a text, got ${show(text)}`)
  return makeBuilt(text, [fact])
}

const isText = (value: unknown): value is Text =>
  (typeof value === 'string' && value !== '') || (isObject(value) && Object.keys(value).length > 0)

// --- sources -----------------------------------------------------------------------------------------------
const nonEmpty = (what: string, value: unknown): string => {
  if (typeof value !== 'string' || value === '') throw new BuilderError(`${what} must be a non-empty string`)
  return value
}

/** An observed source for a fact read from a page of the documentation. */
export function observedDoc(source: { url: string; fetched: string }): FactSource {
  return {
    kind: 'observed',
    basis: 'doc',
    url: nonEmpty('observedDoc: url', source?.url),
    fetched: nonEmpty('observedDoc: fetched', source?.fetched),
  }
}

/** An observed source for a fact seen in a trial run, with the url of the page that sent you there if any. */
export function observedSpike(source: { fetched: string; url?: string }): FactSource {
  if (source?.url !== undefined) nonEmpty('observedSpike: url', source.url)
  return {
    kind: 'observed',
    basis: 'spike',
    ...(source?.url !== undefined ? { url: source.url } : {}),
    fetched: nonEmpty('observedSpike: fetched', source?.fetched),
  }
}

// --- subsets -----------------------------------------------------------------------------------------------
/**
 * A list that must stay inside the list of `parent`. The type checker rejects an item the parent's typed list
 * does not have, and `check` tests it again at every version boundary, which also covers a parent that comes
 * from a conversion and has no type. `parent` is a fact object.
 */
export function subsetOf<F extends FactLike, const E extends ElementOf<F>>(parent: F, items: readonly E[]): E[] {
  if (!isObject(parent)) {
    throw new BuilderError(
      `subsetOf: the parent is ${show(parent)}, not a fact object. Find it in the converted facts and check that it exists`,
    )
  }
  if (!Array.isArray(items)) throw new BuilderError(`subsetOf: expected a list of items, got ${show(items)}`)
  const out = keyed(items)
  setMark(out, SUBSET, parent)
  return out as E[]
}

// --- field references --------------------------------------------------------------------------------------
declare const REF: unique symbol
/** A reference placeholder. In a schema it becomes `{ $ref }`, elsewhere the text `<location>` or `<location>#<field>`. */
export type FactRef = string & { readonly [REF]: true }

type Depth = [0, 0, 0, 0]
type SchemaPath<S, D extends 0[] = []> = D['length'] extends Depth['length']
  ? never
  : S extends { properties: infer P }
    ? P extends object
      ? { [K in keyof P & string]: K | `${K}.${SchemaPath<P[K], [...D, 0]>}` }[keyof P & string]
      : never
    : never
type ValuePath<V, D extends 0[] = []> = D['length'] extends Depth['length']
  ? never
  : V extends readonly unknown[]
    ? never
    : V extends object
      ? { [K in keyof V & string]: K | `${K}.${ValuePath<V[K], [...D, 0]>}` }[keyof V & string]
      : never

/** Field names `ref` takes for a fact: `properties` of a typed schema, keys of a typed value, any string when untyped. */
export type FieldPath<F> = F extends { readonly [SCHEMA]: infer S }
  ? unknown extends S
    ? string
    : SchemaPath<S>
  : F extends { readonly [VALUE]: infer V }
    ? unknown extends V
      ? string
      : ValuePath<V>
    : F extends { readonly [STATEMENT]: true }
      ? never
      : string

/**
 * A reference to a fact of this package, or to a field of it written with dots (`'limits.max'`). It returns a
 * placeholder that the build replaces. As the whole value of a subschema it becomes `{ $ref }` into the root
 * `$defs`, where the build puts the schema of the fact. Anywhere else it becomes the fact location, followed by
 * `#<field>` when there is a field. The fact goes into `derivedFrom`. A field name the type checker does not
 * know fails to compile, and `check` tests that the field exists in every row the two facts share.
 */
export function ref<F extends FactLike>(fact: F, field?: FieldPath<F>): FactRef {
  if (!isObject(fact)) throw new BuilderError(`ref: expected a fact object, got ${show(fact)}`)
  if (field !== undefined && (typeof field !== 'string' || field === '')) {
    throw new BuilderError(`ref: the field must be a non-empty string such as "limits.max", got ${show(field)}`)
  }
  return refToken(fact, field) as FactRef
}

// --- facts -------------------------------------------------------------------------------------------------
const isHistory = (value: unknown): value is HistoryVariants => Array.isArray(value) && markOf(value, HISTORY) === true

/** Facts of one tool and source. The id of each is `<tool>.<prefix>.<name>`. */
export function factsOf(options: FactsOfOptions): FactsFactory {
  if (!isObject(options)) throw new BuilderError('factsOf: expected { tool, source }')
  const tool = nonEmpty('factsOf: tool', options.tool)
  if (!isObject(options.source) || typeof (options.source as { kind?: unknown }).kind !== 'string') {
    throw new BuilderError('factsOf: source must be a fact source, such as observedDoc({ url, fetched })')
  }
  if (options.prefix !== undefined) nonEmpty('factsOf: prefix', options.prefix)
  const base = options.prefix === undefined ? tool : `${tool}.${options.prefix}`

  const make =
    (kind: Kind) =>
    (name: string, input: unknown, given: FactOptions = {}) => {
      if (typeof name !== 'string' || name === '' || name.startsWith('.') || name.endsWith('.')) {
        throw new BuilderError(
          `mf.${kind}: the name ${show(name)} must not be empty and must not start or end with a dot`,
        )
      }
      const id = `${base}.${name}`
      const where = `${id}: mf.${kind}`
      const read = typeof input === 'function' ? collecting(input as () => unknown) : { value: input, facts: [] }
      const result = read.value

      const carried: object[] = []
      const carry = (facts: readonly object[]) => {
        for (const fact of facts) if (!carried.includes(fact)) carried.push(fact)
      }
      let content: FactDecl['content']
      let variants: FactVariant[] | undefined
      let roots: unknown[]
      if (isHistory(result)) {
        const first = result[0]?.content
        if (!first || !Object.hasOwn(first, kind)) {
          const found = first ? CONTENT_KINDS.find((k) => Object.hasOwn(first, k)) : undefined
          throw new BuilderError(
            `${where} was given rows whose first row is a ${found ?? 'content of an unknown kind'}`,
          )
        }
        for (const [i, v] of result.entries()) {
          if (!Object.hasOwn(v.content, kind)) {
            throw new BuilderError(
              `${where}: row ${i} (since ${show(v.since)}) is a ${CONTENT_KINDS.find((k) => Object.hasOwn(v.content, k))}`,
            )
          }
        }
        variants = [...result]
        carry((markOf(result, RELATES) as object[] | undefined) ?? [])
        roots = result.map((v) => (v.content as Record<string, unknown>)[kind])
      } else if (kind === 'statement') {
        let text = result
        if (isBuilt(text)) {
          const parts = partsOf(text)
          carry(parts.relates)
          text = parts.text
        }
        if (!isText(text)) throw new BuilderError(`${where}: expected a text, got ${show(text)}`)
        content = { statement: text as Text }
        roots = []
      } else {
        if (result === undefined) throw new BuilderError(`${where}: the content is undefined`)
        content = (kind === 'value' ? { value: result } : { schema: result as JsonSchema }) as FactDecl['content']
        roots = [result]
      }
      for (const root of roots) {
        const parent = markOf(root, SUBSET)
        if (parent) carry([parent as object])
      }

      const relates = [...new Set<object>([...(given.relates ?? []), ...carried, ...read.facts])]
      const topics = [...new Set([...(options.topics ?? []), ...(given.topics ?? [])])]
      let source: FactSource = given.source ?? options.source
      if (given.note !== undefined) {
        if (source.kind !== 'observed') throw new BuilderError(`${where}: note goes with an observed source`)
        source = { ...source, note: given.note }
      }

      const decl: Record<string, unknown> = {
        id,
        tool,
        topics,
        title: given.title ?? name,
        ...(given.description !== undefined ? { description: given.description } : {}),
        ...(content ? { content } : {}),
        ...(variants ? { variants } : {}),
        ...(given.when !== undefined ? { when: given.when } : {}),
        source,
        ...(given.verify !== undefined ? { verify: given.verify } : {}),
        ...(relates.length > 0 ? { relates } : {}),
      }
      // Reading a field of the value reads the fact: the copy is tagged, and a running function form notes it.
      if (kind === 'value' && content && isObject((content as { value?: unknown }).value)) {
        const value = (content as { value: Record<string, unknown> }).value
        for (const key of Object.keys(value)) {
          if (RESERVED.has(key)) continue
          Object.defineProperty(decl, key, {
            enumerable: false,
            configurable: true,
            get() {
              recordRead(decl)
              return tagged(value[key], decl)
            },
          })
        }
      }
      return decl
    }
  return { value: make('value'), schema: make('schema'), statement: make('statement') } as unknown as FactsFactory
}
