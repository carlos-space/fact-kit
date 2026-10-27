import { FROM, SUBSET, isObject, markOf } from './markers.ts'
import { loadInstalledIndex } from './read.ts'
import type { DerivedFact, Fact, FactDecl, FactLike, FactsModule, FactsSource, Problem } from './types.ts'

/** Marks what `derive` returns. A `Symbol.for` key, so two copies of fact-kit agree. */
const DERIVE = Symbol.for('fact-kit.derive')
/** Where `factLink` keeps the facts its placeholders stand for. */
const LINKS = Symbol.for('fact-kit.links')

interface LinkRegistry {
  byToken: Map<string, object>
  byFact: WeakMap<object, string>
}

function links(): LinkRegistry {
  const store = globalThis as unknown as Record<symbol, LinkRegistry | undefined>
  return (store[LINKS] ??= { byToken: new Map(), byFact: new WeakMap() })
}

const TOKEN = /⟦fact-link:(\d+)⟧/g

/**
 * The location of another fact of this package, to write into a sentence of `content`. It returns a
 * placeholder that the build replaces with the fact location of m149/d006 (`<id>` in the same entry,
 * `<spec>:<id>` in another), and the build adds the fact to `derivedFrom`.
 */
export function factLink(fact: FactLike): string {
  if (typeof fact !== 'object' || fact === null) throw new TypeError('factLink: expected a fact object')
  const registry = links()
  let token = registry.byFact.get(fact)
  if (token === undefined) {
    token = `⟦fact-link:${registry.byToken.size}⟧`
    registry.byToken.set(token, fact)
    registry.byFact.set(fact, token)
  }
  return token
}

/**
 * A fact computed from a fact of another package. At build, fact-kit reads the installed index of
 * `upstreamSpec` (`<package>` or `<package>/<path>`), takes the fact `id`, and applies `map` to a copy of it.
 * `map` returns the fields to change. The result gets `source: { kind: 'derived', from, version }` and the
 * upstream fact in `derivedFrom`.
 */
export function derive(upstreamSpec: string, id: string, map?: (upstream: Fact) => Partial<FactDecl>): DerivedFact {
  return Object.defineProperty({ spec: upstreamSpec, id, ...(map ? { map } : {}) } as DerivedFact, DERIVE, {
    value: true,
    enumerable: false,
  })
}

const isDerived = (value: unknown): value is DerivedFact =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DERIVE] === true

// --- resolving a package -------------------------------------------------------------------------------
export interface SourceEntry {
  /** Sub-path of the entry. */
  entry: string
  /** File the entry was loaded from, for locations. */
  origin: string
  source: FactsSource
}

export interface ResolveContext {
  /** Package directory. The upstream packages of `derive` are installed from here. */
  cwd: string
  packageName: string
}

/** A list that `subsetOf` keeps inside the list of another fact. `parent` and `location` are fact locations. */
export interface SubsetDecl {
  /** The id of the subset fact. */
  id: string
  /** The location of the parent: `<id>` in the same entry, `<spec>:<id>` in another. */
  parent: string
  /** Where the subset fact is declared. */
  location: string
}

export interface ResolvedEntry {
  module: FactsModule
  problems: Problem[]
  subsets: SubsetDecl[]
}

const at = (origin: string, pointer: string) => `${origin}#${pointer}`

function deriveFact(d: DerivedFact, ctx: ResolveContext): FactDecl {
  if (typeof d.spec !== 'string' || typeof d.id !== 'string') throw new Error('derive(spec, id): both are strings')
  const installed = loadInstalledIndex(d.spec, ctx.cwd)
  const upstream = installed.index.facts.find((f) => f.id === d.id)
  if (!upstream)
    throw new Error(`${d.spec} (${installed.packageName} ${installed.packageVersion}) has no fact "${d.id}"`)
  const { derivedFrom: _derivedFrom, verify: _verify, source: _source, ...rest } = structuredClone(upstream)
  const mapped = d.map ? d.map(structuredClone(upstream)) : {}
  if (typeof mapped !== 'object' || mapped === null) throw new Error('the map function must return an object')
  const derived: FactDecl = {
    ...(rest as FactDecl),
    ...mapped,
    derivedFrom: [`${d.spec}:${upstream.id}`, ...(mapped.derivedFrom ?? [])],
    source: { kind: 'derived', from: d.spec, version: installed.packageVersion },
  }
  delete (derived as { verify?: unknown }).verify
  return derived
}

/**
 * Copy of `value` with every string passed through `text`. `from` is called, in document order, for each object
 * or array that a builder tagged with the fact it was read from. The copy has no tags.
 */
function mapDoc(value: unknown, text: (text: string) => string, from: (fact: object) => void): unknown {
  if (typeof value === 'string') return text(value)
  if (typeof value === 'object' && value !== null) {
    const origin = markOf(value, FROM)
    if (typeof origin === 'object' && origin !== null) from(origin)
    if (Array.isArray(value)) return value.map((v) => mapDoc(v, text, from))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapDoc(v, text, from)]))
  }
  return value
}

/** The roots of the contents of a fact, where `subsetOf` hides its mark. */
function contentRoots(decl: FactDecl): unknown[] {
  const rows = [decl.content, ...(Array.isArray(decl.variants) ? decl.variants.map((v) => v?.content) : [])]
  return rows.flatMap((c) => (isObject(c) && 'value' in c ? [c.value] : []))
}

/**
 * Turns the loaded sources of one package into plain facts: derives the facts that come from another package,
 * and replaces `relates` and `factLink` with `derivedFrom`. A related fact is matched by object identity, so
 * renaming or moving a fact does not break the link. A fact object that is not one of this package's facts
 * (one imported from another package) is reported as `relates-foreign`.
 */
export function resolveEntries(entries: readonly SourceEntry[], ctx: ResolveContext): ResolvedEntry[] {
  const out: ResolvedEntry[] = entries.map((e) => ({
    module: {
      describes: e.source.describes,
      ...(e.source.formatVersion !== undefined ? { formatVersion: e.source.formatVersion } : {}),
      facts: [],
    },
    problems: [],
    subsets: [],
  }))
  // What each declared object ends up as, and where it lives.
  const registry = new Map<object, { entry: string; id: string }>()
  const decls: { entryIndex: number; at: string; decl: FactDecl }[] = []

  for (const [ei, e] of entries.entries()) {
    const problems = (out[ei] as ResolvedEntry).problems
    for (const [i, raw] of e.source.facts.entries()) {
      const where = at(e.origin, `/facts/${i}`)
      let decl: FactDecl
      if (isDerived(raw)) {
        try {
          decl = deriveFact(raw, ctx)
        } catch (error) {
          problems.push({
            code: 'derive',
            message: `derive("${raw.spec}", "${raw.id}"): ${(error as Error).message}`,
            location: where,
          })
          continue
        }
      } else if (typeof raw === 'object' && raw !== null) {
        decl = raw as FactDecl
      } else {
        // Not an object: the format check reports it on the built index.
        decls.push({ entryIndex: ei, at: where, decl: raw as unknown as FactDecl })
        continue
      }
      if (typeof decl.id === 'string') registry.set(raw, { entry: e.entry, id: decl.id })
      decls.push({ entryIndex: ei, at: where, decl })
    }
  }

  for (const { entryIndex, at: where, decl } of decls) {
    const e = entries[entryIndex] as SourceEntry
    const problems = (out[entryIndex] as ResolvedEntry).problems
    const facts = out[entryIndex]?.module.facts as Fact[]
    if (typeof decl !== 'object' || decl === null) {
      facts.push(decl as unknown as Fact)
      continue
    }
    const locate = (target: object): string | undefined => {
      const found = registry.get(target)
      if (!found) return undefined
      return found.entry === e.entry ? found.id : `${ctx.packageName}/${found.entry}:${found.id}`
    }
    // Reports the object and returns its id, which stands in for the location in the text. It is not a derivedFrom.
    const foreign = (target: object, how: string): string => {
      const id = (target as { id?: unknown }).id
      problems.push({
        code: 'relates-foreign',
        message: `${decl.id}: ${how} ${typeof id === 'string' ? `"${id}"` : 'a value'}, which is not a fact of this package. A fact object imported from another package can not be related. Use derive(upstreamSpec, id) to bring it in`,
        location: where,
      })
      return typeof id === 'string' ? id : ''
    }

    const derivedFrom: string[] = [...(decl.derivedFrom ?? [])]
    const add = (location: string) => {
      if (location && !derivedFrom.includes(location)) derivedFrom.push(location)
    }
    for (const related of decl.relates ?? []) {
      if (typeof related !== 'object' || related === null) {
        problems.push({
          code: 'relates-foreign',
          message: `${decl.id}: relates has ${JSON.stringify(related)}, which is not a fact object`,
          location: where,
        })
        continue
      }
      const location = locate(related)
      if (location !== undefined) add(location)
      else foreign(related, 'relates')
    }
    // The parent of a subset is a fact it is derived from, and the check tests it at every version boundary.
    for (const root of contentRoots(decl)) {
      const parent = markOf(root, SUBSET)
      if (typeof parent !== 'object' || parent === null) continue
      const location = locate(parent)
      if (location === undefined) {
        if (!(decl.relates ?? []).includes(parent as FactLike)) foreign(parent, 'subsetOf points at')
        continue
      }
      add(location)
      const subsets = (out[entryIndex] as ResolvedEntry).subsets
      if (!subsets.some((s) => s.id === decl.id && s.parent === location)) {
        subsets.push({ id: decl.id, parent: location, location: where })
      }
    }
    const { relates: _relates, derivedFrom: _own, ...rest } = decl
    const readFrom = new Set<object>()
    const replaced = mapDoc(
      rest,
      (text) =>
        text.replace(TOKEN, (token) => {
          const target = links().byToken.get(token)
          if (!target) return token
          const location = locate(target)
          if (location === undefined) return foreign(target, 'factLink points at')
          add(location)
          return location
        }),
      (origin) => {
        if (readFrom.has(origin)) return
        readFrom.add(origin)
        const location = locate(origin)
        if (location !== undefined) add(location)
        else foreign(origin, 'a value read from')
      },
    ) as Record<string, unknown>
    facts.push({ ...replaced, ...(derivedFrom.length > 0 ? { derivedFrom } : {}) } as unknown as Fact)
  }
  return out
}
