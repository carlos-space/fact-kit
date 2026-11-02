import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findIndexDirs, planAggregate } from './aggregate.ts'
import type { PlacedExamples } from './aggregate.ts'
import { readConfig } from './project.ts'
import { readPackageName } from './load.ts'
import { loadOxc } from './oxc.ts'
import type { ExampleGroup, ExampleScenario } from './examples.ts'
import type { OxcModule } from './oxc.ts'
import type { FactIndex } from './types.ts'

export interface Impact {
  /** The fact asked about, as given. */
  id: string
  /** The facts computed from it, directly (`depth` 1) or through other facts. `via` is the fact one step up. */
  facts: { id: string; depth: number; via: string }[]
  /** Where the docs directories refer to the fact or to one of those facts. */
  docs: { file: string; line: number; id: string }[]
  /**
   * The example scenarios that name the fact, or one of those facts. `spec` is the aggregate spec the
   * `examples.json` is published under, `group` the id of the example group, `scenario` the title of the scenario,
   * `id` the fact named, and `in` where it is named: `facts` for `facts` of the scenario or its group, `outcome`
   * for a reference in the outcome.
   */
  examples: { spec: string; group: string; scenario: string; id: string; in: 'facts' | 'outcome' }[]
}

export interface ImpactOptions {
  /** The aggregate package directory, holding `fact-kit.config.json`. Defaults to `process.cwd()`. */
  cwd?: string
  /** Config file path. Defaults to `fact-kit.config.json` in `cwd`. */
  configFile?: string
  /** Directory the components' indexes were built into. Defaults to `dist`. */
  outDir?: string
  /** Extractors for this call only. They run after the registered ones, and a name given twice keeps the last. */
  extractors?: readonly ImpactExtractor[]
}

/** Finds the references to a fact in one kind of file of `docsDirs`. */
export interface ImpactExtractor {
  /** The built-in extractors are `markdown` and `typescript`. One with the same name replaces the built-in. */
  name: string
  /** File extensions with the dot, such as `.mdx`. */
  extensions: readonly string[]
  /**
   * `lookup` returns the id to report for a reference to the fact asked about, or to a fact computed from it,
   * and undefined for any other.
   */
  extract(input: { file: string; text: string; lookup(reference: string): string | undefined }): {
    line: number
    id: string
  }[]
}

const registered = new Map<string, ImpactExtractor>()

/** Adds an extractor for the rest of the process. Returns a function that removes it. */
export function registerImpactExtractor(extractor: ImpactExtractor): () => void {
  registered.set(extractor.name, extractor)
  return () => {
    if (registered.get(extractor.name) === extractor) registered.delete(extractor.name)
  }
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist'])
const MARKDOWN = /\.(md|mdx|markdown)$/
const TYPESCRIPT = /\.(ts|mts|cts|tsx)$/
const READ_METHODS = new Set(['get', 'value', 'has'])

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      if (!item.name.startsWith('.') && !SKIPPED_DIRS.has(item.name)) yield* walkFiles(path)
    } else yield path
  }
}

/** A string literal's value, for a plain string or a template without substitutions. */
function stringValue(node: any): string | undefined {
  if (!node) return undefined
  if ((node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value?.cooked ?? undefined
  }
  return undefined
}

/** The string arguments of `get`, `value` and `has` calls, and the names imported, with their offsets. */
function scanProgram(program: unknown): {
  calls: { id: string; offset: number }[]
  imports: { name: string; source: string; offset: number }[]
} {
  const calls: { id: string; offset: number }[] = []
  const imports: { name: string; source: string; offset: number }[] = []
  const stack: unknown[] = [program]
  while (stack.length > 0) {
    const node = stack.pop() as any
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child)
      continue
    }
    if (!node || typeof node !== 'object') continue
    if (node.type === 'CallExpression') {
      const callee = node.callee
      const name =
        callee?.type === 'Identifier'
          ? callee.name
          : callee?.type === 'MemberExpression'
            ? callee.property?.name
            : undefined
      const id = READ_METHODS.has(name) ? stringValue(node.arguments?.[0]) : undefined
      if (id !== undefined) calls.push({ id, offset: node.arguments[0].start })
    } else if (node.type === 'ImportDeclaration') {
      const source = stringValue(node.source)
      if (source !== undefined && node.importKind !== 'type') {
        for (const s of node.specifiers ?? []) {
          if (s.type === 'ImportNamespaceSpecifier' || s.importKind === 'type') continue
          const name = s.type === 'ImportSpecifier' ? (s.imported?.name ?? s.imported?.value) : 'default'
          if (typeof name === 'string') imports.push({ name, source, offset: s.start })
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue
      const child = node[key]
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return { calls, imports }
}

/**
 * The value a named (or default) import of a relative module stands for, loaded the way `build` loads fact
 * sources. Undefined when the module cannot be resolved or run, or does not export the name.
 */
async function importedValue(file: string, source: string, name: string): Promise<unknown> {
  if (!source.startsWith('.') && !source.startsWith('/')) return undefined
  try {
    const mod = (await import(pathToFileURL(resolve(dirname(file), source)).href)) as Record<string, unknown>
    return mod[name]
  } catch {
    return undefined
  }
}

const isFactObject = (value: unknown): value is { id: string; title?: unknown } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { content?: unknown }).content === 'object'

const lineOf = (source: string, offset: number): number => {
  let line = 1
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

/** The indexes a package without `aggregate` built itself, `<outDir>/<entry>/index.json`, under their published spec. */
async function ownIndexes(cwd: string, outDir: string): Promise<{ spec: string; index: FactIndex }[]> {
  const root = join(cwd, outDir)
  const dirs = await findIndexDirs(root)
  if (dirs.length === 0) {
    throw new Error(`no built index under ${outDir}/ of ${cwd}. Build it first, or set "aggregate" in the config`)
  }
  const name = await readPackageName(cwd)
  const out: { spec: string; index: FactIndex }[] = []
  for (const dir of dirs) {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as FactIndex
    const entry = typeof index.entry === 'string' ? index.entry : relative(root, dir).split(sep).join('/')
    out.push({ spec: entry ? `${name}/${entry}` : name, index })
  }
  return out
}

/**
 * Finds what a change to the fact `id` reaches. `cwd` is an aggregate package: the built indexes of its
 * components give the facts, and `derivedFrom` gives the edges. `docsDirs` of the config are searched for
 * `fact:<id>` in markdown and for `get`, `value` and `has` calls with the id (and imports of the fact object)
 * in TypeScript. `id` is `<id>`, or `<spec>:<id>` with the published spec when several packages have the id.
 */
export async function impactOf(id: string, options: ImpactOptions = {}): Promise<Impact> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const outDir = options.outDir ?? 'dist'
  const config = await readConfig(cwd, options.configFile)
  let placed: { spec: string; index: FactIndex }[]
  let placedExamples: PlacedExamples[] = []
  if (config.aggregate) {
    const plan = await planAggregate(cwd, await readPackageName(cwd), config.aggregate, outDir)
    if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('\n'))
    placed = plan.placed
    placedExamples = plan.examples
  } else {
    placed = await ownIndexes(cwd, outDir)
  }

  // Node key: `<published spec>:<id>`.
  const keys = new Map<string, { spec: string; id: string }>()
  const downstream = new Map<string, string[]>()
  for (const p of placed) {
    for (const fact of p.index.facts) keys.set(`${p.spec}:${fact.id}`, { spec: p.spec, id: fact.id })
  }
  for (const p of placed) {
    for (const fact of p.index.facts) {
      for (const ref of fact.derivedFrom ?? []) {
        const upstream = ref.includes(':') ? ref : `${p.spec}:${ref}`
        const list = downstream.get(upstream) ?? []
        list.push(`${p.spec}:${fact.id}`)
        downstream.set(upstream, list)
      }
    }
  }

  const targets = [...keys.keys()].filter((k) => k === id || keys.get(k)?.id === id).sort()
  if (targets.length === 0) throw new Error(`no fact "${id}" in the indexes under ${outDir}/ of the components`)
  const targetSpecs = new Set(targets.map((k) => keys.get(k)?.spec))
  const show = (key: string): string => {
    const k = keys.get(key) ?? { spec: '', id: key }
    return targetSpecs.has(k.spec) ? k.id : key
  }

  const facts: Impact['facts'] = []
  const seen = new Set(targets)
  let frontier = targets
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = []
    for (const from of frontier) {
      for (const key of [...(downstream.get(from) ?? [])].sort()) {
        if (seen.has(key)) continue
        seen.add(key)
        next.push(key)
        facts.push({ id: show(key), depth, via: show(from) })
      }
    }
    frontier = next
  }

  // What the docs may name: the fact, and every fact computed from it. A bare id matches any spec.
  const byKey = new Map([...seen].map((k) => [k, show(k)]))
  const byId = new Map<string, string>()
  for (const k of seen) byId.set(keys.get(k)?.id ?? k, show(k))
  const lookup = (reference: string): string | undefined => byKey.get(reference) ?? byId.get(reference)

  const docs: Impact['docs'] = []
  const custom = new Map<string, ImpactExtractor>(registered)
  for (const e of options.extractors ?? []) custom.set(e.name, e)
  const extractors = [...custom.values()]
  const replaced = (name: string): boolean => custom.has(name)
  let oxc: OxcModule | undefined
  for (const dir of config.docsDirs ?? []) {
    const root = resolve(cwd, dir)
    for await (const file of walkFiles(root)) {
      const shown = relative(cwd, file).split(sep).join('/')
      const extension = extname(file)
      const matching = extractors.filter((e) => e.extensions.includes(extension))
      if (matching.length > 0) {
        const text = await readFile(file, 'utf8')
        for (const e of matching) {
          for (const found of await e.extract({ file: shown, text, lookup })) {
            docs.push({ file: shown, line: found.line, id: found.id })
          }
        }
      }
      if (MARKDOWN.test(file) && !replaced('markdown')) {
        const lines = (await readFile(file, 'utf8')).split('\n')
        for (const [i, text] of lines.entries()) {
          for (const m of text.matchAll(/fact:([^\s`'"()[\]<>,;]+)/g)) {
            const found = lookup((m[1] as string).replace(/[.:]+$/, ''))
            if (found !== undefined) docs.push({ file: shown, line: i + 1, id: found })
          }
        }
      } else if (TYPESCRIPT.test(file) && !file.endsWith('.d.ts') && !replaced('typescript')) {
        const source = await readFile(file, 'utf8')
        // Skip the parser for a file that neither imports anything nor names any of the facts.
        const wanted = [...seen].map((k) => keys.get(k)?.id ?? k)
        if (!source.includes('import') && !wanted.some((w) => source.includes(w))) continue
        oxc ??= await loadOxc()
        const parsed = oxc.parseSync(file, source)
        const { calls, imports } = scanProgram(parsed.program)
        for (const c of calls) {
          const found = lookup(c.id)
          if (found !== undefined) docs.push({ file: shown, line: lineOf(source, c.offset), id: found })
        }
        // An import counts when the module exports a fact object, whatever name it is imported under.
        for (const imp of imports) {
          const value = await importedValue(file, imp.source, imp.name)
          if (!isFactObject(value)) continue
          let hits = [...seen].filter((k) => keys.get(k)?.id === value.id)
          if (hits.length > 1) {
            const same = hits.filter((k) => {
              const owner = placed.find((p) => p.spec === keys.get(k)?.spec)
              return (
                JSON.stringify(owner?.index.facts.find((f) => f.id === value.id)?.title) === JSON.stringify(value.title)
              )
            })
            if (same.length > 0) hits = same
          }
          for (const k of hits) docs.push({ file: shown, line: lineOf(source, imp.offset), id: show(k) })
        }
      }
    }
  }
  const examples: Impact['examples'] = []
  for (const placed of placedExamples) {
    for (const group of placed.file.examples) {
      if (typeof group !== 'object' || group === null) continue
      const g = group as Partial<ExampleGroup>
      if (typeof g.id !== 'string' || !Array.isArray(g.scenarios)) continue
      for (const scenario of g.scenarios as ExampleScenario[]) {
        if (typeof scenario?.title !== 'string') continue
        // A reference in the `facts` of the group applies to each scenario of it.
        const names: { id: string; in: 'facts' | 'outcome' }[] = [
          ...(g.facts ?? []).map((id) => ({ id, in: 'facts' as const })),
          ...(scenario.facts ?? []).map((id) => ({ id, in: 'facts' as const })),
          ...(scenario.outcome ?? []).flatMap((item) =>
            typeof item === 'object' && item !== null && typeof item.fact === 'string'
              ? [{ id: item.fact, in: 'outcome' as const }]
              : [],
          ),
        ]
        for (const name of names) {
          const found = lookup(name.id)
          if (found === undefined) continue
          if (
            examples.some(
              (e) =>
                e.spec === placed.spec &&
                e.group === g.id &&
                e.scenario === scenario.title &&
                e.id === found &&
                e.in === name.in,
            )
          )
            continue
          examples.push({ spec: placed.spec, group: g.id, scenario: scenario.title, id: found, in: name.in })
        }
      }
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  examples.sort(
    (a, b) =>
      order(a.spec, b.spec) ||
      order(a.group, b.group) ||
      order(a.scenario, b.scenario) ||
      order(a.id, b.id) ||
      order(a.in, b.in),
  )
  docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.id < b.id ? -1 : 1)))
  return { id, facts, docs, examples }
}
