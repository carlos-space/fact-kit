import { exampleFactRefs } from './examples.ts'
import type { ExampleGroup } from './examples.ts'
import { ambiguousRows, factRows, topLevelContent } from './select.ts'
import { contentFieldProblem, refProblems } from './refs.ts'
import { subschemas } from './schema-walk.ts'
import { subsetProblems } from './subset.ts'
import type { RefDecl } from './author.ts'
import type { SubsetInput } from './subset.ts'
import type { Fact, FactIndex, Problem } from './types.ts'
import { compareVersions, parseVersion, sinceIssue } from './version.ts'
import { validateExampleGroup, validateIndex, validateSchemaDocument } from './validate.ts'
import type { ValidationIssue } from './validate.ts'

/** One index to check, with the file it came from and the JSON Schema files shipped beside it. */
export interface IndexInput {
  /** Where it came from, used in messages. */
  origin: string
  index: unknown
  schemas?: { file: string; schema: unknown }[]
  /**
   * Built from this package's own fact sources, not read from a published index. Only these get the `describes`
   * rule, because a published index of format 1.0 may describe several products.
   */
  source?: boolean
  /** Lists that `subsetOf` keeps inside the list of another fact. Only a source has them, because the index has no place for them. */
  subsets?: readonly SubsetInput[]
  /** The `ref`s the facts write. Only a source has them, because the index has no place for them. */
  refs?: readonly RefDecl[]
}

export interface ExampleInput {
  origin: string
  group: unknown
}

export interface CheckOptions {
  indexes: readonly IndexInput[]
  examples?: readonly ExampleInput[]
  /**
   * Hosts that URLs in facts may point at. A host passes when it equals an entry or is a subdomain of one,
   * so `example.com` allows `docs.example.com`. With no entries every URL host is reported.
   */
  allowedDomains?: readonly string[]
  /** Set to false to skip the path and domain scan, as `build` does. Defaults to true. */
  scan?: boolean
  /**
   * Set to false to skip the rules about a release (`since-ahead`, `train-next`, `pending-untested`), as `build`
   * does. On a release branch `since` is ahead of `describes`, so building must not depend on them.
   */
  strict?: boolean
  /** Component -> version of the train being released. `since` up to that version is allowed, and `next` is not. */
  train?: Readonly<Record<string, string>>
  /** The labels some test includes. With it, a `pending` label that is not in the set is reported. */
  pendingTested?: ReadonlySet<string>
}

export interface CheckResult {
  problems: Problem[]
  /** Things worth a look that do not fail the check. */
  warnings: Problem[]
  /** How many facts, examples and schema files were looked at. */
  counts: { indexes: number; facts: number; schemas: number; examples: number }
}

// --- scanning for things that must not ship ---------------------------------------------------------
const PATH_PATTERNS: RegExp[] = [
  // Unix home and system user directories. A leading word character, dot or slash means it is part of a URL or a relative path.
  /(?<![\w.~:/-])\/(?:Users|home|root)\/[^\s"'`<>)\]]*/g,
  /(?<![\w.~:/-])\/(?:private\/var|var\/folders)\/[^\s"'`<>)\]]*/g,
  // Windows drive paths: C:\ or C:/Users.
  /(?<![\w])[A-Za-z]:\\[^\s"'`<>)\]]*/g,
  /(?<![\w])[A-Za-z]:\/(?:Users|Windows|Program Files)[^\s"'`<>)\]]*/g,
  // file:// URLs always point at a local file.
  /\bfile:\/\/\/?[^\s"'`<>)\]]*/gi,
]

/** Local absolute paths found in one string. */
export function findLocalPaths(text: string): string[] {
  const found: string[] = []
  for (const re of PATH_PATTERNS) for (const m of text.matchAll(re)) found.push(m[0])
  return found
}

const URL_RE = /\b(?:https?|ftp|wss?|ssh|git):\/\/(?:[^\s/@"'<>]*@)?([^\s/:?#"'<>)\]\\]+)/gi

/** Hosts of the URLs in one string. Placeholders such as `<host>` or `${HOST}` are skipped. */
export function findUrlHosts(text: string): string[] {
  const hosts: string[] = []
  for (const m of text.matchAll(URL_RE)) {
    const host = (m[1] ?? '').toLowerCase().replace(/\.$/, '')
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) hosts.push(host)
  }
  return hosts
}

export function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const a = entry.toLowerCase()
    return host === a || host.endsWith(`.${a}`)
  })
}

function* walkStrings(value: unknown, pointer: string): Generator<{ text: string; pointer: string }> {
  if (typeof value === 'string') {
    yield { text: value, pointer }
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walkStrings(item, `${pointer}/${i}`)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield { text: key, pointer: `${pointer}/${key}` }
      yield* walkStrings(item, `${pointer}/${key}`)
    }
  }
}

function scan(value: unknown, file: string, allowed: readonly string[], out: Problem[]): void {
  for (const { text, pointer } of walkStrings(value, '')) {
    for (const p of findLocalPaths(text)) {
      out.push({ code: 'local-path', message: `local absolute path "${p}"`, location: `${file}#${pointer}` })
    }
    for (const host of findUrlHosts(text)) {
      if (!isAllowedHost(host, allowed)) {
        out.push({
          code: 'unregistered-domain',
          message: `domain "${host}" is not in the allowed domains`,
          location: `${file}#${pointer}`,
        })
      }
    }
  }
}

/** Rows of one fact: `since` forms, rows a reader can not tell apart, and a top-level content that is a guess. */
function checkRows(fact: Fact, location: string, problems: Problem[], warnings: Problem[]): void {
  let valid = true
  const sinceOf = (since: unknown, pointer: string) => {
    if (since === undefined) return
    const issue = sinceIssue(since as never)
    if (issue) {
      valid = false
      problems.push({
        code: issue.code,
        message: `${fact.id}: since ${issue.message}`,
        location: `${location}${pointer}`,
      })
    }
  }
  sinceOf(fact.when?.since, '/when/since')
  const variants = Array.isArray(fact.variants) ? fact.variants : []
  for (const [k, v] of variants.entries()) sinceOf((v as { since?: unknown } | null)?.since, `/variants/${k}/since`)
  if (!valid || variants.length === 0) return
  const pair = ambiguousRows(fact)
  if (pair) {
    problems.push({
      code: 'ambiguous-rows',
      message: `${fact.id}: variants ${pair[0]} and ${pair[1]} apply to the same readers with the same bound and conditions, so the reader can not choose`,
      location: `${location}/variants/${pair[1]}`,
    })
  }
  if (topLevelContent(fact)?.tier === 3) {
    warnings.push({
      code: 'top-level-content',
      message: `${fact.id}: no row applies to a reader that names no platform, so the top-level content is the row with the largest bound`,
      location: `${location}/content`,
    })
  }
}

// --- rules about a release ----------------------------------------------------------------------------
/** The component a package's facts describe: the one key of `describes`, else the package name without scope and `-facts`. */
export function componentOf(index: Partial<FactIndex> | null | undefined): string | undefined {
  const keys = Object.keys(index?.describes ?? {})
  if (keys.length === 1) return keys[0]
  if (keys.length > 1 || typeof index?.package !== 'string') return undefined
  return index.package.replace(/^@[^/]+\//, '').replace(/-facts$/, '')
}

/** Every `since` of a fact with where it is and whether its row is `pending`. */
function sinceOfRows(fact: Partial<Fact>): { since: unknown; pointer: string; pending: boolean }[] {
  const out: { since: unknown; pointer: string; pending: boolean }[] = []
  if (fact.when?.since !== undefined) out.push({ since: fact.when.since, pointer: '/when/since', pending: false })
  for (const [k, v] of (Array.isArray(fact.variants) ? fact.variants : []).entries()) {
    const row = v as { since?: unknown; pending?: unknown } | null
    if (row && row.since !== undefined) {
      out.push({ since: row.since, pointer: `/variants/${k}/since`, pending: row.pending !== undefined })
    }
  }
  return out
}

function versionsOf(since: unknown): string[] {
  const list = Array.isArray(since) ? since : [since]
  return list.filter((v): v is string => typeof v === 'string' && v !== 'next' && parseVersion(v) !== undefined)
}

const endsWithNext = (since: unknown): boolean => since === 'next' || (Array.isArray(since) && since.at(-1) === 'next')

function releaseRules(
  index: Partial<FactIndex> | null | undefined,
  file: string,
  options: CheckOptions,
  problems: Problem[],
): void {
  const facts = Array.isArray(index?.facts) ? index.facts : []
  const component = componentOf(index)
  const described = Object.entries(index?.describes ?? {})
  const describedVersion = described.length === 1 ? described[0]?.[1] : undefined
  const trainVersion = component !== undefined ? options.train?.[component] : undefined
  // On the train, `since` may be as new as the version being released.
  let limit = typeof describedVersion === 'string' && parseVersion(describedVersion) ? describedVersion : undefined
  if (
    trainVersion !== undefined &&
    parseVersion(trainVersion) &&
    (!limit || compareVersions(trainVersion, limit) > 0)
  ) {
    limit = trainVersion
  }
  for (const [i, raw] of facts.entries()) {
    const fact = raw as Partial<Fact> | null
    if (!fact || typeof fact.id !== 'string') continue
    for (const row of sinceOfRows(fact)) {
      const location = at(file, `/facts/${i}${row.pointer}`)
      if (limit !== undefined) {
        for (const version of versionsOf(row.since)) {
          if (compareVersions(version, limit) > 0) {
            problems.push({
              code: 'since-ahead',
              message: `${fact.id}: since ${version} is newer than ${component} ${limit}${limit === trainVersion ? ' (the train)' : ' (describes)'}. Pin to a released version or use "next"`,
              location,
            })
          }
        }
      }
      if (trainVersion !== undefined && !row.pending && endsWithNext(row.since)) {
        problems.push({
          code: 'train-next',
          message: `${fact.id}: ${component} is released as ${trainVersion}, but this row still starts at "next". Run pin first`,
          location,
        })
      }
    }
    if (options.pendingTested) {
      for (const [k, v] of (Array.isArray(fact.variants) ? fact.variants : []).entries()) {
        const label = (v as { pending?: unknown } | null)?.pending
        if (typeof label === 'string' && !options.pendingTested.has(label)) {
          problems.push({
            code: 'pending-untested',
            message: `${fact.id}: no test includes the pending label "${label}", so nothing checks the row. Pass it as include in a test under testDirs`,
            location: at(file, `/facts/${i}/variants/${k}/pending`),
          })
        }
      }
    }
  }
}

/** Cycles in the graph of `derivedFrom`, each reported once. `edges` maps a fact id to the ids it is derived from. */
function findCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, 'open' | 'done'>()
  const cycles: string[][] = []
  const seen = new Set<string>()
  const path: string[] = []
  const visit = (id: string): void => {
    state.set(id, 'open')
    path.push(id)
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 'open') {
        const cycle = path.slice(path.indexOf(next))
        const key = [...cycle].sort().join('\0')
        if (!seen.has(key)) {
          seen.add(key)
          cycles.push([...cycle, next])
        }
      } else if (!state.has(next)) {
        visit(next)
      }
    }
    path.pop()
    state.set(id, 'done')
  }
  for (const id of edges.keys()) if (!state.has(id)) visit(id)
  return cycles
}

// --- the check --------------------------------------------------------------------------------------
const at = (file: string, pointer: string) => (pointer ? `${file}#${pointer}` : file)

function formatProblems(issues: ValidationIssue[], file: string): Problem[] {
  return issues.map((i) => ({ code: 'format', message: i.message, location: at(file, i.pointer) }))
}

function* walkRefs(value: unknown, pointer: string): Generator<{ ref: string; pointer: string }> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walkRefs(item, `${pointer}/${i}`)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') yield { ref: item, pointer: `${pointer}/$ref` }
      else if (key !== 'const' && key !== 'enum' && key !== 'default' && key !== 'examples') {
        yield* walkRefs(item, `${pointer}/${key}`)
      }
    }
  }
}

/** The fields `x-identity` names that the same schema has no property for, one problem per subschema. */
function identityProblems(schema: unknown, base: string, who: string, file: string): Problem[] {
  const out: Problem[] = []
  for (const { schema: sub, pointer } of subschemas(schema, base)) {
    const named = sub['x-identity']
    const names = (Array.isArray(named) ? named : [named]).filter((n): n is string => typeof n === 'string')
    if (names.length === 0) continue
    const properties = sub.properties
    const known =
      typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? Object.keys(properties) : []
    const missing = names.filter((n) => !known.includes(n))
    if (missing.length > 0) {
      out.push({
        code: 'schema-property',
        message: `${who}: x-identity names ${missing.map((n) => `"${n}"`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the properties of the same schema (${known.length > 0 ? known.join(', ') : 'it has none'})`,
        location: `${file}#${pointer}/x-identity`,
      })
    }
  }
  return out
}

/** The `schemas/<file>` part of a relative `$ref`, or undefined when the ref points elsewhere. */
export function schemaFileOfRef(ref: string): string | undefined {
  const m = /^(?:\.\/)?schemas\/([^#]+)(?:#.*)?$/.exec(ref)
  return m?.[1]
}

/**
 * Checks fact indexes and examples. This is a pure function over already-loaded data, so the same code
 * serves the CLI, the build and tests.
 */
export function checkFacts(options: CheckOptions): CheckResult {
  const problems: Problem[] = []
  const warnings: Problem[] = []
  const allowed = options.allowedDomains ?? []
  const doScan = options.scan !== false
  const idOrigin = new Map<string, string>()
  const factById = new Map<string, Fact>()
  const references: { id: string; field: string; target: string; spec?: string; location: string }[] = []
  let component: { name: string | null; file: string } | undefined
  let publishOf: { text: string | null; file: string } | undefined
  const strict = options.strict !== false
  const specs = new Set<string>()
  const edges = new Map<string, string[]>()
  let factCount = 0
  let schemaCount = 0

  for (const input of options.indexes) {
    const file = input.origin
    const issues = validateIndex(input.index)
    for (const p of formatProblems(issues, file)) {
      // Name the fact in the message when the pointer is inside /facts/<n>.
      const m = /#\/facts\/(\d+)/.exec(p.location ?? '')
      const facts = (input.index as { facts?: unknown }).facts
      const fact = m && Array.isArray(facts) ? (facts[Number(m[1])] as { id?: unknown } | undefined) : undefined
      problems.push(typeof fact?.id === 'string' ? { ...p, message: `${fact.id}: ${p.message}` } : p)
    }

    const facts = (input.index as Partial<FactIndex> | null)?.facts
    const head = input.index as Partial<FactIndex> | null
    if (typeof head?.package === 'string' && typeof head.entry === 'string') specs.add(`${head.package}/${head.entry}`)
    if (Array.isArray(facts)) {
      for (const [i, raw] of facts.entries()) {
        const fact = raw as Partial<Fact>
        factCount++
        if (typeof fact.id !== 'string') continue
        const prior = idOrigin.get(fact.id)
        if (prior !== undefined) {
          problems.push({
            code: 'duplicate-id',
            message: `duplicate fact id "${fact.id}" (also in ${prior})`,
            location: at(file, `/facts/${i}/id`),
          })
        } else {
          idOrigin.set(fact.id, at(file, `/facts/${i}`))
          factById.set(fact.id, fact as Fact)
        }
        if (typeof fact.tool === 'string' && !fact.id.startsWith(`${fact.tool}.`)) {
          problems.push({
            code: 'id-prefix',
            message: `fact id "${fact.id}" must start with its tool and a dot ("${fact.tool}.")`,
            location: at(file, `/facts/${i}/id`),
          })
        }
        const replacement = fact.when?.replacement
        for (const [k, target] of (Array.isArray(replacement) ? replacement : [replacement]).entries()) {
          if (typeof target !== 'string') continue
          const pointer = Array.isArray(replacement)
            ? `/facts/${i}/when/replacement/${k}`
            : `/facts/${i}/when/replacement`
          references.push({ id: fact.id, field: 'replacement', target, location: at(file, pointer) })
        }
        // A location with a colon points into another package or entry. It is checked when that entry is one of
        // the indexes here, and left alone otherwise.
        const derivedFrom = Array.isArray(fact.derivedFrom) ? fact.derivedFrom : []
        const dependsOn: string[] = []
        for (const [k, target] of derivedFrom.entries()) {
          if (typeof target !== 'string') continue
          const colon = target.lastIndexOf(':')
          const spec = colon === -1 ? undefined : target.slice(0, colon)
          references.push({
            id: fact.id,
            field: 'derivedFrom',
            target: colon === -1 ? target : target.slice(colon + 1),
            ...(spec !== undefined ? { spec } : {}),
            location: at(file, `/facts/${i}/derivedFrom/${k}`),
          })
          dependsOn.push(target)
        }
        edges.set(fact.id, dependsOn)
        checkRows(fact as Fact, at(file, `/facts/${i}`), problems, warnings)
        const rowContents = [
          // With rows, the top-level content only repeats one of them.
          ...(Array.isArray(fact.variants) ? [] : [{ content: fact.content, pointer: `/facts/${i}/content` }]),
          ...(Array.isArray(fact.variants) ? fact.variants : []).map((v, k) => ({
            content: (v as { content?: unknown } | null)?.content,
            pointer: `/facts/${i}/variants/${k}/content`,
          })),
        ]
        for (const { content, pointer } of rowContents) {
          const schema = (content as { schema?: unknown } | undefined)?.schema
          if (schema !== undefined) problems.push(...identityProblems(schema, `${pointer}/schema`, fact.id, file))
        }
        // Inline schemas may $ref a file under schemas/.
        const shipped = new Set((input.schemas ?? []).map((s) => s.file))
        const inline = (fact.content as { schema?: unknown } | undefined)?.schema
        if (inline !== undefined) {
          for (const { ref, pointer } of walkRefs(inline, `/facts/${i}/content/schema`)) {
            const target = schemaFileOfRef(ref)
            if (target !== undefined && !shipped.has(target)) {
              problems.push({
                code: 'missing-schema-file',
                message: `${fact.id}: $ref "${ref}" has no matching file under schemas/`,
                location: at(file, pointer),
              })
            }
          }
        }
      }
    }
    if (input.source && strict) releaseRules(input.index as Partial<FactIndex> | null, file, options, problems)
    if (input.source) {
      const describes = (input.index as Partial<FactIndex> | null)?.describes
      const keys = describes && typeof describes === 'object' ? Object.keys(describes) : []
      if (describes && typeof describes === 'object') {
        // `{}` says the described thing has no version. Every entry of a package must agree.
        const name = keys[0] ?? null
        const show = (n: string | null) => (n === null ? 'nothing ({})' : `"${n}"`)
        if (keys.length > 1) {
          problems.push({
            code: 'describes',
            message: `describes must name at most one component, and this one names ${keys.length} (${keys.join(', ')})`,
            location: at(file, '/describes'),
          })
        } else if (component && component.name !== name) {
          problems.push({
            code: 'describes',
            message: `describes ${show(name)}, but ${component.file} of the same package describes ${show(component.name)}`,
            location: at(file, '/describes'),
          })
        } else if (!component) {
          component = { name, file }
        }
      }
    }
    if (input.source) {
      // Every entry of a package is published as one thing, so they must agree on `publish`, absent included.
      const publish = (input.index as Partial<FactIndex> | null)?.publish
      const text = publish === undefined || publish === null ? null : JSON.stringify([publish.target, publish.name])
      if (publishOf && publishOf.text !== text) {
        const show = (t: string | null) => (t === null ? 'no publish' : `publish ${t}`)
        problems.push({
          code: 'publish',
          message: `${file} has ${show(text)}, but ${publishOf.file} of the same package has ${show(publishOf.text)}`,
          location: at(file, '/publish'),
        })
      } else if (!publishOf) {
        publishOf = { text, file }
      }
    }
    if (doScan) scan(input.index, file, allowed, problems)

    for (const s of input.schemas ?? []) {
      schemaCount++
      const label = `${file} schemas/${s.file}`
      problems.push(...formatProblems(validateSchemaDocument(s.schema), label))
      problems.push(...identityProblems(s.schema, '', `schemas/${s.file}`, label))
      if (doScan) scan(s.schema, label, allowed, problems)
    }
  }

  for (const r of references) {
    // A location in an entry that was not loaded here can not be checked.
    if (r.spec !== undefined && !specs.has(r.spec)) continue
    if (!idOrigin.has(r.target)) {
      problems.push({
        code: 'unknown-fact-id',
        message: `${r.id}: ${r.field} "${r.spec !== undefined ? `${r.spec}:` : ''}${r.target}" is not a known fact id`,
        location: r.location,
      })
    }
  }

  // A fact derived from itself, through any number of others.
  const graph = new Map<string, string[]>()
  for (const [id, targets] of edges) {
    graph.set(
      id,
      targets.flatMap((t) => {
        const colon = t.lastIndexOf(':')
        if (colon === -1) return [t]
        return specs.has(t.slice(0, colon)) ? [t.slice(colon + 1)] : []
      }),
    )
  }
  for (const cycle of findCycles(graph)) {
    const first = cycle[0] as string
    problems.push({
      code: 'relation-cycle',
      message: `facts derived from each other in a loop: ${cycle.join(' -> ')}`,
      location: `${idOrigin.get(first) ?? first}/derivedFrom`,
    })
  }

  problems.push(...subsetProblems(options.indexes))
  problems.push(...refProblems(options.indexes))

  let exampleCount = 0
  for (const ex of options.examples ?? []) {
    exampleCount++
    const issues = validateExampleGroup(ex.group)
    problems.push(...formatProblems(issues, ex.origin))
    if (issues.length === 0) {
      for (const ref of exampleFactRefs(ex.group as ExampleGroup)) {
        if (!idOrigin.has(ref.id)) {
          problems.push({
            code: 'unknown-fact-id',
            message: `example ${ref.in === 'outcome' ? 'outcome ' : ''}references fact id "${ref.id}", which does not exist`,
            location: at(ex.origin, ref.location),
          })
        } else if (ref.field !== undefined) {
          // The field has to be in at least one row, because an example does not say which version it shows.
          const target = factById.get(ref.id) as Fact
          const whys = factRows(target).map((row) => contentFieldProblem(row.content, ref.field as string))
          if (whys.length > 0 && whys.every((why) => why !== undefined)) {
            problems.push({
              code: 'ref',
              message: `example outcome names the field "${ref.field}" of ${ref.id}, and no row of the fact has it: ${whys[0]}`,
              location: at(ex.origin, ref.location),
            })
          }
        }
      }
    }
    if (doScan) scan(ex.group, ex.origin, allowed, problems)
  }

  return {
    problems,
    warnings,
    counts: { indexes: options.indexes.length, facts: factCount, schemas: schemaCount, examples: exampleCount },
  }
}
