import { exampleFactRefs } from './examples.ts'
import type { ExampleGroup } from './examples.ts'
import type { Fact, FactIndex, Problem } from './types.ts'
import { validateExampleGroup, validateIndex, validateSchemaDocument } from './validate.ts'
import type { ValidationIssue } from './validate.ts'

/** One index to check, with the file it came from and the JSON Schema files shipped beside it. */
export interface IndexInput {
  /** Where it came from, used in messages. */
  origin: string
  index: unknown
  schemas?: { file: string; schema: unknown }[]
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
}

export interface CheckResult {
  problems: Problem[]
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
  const allowed = options.allowedDomains ?? []
  const doScan = options.scan !== false
  const idOrigin = new Map<string, string>()
  const replacements: { id: string; replacement: string; location: string }[] = []
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
        }
        if (typeof fact.tool === 'string' && !fact.id.startsWith(`${fact.tool}.`)) {
          problems.push({
            code: 'id-prefix',
            message: `fact id "${fact.id}" must start with its tool and a dot ("${fact.tool}.")`,
            location: at(file, `/facts/${i}/id`),
          })
        }
        if (typeof fact.when?.replacement === 'string') {
          replacements.push({
            id: fact.id,
            replacement: fact.when.replacement,
            location: at(file, `/facts/${i}/when/replacement`),
          })
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
    if (doScan) scan(input.index, file, allowed, problems)

    for (const s of input.schemas ?? []) {
      schemaCount++
      const label = `${file} schemas/${s.file}`
      problems.push(...formatProblems(validateSchemaDocument(s.schema), label))
      if (doScan) scan(s.schema, label, allowed, problems)
    }
  }

  for (const r of replacements) {
    if (!idOrigin.has(r.replacement)) {
      problems.push({
        code: 'unknown-fact-id',
        message: `${r.id}: replacement "${r.replacement}" is not a known fact id`,
        location: r.location,
      })
    }
  }

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
            message: `example references fact id "${ref.id}", which does not exist`,
            location: at(ex.origin, ref.location),
          })
        }
      }
    }
    if (doScan) scan(ex.group, ex.origin, allowed, problems)
  }

  return {
    problems,
    counts: { indexes: options.indexes.length, facts: factCount, schemas: schemaCount, examples: exampleCount },
  }
}
