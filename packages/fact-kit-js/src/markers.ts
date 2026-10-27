// The tags that builders hide on the values they make, and what `history`, `keyed` and the build read back.
// Every tag is a symbol under `Symbol.for('fact-kit.*')`, so two copies of fact-kit agree, and none is enumerable,
// so none is written to the index.

/** Raised by `mf.*`, `subsetOf`, `contentOf` and by `history` when a row breaks what a builder checked. */
export class BuilderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuilderError'
  }
}

/** On an object or an array a fact's value was copied into: the fact object it was read from. */
export const FROM = Symbol.for('fact-kit.from')
/** On the root of what a builder made: the name of the builder, which `history` checks every row against. */
export const BUILDER = Symbol.for('fact-kit.builder')
/** On the array `subsetOf` made: the parent fact object. */
export const SUBSET = Symbol.for('fact-kit.subset-of')
/** On the array `history` returns. */
export const HISTORY = Symbol.for('fact-kit.history')
/** On the array `history` returns: the facts the statements of its rows relate to. */
export const RELATES = Symbol.for('fact-kit.relates')
/** On the array `history` returns: the names of the builders that made the content of its rows. */
export const BUILDERS = Symbol.for('fact-kit.builders')
/** On the object `invariant` and `statementFrom` return. */
export const BUILT = Symbol.for('fact-kit.built-statement')

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The tag of `target`, if it has one. */
export const markOf = (target: unknown, mark: symbol): unknown =>
  typeof target === 'object' && target !== null ? (target as Record<symbol, unknown>)[mark] : undefined

export function setMark(target: object, mark: symbol, value: unknown): void {
  Object.defineProperty(target, mark, { value, enumerable: false, configurable: true })
}

const isOurs = (symbol: symbol): boolean => Symbol.keyFor(symbol)?.startsWith('fact-kit.') ?? false

/** Copies every `fact-kit.` tag of `from` to `to`, except those in `skip`. */
export function copyMarks(from: object, to: object, skip: readonly symbol[] = []): void {
  for (const symbol of Object.getOwnPropertySymbols(from)) {
    if (isOurs(symbol) && !skip.includes(symbol)) setMark(to, symbol, (from as Record<symbol, unknown>)[symbol])
  }
}

// --- statements ----------------------------------------------------------------------------------------
declare const BUILT_STATEMENT: unique symbol
/** A statement a builder made (`invariant`, `statementFrom`): the text plus the facts it relates to. */
export interface BuiltStatement {
  readonly [BUILT_STATEMENT]: true
}

interface BuiltParts {
  text: unknown
  relates: readonly object[]
}

export function makeBuilt(text: unknown, relates: readonly object[], builder?: string): BuiltStatement {
  const built = { text, relates } as BuiltParts
  setMark(built, BUILT, true)
  if (builder !== undefined) setMark(built, BUILDER, builder)
  return built as unknown as BuiltStatement
}

export const isBuilt = (value: unknown): value is BuiltStatement => markOf(value, BUILT) === true

/** The text and the related facts inside a built statement. */
export const partsOf = (built: BuiltStatement): BuiltParts => built as unknown as BuiltParts

// --- what each builder checks of its own output ------------------------------------------------------
type BuilderCheck = (root: unknown) => string | undefined
export type ContentKind = 'value' | 'schema' | 'statement'
interface BuilderAbout {
  /** The content a builder makes, so `mf.*` can refuse it in another method. */
  kind: ContentKind
  /** The topic `mf.*` adds to the fact. */
  topic?: string
}
const checks = new Map<string, BuilderCheck>()
const abouts = new Map<string, BuilderAbout>()

/** Registers the check of a builder. It returns a message that names the key at fault, or undefined. */
export function registerBuilderCheck(name: string, check: BuilderCheck, about?: BuilderAbout): void {
  checks.set(name, check)
  if (about) abouts.set(name, about)
}

/** What is known of the builder of that name: the kind of content it makes and the topic it adds. */
export const builderAbout = (name: unknown): BuilderAbout | undefined =>
  typeof name === 'string' ? abouts.get(name) : undefined

/** True for a non-empty string, or an object with at least one language. */
export const isText = (value: unknown): boolean =>
  (typeof value === 'string' && value !== '') || (isObject(value) && Object.keys(value).length > 0)

/** What is wrong with `root` for the builder that made it, or undefined. Without a tag nothing is checked. */
export function builderProblem(root: unknown): string | undefined {
  const name = markOf(root, BUILDER)
  return typeof name === 'string' ? checks.get(name)?.(root) : undefined
}

// --- reads collected by the function form --------------------------------------------------------------
const scopes: Set<object>[] = []

/** Runs `fn` and returns what it returned with the facts read from while it ran, in the order of the first read. */
export function collecting<T>(fn: () => T): { value: T; facts: object[] } {
  const scope = new Set<object>()
  scopes.push(scope)
  try {
    return { value: fn(), facts: [...scope] }
  } finally {
    scopes.pop()
  }
}

/** Notes that a value of `fact` was read. Only the innermost running function form collects it. */
export function recordRead(fact: object): void {
  scopes.at(-1)?.add(fact)
}

// --- field references ----------------------------------------------------------------------------------------
const REFS = Symbol.for('fact-kit.refs')

/** What a `ref` placeholder stands for. */
export interface RefTarget {
  fact: object
  /** A dotted path, or undefined for the whole fact. */
  field: string | undefined
}

interface RefRegistry {
  byToken: Map<string, RefTarget>
  byFact: WeakMap<object, Map<string, string>>
}

function refs(): RefRegistry {
  const store = globalThis as unknown as Record<symbol, RefRegistry | undefined>
  return (store[REFS] ??= { byToken: new Map(), byFact: new WeakMap() })
}

/** The placeholder for one fact object and field. The same pair always gets the same placeholder. */
export function refToken(fact: object, field: string | undefined): string {
  const registry = refs()
  let tokens = registry.byFact.get(fact)
  if (!tokens) registry.byFact.set(fact, (tokens = new Map()))
  const key = field ?? ''
  let token = tokens.get(key)
  if (token === undefined) {
    token = `⟦fact-ref:${registry.byToken.size}⟧`
    registry.byToken.set(token, { fact, field })
    tokens.set(key, token)
  }
  return token
}

/** The fact object and field a placeholder stands for, if it is one. */
export const refTarget = (token: string): RefTarget | undefined => refs().byToken.get(token)

/** Matches the placeholders of `ref` inside a longer string. */
export const REF_TOKEN = /⟦fact-ref:(\d+)⟧/g
/** Matches a string that is nothing but one placeholder. */
export const WHOLE_REF = /^⟦fact-ref:\d+⟧$/
