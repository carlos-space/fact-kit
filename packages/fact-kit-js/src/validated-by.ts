import { dirname } from 'node:path'
import { schemaFileOfRef, walkRefs } from './check.ts'
import type { IndexInput } from './check.ts'
import { readSchemas } from './load.ts'
import { loadInstalledIndex } from './read.ts'
import type { Fact, FactIndex, Problem } from './types.ts'
import { validateAgainstSchema } from './validate.ts'

type SchemaFile = { file: string; schema: unknown }

/** A package entry whose facts a `validatedBy` can name, with the schema files shipped beside its index. */
interface Source {
  index: Partial<FactIndex>
  schemas: readonly SchemaFile[]
}

/** The facts of the indexes read for this run, found by spec, then the installed packages for specs nobody holds. */
class Sources {
  private readonly held = new Map<string, Source>()
  private readonly installed = new Map<string, Source | Error>()

  private readonly cwd: string

  constructor(indexes: readonly IndexInput[], cwd: string) {
    this.cwd = cwd
    for (const input of indexes) {
      const head = input.index as Partial<FactIndex> | null
      if (typeof head?.package !== 'string' || typeof head.entry !== 'string') continue
      const source = { index: head, schemas: input.schemas ?? [] }
      this.held.set(head.entry === '' ? head.package : `${head.package}/${head.entry}`, source)
    }
  }

  async get(spec: string): Promise<Source | Error> {
    const held = this.held.get(spec)
    if (held) return held
    const cached = this.installed.get(spec)
    if (cached) return cached
    let found: Source | Error
    try {
      const { index, file } = loadInstalledIndex(spec, this.cwd)
      found = { index, schemas: await readSchemas(dirname(file)) }
    } catch (error) {
      found = error as Error
    }
    this.installed.set(spec, found)
    return found
  }
}

/** The `schemas/<file>` documents a schema reaches through relative `$ref`s, or the reason one can not be read. */
function reachableFiles(schema: unknown, available: readonly SchemaFile[]): SchemaFile[] | string {
  const out = new Map<string, SchemaFile>()
  const queue: unknown[] = [schema]
  while (queue.length > 0) {
    for (const { ref } of walkRefs(queue.shift(), '')) {
      const file = schemaFileOfRef(ref)
      if (file === undefined || out.has(file)) continue
      // Stay inside `schemas/`: nothing outside that directory is read for a `$ref`.
      if (file.split('/').some((part) => part === '..' || part === '.' || part === '') || file.includes('\\')) {
        return `$ref "${ref}" points outside the schemas/ directory`
      }
      const found = available.find((s) => s.file === file)
      if (!found) return `$ref "${ref}" has no matching file under schemas/ of the named package`
      out.set(file, found)
      queue.push(found.schema)
    }
  }
  return [...out.values()]
}

/**
 * The `validated-by` rule: every value of a source fact that writes `validatedBy` must fit the `content.schema` of
 * the fact it names. The named package is read from `indexes` when one of them holds the spec, and from the
 * `node_modules` of `cwd` otherwise. Only `check` calls this, so `build` never fails on it.
 */
export async function validatedByProblems(indexes: readonly IndexInput[], cwd: string): Promise<Problem[]> {
  const problems: Problem[] = []
  const sources = new Sources(indexes, cwd)
  for (const input of indexes) {
    if (!input.source) continue
    const head = input.index as Partial<FactIndex> | null
    const facts = Array.isArray(head?.facts) ? head.facts : []
    for (const [i, raw] of facts.entries()) {
      const fact = raw as Partial<Fact> | null
      if (typeof fact?.id !== 'string' || typeof fact.validatedBy !== 'string') continue
      const where = `${input.origin}#/facts/${i}`
      const fail = (message: string, pointer = '/validatedBy') =>
        problems.push({ code: 'validated-by', message: `${fact.id}: ${message}`, location: `${where}${pointer}` })
      const location = fact.validatedBy
      const colon = location.lastIndexOf(':')
      const spec = colon === -1 ? undefined : location.slice(0, colon)
      const targetId = colon === -1 ? location : location.slice(colon + 1)

      const source =
        spec === undefined
          ? { index: head as Partial<FactIndex>, schemas: input.schemas ?? [] }
          : await sources.get(spec)
      if (source instanceof Error) {
        fail(`validatedBy "${location}" names package "${spec}", which can not be read: ${source.message}`)
        continue
      }
      const target = (source.index.facts ?? []).find((f) => f?.id === targetId)
      if (!target) {
        fail(`validatedBy "${location}": fact "${targetId}" does not exist${spec === undefined ? '' : ` in ${spec}`}`)
        continue
      }
      const schema = (target.content as { schema?: unknown } | undefined)?.schema
      if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        fail(`validatedBy "${location}": fact "${targetId}" has no schema in content.schema`)
        continue
      }
      const files = reachableFiles(schema, source.schemas)
      if (typeof files === 'string') {
        fail(`validatedBy "${location}": ${files}`)
        continue
      }

      const rows = Array.isArray(fact.variants)
        ? fact.variants.map((v, k) => ({ content: v?.content, pointer: `/variants/${k}/content` }))
        : [{ content: fact.content, pointer: '/content' }]
      for (const { content, pointer } of rows) {
        const value = (content as { value?: unknown } | undefined)?.value
        if (value === undefined) continue
        let issues
        try {
          issues = validateAgainstSchema(schema, value, files)
        } catch (error) {
          fail(
            `validatedBy "${location}": the schema of "${targetId}" can not be compiled (${(error as Error).message})`,
          )
          break
        }
        for (const issue of issues) {
          fail(
            `value${issue.pointer} (validatedBy "${location}"): ${issue.message}`,
            `${pointer}/value${issue.pointer}`,
          )
        }
      }
    }
  }
  return problems
}
