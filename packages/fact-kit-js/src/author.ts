import { FROM, REF_TOKEN, SUBSET, WHOLE_REF, isBuilt, isObject, markOf, partsOf, refTarget } from './markers.ts'
import { SUB_LIST, SUB_MAP, SUB_ONE, subschemas } from './schema-walk.ts'
import { alignFact, rewriteRootRefs } from './align.ts'
import type { AlignSlot } from './align.ts'
import { canonical, factRows, topLevelContent } from './select.ts'
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

/** A placeholder of `factLink` or of `ref`. */
const TOKEN = /⟦fact-(?:link|ref):\d+⟧/g

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

/** A `ref` that a fact writes, for `check` to test against the rows of the fact it points at. */
export interface RefDecl {
  /** The id of the fact that writes the `ref`. */
  id: string
  /** The location of the target: `<id>` in the same entry, `<spec>:<id>` in another. */
  target: string
  /** The dotted field, or undefined for the whole fact. */
  field?: string
  /** Whether it is the whole value of a subschema, so the build wrote a `$ref` and put the schema of the target in `$defs`. */
  asSchema: boolean
  /** The rows of the fact that write it, as `check` counts rows. Undefined when it is outside the rows. */
  rows?: number[]
  /** Where the fact is declared. */
  location: string
}

/** Which entry and id each fact object ended up as, for what is written outside the facts (examples). */
export type FactIds = ReadonlyMap<object, { entry: string; id: string }>

export interface ResolvedEntry {
  module: FactsModule
  problems: Problem[]
  subsets: SubsetDecl[]
  refs: RefDecl[]
}

/** What `resolveEntries` returns: one per entry, in order, and `ids` for every fact object of them. */
export type ResolvedEntries = ResolvedEntry[] & { ids: FactIds }

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

/** What `mapDoc` calls back while it copies the content of a fact. */
interface Walk {
  /** Replaces the placeholders in a string. */
  text(text: string): string
  /** Called, in document order, for each object or array a builder tagged with the fact it was read from. */
  from(fact: object): void
  /** The `$ref` for a string that is the whole value of a subschema and is a `ref` placeholder, else undefined. */
  subref(token: string): unknown
  /** Called on entering an object. Returns what to call on leaving it, if anything. */
  enter(node: object): (() => void) | undefined
  /** The schemas the walk reads by the keywords of JSON Schema. */
  schemaRoots: ReadonlySet<object>
  /** Called with a schema root and its copy, when the copy is done. */
  done(root: object, copy: Record<string, unknown>): void
}

/** A copy of a subschema. A string in a subschema position is a `ref` or it is left as it is. */
function mapSub(value: unknown, w: Walk): unknown {
  if (typeof value === 'string' && WHOLE_REF.test(value)) {
    const replaced = w.subref(value)
    if (replaced !== undefined) return replaced
  }
  return mapDoc(value, w, true)
}

/** A copy of the value of one keyword of a schema: the subschemas of it are read as schemas, the rest as plain data. */
function mapKeyword(key: string, value: unknown, w: Walk): unknown {
  const tag = (node: unknown) => {
    const origin = markOf(node, FROM)
    if (typeof origin === 'object' && origin !== null) w.from(origin)
  }
  if (SUB_MAP.has(key) && isObject(value)) {
    tag(value)
    return Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, mapSub(sub, w)]))
  }
  if (SUB_ONE.has(key)) return mapSub(value, w)
  if (SUB_LIST.has(key) && Array.isArray(value)) {
    tag(value)
    return value.map((sub) => mapSub(sub, w))
  }
  return mapDoc(value, w)
}

/**
 * Copy of `value` with every string passed through `w.text`. The copy has no tags. Where a schema keyword says a
 * value is a subschema (`schema` is true below a schema root), a `ref` that is the whole value becomes a `$ref`.
 */
function mapDoc(value: unknown, w: Walk, schema = false): unknown {
  if (typeof value === 'string') return w.text(value)
  if (typeof value !== 'object' || value === null) return value
  const origin = markOf(value, FROM)
  if (typeof origin === 'object' && origin !== null) w.from(origin)
  const leave = w.enter(value)
  try {
    if (Array.isArray(value)) return value.map((v) => mapDoc(v, w))
    const root = w.schemaRoots.has(value)
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) copy[k] = schema || root ? mapKeyword(k, v, w) : mapDoc(v, w)
    if (root) w.done(value, copy)
    return copy
  } finally {
    leave?.()
  }
}

/** The roots of the contents of a fact, where `subsetOf` hides its mark. */
function contentRoots(decl: FactDecl): unknown[] {
  const rows = [decl.content, ...(Array.isArray(decl.variants) ? decl.variants.map((v) => v?.content) : [])]
  return rows.flatMap((c) => (isObject(c) && 'value' in c ? [c.value] : []))
}

const escapePointer = (name: string): string => name.replaceAll('~', '~0').replaceAll('/', '~1')

/** A schema root with the facts it embeds, and whether each is in another entry. */
interface BuildSlot extends AlignSlot {
  foreign: boolean[]
  root: Record<string, unknown>
}

/** One `ref` that a fact writes, before it becomes a {@link RefDecl}. */
interface RefUse {
  target: string
  field: string | undefined
  asSchema: boolean
  /** `undefined` when it is written outside the rows of the fact. */
  rows: Set<number> | undefined
}

/**
 * Turns the loaded sources of one package into plain facts: derives the facts that come from another package,
 * and replaces `relates`, `factLink` and `ref` with `derivedFrom` and locations. A related fact is matched by
 * object identity, so renaming or moving a fact does not break the link. A fact object that is not one of this
 * package's facts is reported as `relates-foreign`: one that no entry lists, or one imported from another package.
 */
export function resolveEntries(entries: readonly SourceEntry[], ctx: ResolveContext): ResolvedEntries {
  const out: ResolvedEntry[] = entries.map((e) => ({
    module: {
      describes: e.source.describes,
      ...(e.source.publish !== undefined ? { publish: e.source.publish } : {}),
      ...(e.source.formatVersion !== undefined ? { formatVersion: e.source.formatVersion } : {}),
      facts: [],
    },
    problems: [],
    subsets: [],
    refs: [],
  }))
  // What each declared object ends up as, and where it lives.
  const registry = new Map<object, { entry: string; id: string }>()
  const decls: { entryIndex: number; at: string; decl: FactDecl }[] = []
  const declOf = new Map<object, number>()

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
      declOf.set(raw, decls.length)
      decls.push({ entryIndex: ei, at: where, decl })
    }
  }
  const ownTools = new Set(decls.flatMap((d) => (typeof d.decl?.tool === 'string' ? [d.decl.tool] : [])))

  const resolved = new Map<number, unknown>()
  const building: string[] = []
  const resolveDecl = (di: number): unknown => {
    if (resolved.has(di)) return resolved.get(di)
    const { entryIndex, at: where, decl } = decls[di] as (typeof decls)[number]
    if (typeof decl !== 'object' || decl === null) {
      resolved.set(di, decl)
      return decl
    }
    building.push(String(decl.id))
    try {
      const fact = resolveFact(entryIndex, where, decl)
      resolved.set(di, fact)
      return fact
    } finally {
      building.pop()
    }
  }

  const resolveFact = (entryIndex: number, where: string, decl: FactDecl): Fact => {
    const e = entries[entryIndex] as SourceEntry
    const problems = (out[entryIndex] as ResolvedEntry).problems
    const locate = (target: object): string | undefined => {
      const found = registry.get(target)
      if (!found) return undefined
      return found.entry === e.entry ? found.id : `${ctx.packageName}/${found.entry}:${found.id}`
    }
    const report = (code: Problem['code'], message: string) => problems.push({ code, message, location: where })
    // Reports the object and returns its id, which stands in for the location in the text. It is not a derivedFrom.
    const foreign = (target: object, how: string): string => {
      const { id, tool } = target as { id?: unknown; tool?: unknown }
      const named = typeof id === 'string' ? `"${id}"` : 'a value'
      report(
        'relates-foreign',
        typeof tool === 'string' && ownTools.has(tool)
          ? `${decl.id}: ${how} ${named}, which is not listed in the \`facts\` of any entry. Add it to the \`facts\` of an entry of this package`
          : `${decl.id}: ${how} ${named}, which is not a fact of this package. A fact object imported from another package can not be related. Use derive(upstreamSpec, id) to bring it in`,
      )
      return typeof id === 'string' ? id : ''
    }

    const derivedFrom: string[] = [...(decl.derivedFrom ?? [])]
    const add = (location: string) => {
      if (location && !derivedFrom.includes(location)) derivedFrom.push(location)
    }
    for (const related of decl.relates ?? []) {
      if (typeof related !== 'object' || related === null) {
        report('relates-foreign', `${decl.id}: relates has ${JSON.stringify(related)}, which is not a fact object`)
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

    // The rows of the fact, as `check` counts them, and the schemas among them.
    const rowOf = new Map<object, number>()
    if (Array.isArray(decl.variants)) {
      for (const [i, v] of decl.variants.entries()) if (isObject(v?.content)) rowOf.set(v.content, i)
    } else if (isObject(decl.content)) {
      rowOf.set(decl.content, 0)
    }
    const schemaRoots = new Set<object>()
    for (const content of rowOf.keys()) {
      const schema = (content as { schema?: unknown }).schema
      if (isObject(schema)) schemaRoots.add(schema)
    }

    const uses = new Map<string, RefUse>()
    let row: number | undefined
    let currentRoot: object | undefined
    const embeds = new Map<object, object[]>()
    const bad = new Set<string>()
    const readFrom = new Set<object>()

    /** The location of the target of a placeholder and its field, or undefined after reporting why not. */
    const target = (
      token: string,
      asSchema: boolean,
    ): { fact: object; location: string; field?: string } | undefined => {
      const t = refTarget(token)
      if (!t) return undefined
      const location = locate(t.fact)
      if (location === undefined) {
        foreign(t.fact, 'ref points at')
        return undefined
      }
      const id = registry.get(t.fact)?.id
      if (t.field !== undefined && t.field.split('.').includes('')) {
        const key = `${location}#${t.field}`
        if (!bad.has(key)) {
          bad.add(key)
          report(
            'ref',
            `${decl.id}: ref(${id}, "${t.field}"): the field path has an empty part. Write the parts with single dots, and note that a field whose name has a dot can not be referenced`,
          )
        }
        return undefined
      }
      add(location)
      const key = `${location}|${t.field ?? ''}|${asSchema}`
      const use = uses.get(key) ?? { target: location, field: t.field, asSchema, rows: new Set<number>() }
      uses.set(key, use)
      if (row === undefined) use.rows = undefined
      else use.rows?.add(row)
      return { fact: t.fact, location, ...(t.field !== undefined ? { field: t.field } : {}) }
    }

    /** The resolved fact `x` points at, or undefined after reporting a loop. */
    const embedded = (x: object): Fact | undefined => {
      const xi = declOf.get(x)
      if (xi === undefined) return undefined
      const id = String(registry.get(x)?.id)
      const start = building.indexOf(id)
      if (start !== -1) {
        report('ref', `${decl.id}: schemas embed each other in a loop: ${[...building.slice(start), id].join(' -> ')}`)
        return undefined
      }
      return resolveDecl(xi) as Fact
    }

    /** The embedding slots of the schemas of this fact, one for each schema root that has a `ref`. */
    const slots: BuildSlot[] = []
    const said = new Set<string>()
    const say = (message: string) => {
      if (said.has(message)) return
      said.add(message)
      report('ref', message)
    }

    /**
     * The `$defs` of a schema root: what the author wrote, then the schema of each embedded fact from its row
     * `picks[i]`, or from its latest published row, and what that schema had in its own `$defs`.
     */
    const defsFor = (slot: BuildSlot, picks: readonly (number | undefined)[]): Record<string, unknown> => {
      const defs: Record<string, unknown> = { ...slot.authored }
      const put = (key: string, schema: unknown) => {
        if (Object.hasOwn(defs, key) && canonical(defs[key]) !== canonical(schema)) {
          say(`${decl.id}: $defs already has "${key}" with another schema, so the schema of ${key} can not be added`)
        } else {
          defs[key] = schema
        }
      }
      for (const [k, resolvedX] of slot.targets.entries()) {
        const id = resolvedX.id
        let schema: unknown
        try {
          const pick = picks[k]
          const content = pick === undefined ? topLevelContent(resolvedX)?.content : factRows(resolvedX)[pick]?.content
          schema = (content as { schema?: unknown } | undefined)?.schema
        } catch {
          // A `since` that is not a version: `check` reports that.
        }
        // A fact that is not a schema is reported by `check`, which tests every row of it.
        if (!isObject(schema)) continue
        const { $defs: inner, ...body } = structuredClone(schema)
        const moved = [[id, body], ...(isObject(inner) ? Object.entries(inner) : [])] as [string, unknown][]
        // A relative file `$ref` is relative to the entry the file is in, so it breaks in another entry.
        let broken = false
        for (const [, part] of moved) {
          if (slot.foreign[k]) {
            for (const { schema: sub } of subschemas(part)) {
              if (typeof sub.$ref === 'string' && !sub.$ref.startsWith('#')) {
                broken = true
                say(
                  `${decl.id}: ${id} has a $ref to "${sub.$ref}", a file of another entry, and the path breaks once the schema is embedded here`,
                )
              }
            }
          }
          // A pointer to the root of the schema (`#/properties/x`) must point to where the schema is embedded.
          const why = rewriteRootRefs(part, id)
          if (why !== undefined) {
            broken = true
            say(`${decl.id}: ${why}`)
          }
        }
        if (!broken) for (const [key, part] of moved) put(key, part)
      }
      return defs
    }

    const walk: Walk = {
      text: (text) =>
        text.replace(TOKEN, (token) => {
          if (token.startsWith('⟦fact-ref:')) {
            const t = target(token, false)
            if (!t) return String((refTarget(token)?.fact as { id?: unknown } | undefined)?.id ?? token)
            return t.field !== undefined ? `${t.location}#${t.field}` : t.location
          }
          const found = links().byToken.get(token)
          if (!found) return token
          const location = locate(found)
          if (location === undefined) return foreign(found, 'factLink points at')
          add(location)
          return location
        }),
      from: (origin) => {
        if (readFrom.has(origin)) return
        readFrom.add(origin)
        const location = locate(origin)
        if (location !== undefined) add(location)
        else foreign(origin, 'a value read from')
      },
      subref: (token) => {
        if (!refTarget(token)) return undefined
        const t = target(token, true)
        if (!t) return {}
        const id = registry.get(t.fact)?.id
        if (currentRoot) embeds.set(currentRoot, [...(embeds.get(currentRoot) ?? []), t.fact])
        const path =
          t.field === undefined ? '' : `/properties/${t.field.split('.').map(escapePointer).join('/properties/')}`
        return { $ref: `#/$defs/${id}${path}` }
      },
      enter: (node) => {
        const previous = { row, root: currentRoot }
        if (rowOf.has(node)) row = rowOf.get(node)
        if (schemaRoots.has(node)) currentRoot = node
        if (row === previous.row && currentRoot === previous.root) return undefined
        return () => {
          row = previous.row
          currentRoot = previous.root
        }
      },
      schemaRoots,
      done: (root, copy) => {
        const wanted = [...new Set(embeds.get(root) ?? [])]
        if (wanted.length === 0) return
        const slot: BuildSlot = {
          row: row ?? 0,
          authored: isObject(copy.$defs) ? { ...copy.$defs } : {},
          targets: [],
          foreign: [],
          root: copy,
        }
        for (const x of wanted) {
          const resolvedX = embedded(x)
          if (!resolvedX) continue
          slot.targets.push(resolvedX)
          slot.foreign.push(registry.get(x)?.entry !== e.entry)
        }
        slots.push(slot)
        copy.$defs = defsFor(slot, [])
      },
    }

    const { relates: _relates, derivedFrom: _own, ...rest } = decl
    let replaced = mapDoc(rest, walk) as Record<string, unknown>
    // A schema that embeds a fact with several rows gets rows of its own, so each reader gets the schema of its row.
    const aligned = alignFact({
      id: decl.id,
      fact: replaced,
      slots,
      defs: (slot, picks) => defsFor(slot as BuildSlot, picks),
      say,
    })
    if (aligned) replaced = aligned.fact
    const refs = (out[entryIndex] as ResolvedEntry).refs
    for (const use of uses.values()) {
      refs.push({
        id: decl.id,
        target: use.target,
        ...(use.field !== undefined ? { field: use.field } : {}),
        asSchema: use.asSchema,
        ...(use.rows ? { rows: [...use.rows].flatMap((r) => aligned?.rows.get(r) ?? [r]).sort((a, b) => a - b) } : {}),
        location: where,
      })
    }
    return { ...replaced, ...(derivedFrom.length > 0 ? { derivedFrom } : {}) } as unknown as Fact
  }

  for (const [di, { entryIndex }] of decls.entries()) {
    ;((out[entryIndex] as ResolvedEntry).module.facts as unknown[]).push(resolveDecl(di))
  }
  return Object.assign(out, { ids: registry as FactIds })
}

/** Replaces the placeholders of `factLink` and `ref` in a text with the id of the fact, and `<id>#<field>` for a field. */
function idsInText(text: string, ids: FactIds, bad: (what: string) => void): string {
  return text.replace(TOKEN, (token) => {
    const found = token.startsWith('⟦fact-ref:')
      ? refTarget(token)
      : { fact: links().byToken.get(token), field: undefined }
    const id = found?.fact ? ids.get(found.fact)?.id : undefined
    if (id === undefined) {
      bad(token)
      return token
    }
    return found?.field !== undefined ? `${id}#${found.field}` : id
  })
}

const textIn = (text: unknown, ids: FactIds, bad: (what: string) => void): unknown =>
  typeof text === 'string'
    ? idsInText(text, ids, bad)
    : isObject(text)
      ? Object.fromEntries(
          Object.entries(text).map(([k, v]) => [k, typeof v === 'string' ? idsInText(v, ids, bad) : v]),
        )
      : text

/**
 * Turns the outcome of the scenarios of example groups into what the build writes. `ref(fact)` and
 * `ref(fact, 'a.b')` become `{ fact, field? }` and `statementFrom(fact, render)` becomes `{ fact, text }`, with the
 * id the fact has in `ids`. Everything else is kept as written, and the snippets in `code` are never run. A
 * reference to an object that is not a fact of this package is a `ref` problem.
 */
export function resolveExamples(
  groups: readonly unknown[],
  ids: FactIds,
  origin: string,
): { groups: unknown[]; problems: Problem[] } {
  const problems: Problem[] = []
  const out = groups.map((group) => {
    if (!isObject(group) || !Array.isArray(group.scenarios)) return group
    const scenarios = group.scenarios.map((scenario: unknown, si: number) => {
      if (!isObject(scenario) || !Array.isArray(scenario.outcome)) return scenario
      const outcome = scenario.outcome.map((item: unknown, oi: number): unknown => {
        const where = at(origin, `/scenarios/${si}/outcome/${oi}`)
        const report = (message: string) => problems.push({ code: 'ref', message, location: where })
        const unlisted = (what: string) =>
          report(`example outcome ${what} is a fact that is not listed in the \`facts\` of any entry of this package`)
        if (typeof item === 'string') {
          const t = WHOLE_REF.test(item) ? refTarget(item) : undefined
          if (t) {
            const id = ids.get(t.fact)?.id
            if (id === undefined) {
              unlisted('ref(...) points at')
              return item
            }
            return { fact: id, ...(t.field !== undefined ? { field: t.field } : {}) }
          }
          return idsInText(item, ids, (token) => unlisted(`text ${token} names`))
        }
        if (isBuilt(item)) {
          const { text, relates } = partsOf(item)
          if (relates.length !== 1) {
            report(
              `example outcome statement relates to ${relates.length} facts, and an outcome takes exactly one (use statementFrom)`,
            )
            return item
          }
          const id = ids.get(relates[0] as object)?.id
          if (id === undefined) {
            unlisted('statementFrom(...) reads from')
            return item
          }
          return { fact: id, text: textIn(text, ids, (token) => unlisted(`text ${token} names`)) }
        }
        if (isObject(item) && item.text !== undefined) {
          return { ...item, text: textIn(item.text, ids, (token) => unlisted(`text ${token} names`)) }
        }
        return item
      })
      return { ...scenario, outcome }
    })
    return { ...group, scenarios }
  })
  return { groups: out, problems }
}
