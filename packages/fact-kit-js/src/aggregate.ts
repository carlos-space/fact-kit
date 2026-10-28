import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { checkFacts } from './check.ts'
import type { IndexInput } from './check.ts'
import type { Fact, FactIndex, Problem } from './types.ts'

/** One index of a component package, placed in the aggregate package. */
export interface PlacedIndex {
  /** The component package name, e.g. `fact-kit-facts.npm`. */
  component: string
  /** The aggregate sub-path the component hangs on, `.` for the root. */
  subpath: string
  /** Directory of the component's built index, absolute. */
  sourceDir: string
  /** The entry in the component, e.g. `fact-kit`. */
  entry: string
  /** Where the index goes in the aggregate package, relative to the out dir. Empty for the root. */
  dir: string
  /** What a consumer passes to `readFacts`: the aggregate name, plus `/<dir>` when `dir` is not empty. */
  spec: string
  /** The index as published: `package`, `entry`, `component` and the fact locations are rewritten. */
  index: FactIndex
  schemas: { file: string; schema: unknown }[]
}

/** The `examples.json` of a component package, placed in the aggregate package. */
export interface PlacedExamples {
  component: string
  subpath: string
  /** Where the file goes in the aggregate package, relative to the out dir. Empty for the root. */
  dir: string
  /** What `fact-kit diff --impact` shows for the examples: the aggregate name, plus `/<dir>` when `dir` is not empty. */
  spec: string
  /** The file as published: `package` is the aggregate name. */
  file: { package: string; examples: unknown[] }
}

export interface AggregatePlan {
  aggregate: string
  placed: PlacedIndex[]
  /** The examples of the components, one file for each component that built any. */
  examples: PlacedExamples[]
  problems: Problem[]
}

/** Finds `node_modules/<name>` going up from `cwd`, the way Node resolves a dependency. */
export async function resolveComponent(cwd: string, name: string): Promise<string | undefined> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    try {
      return await realpath(candidate)
    } catch {
      // not here, keep going up
    }
    if (dir === dirname(dir)) return undefined
  }
}

/** Directories under `root` that hold an `index.json`, not looking inside `schemas`. */
async function findIndexDirs(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (items.some((i) => i.isFile() && i.name === 'index.json')) found.push(dir)
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory() && item.name !== 'schemas' && item.name !== 'node_modules')
        await walk(join(dir, item.name))
    }
  }
  await walk(root)
  return found
}

async function readSchemaFiles(dir: string): Promise<PlacedIndex['schemas']> {
  const root = join(dir, 'schemas')
  const out: PlacedIndex['schemas'] = []
  async function walk(current: string): Promise<void> {
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.name.endsWith('.json')) {
        out.push({ file: relative(root, path).split(sep).join('/'), schema: JSON.parse(await readFile(path, 'utf8')) })
      }
    }
  }
  await walk(root)
  return out
}

/**
 * Reads the built indexes of every component in `aggregate` and works out where each one goes. `cwd` is the
 * aggregate package, and a component is found as a dependency under its `node_modules`. A component whose
 * `<outDir>` holds no index is a problem: build it first.
 */
export async function planAggregate(
  cwd: string,
  aggregateName: string,
  aggregate: Record<string, string>,
  outDir: string,
): Promise<AggregatePlan> {
  const problems: Problem[] = []
  const placed: PlacedIndex[] = []
  const examples: PlacedExamples[] = []
  const found: { component: string; subpath: string; sourceDir: string; entry: string; index: FactIndex }[] = []

  for (const [subpath, component] of Object.entries(aggregate)) {
    if (subpath !== '.' && (subpath.startsWith('/') || subpath.endsWith('/') || subpath.split('/').includes('..'))) {
      problems.push({ code: 'load', message: `aggregate: "${subpath}" is not a sub-path of this package` })
      continue
    }
    const root = await resolveComponent(cwd, component)
    if (!root) {
      problems.push({
        code: 'load',
        message: `aggregate: cannot find "${component}" for "${subpath}". List it in devDependencies ("workspace:*") and install.`,
      })
      continue
    }
    const dirs = await findIndexDirs(join(root, outDir))
    if (dirs.length === 0) {
      problems.push({
        code: 'load',
        message: `aggregate: "${component}" has no built index under ${outDir}/. Build it first.`,
        location: root,
      })
      continue
    }
    // The examples of a component hang on the sub-path itself, whatever number of entries it has.
    const exampleFile = join(root, outDir, 'examples.json')
    const exampleText = await readFile(exampleFile, 'utf8').catch(() => undefined)
    if (exampleText !== undefined) {
      let parsed: { examples?: unknown }
      try {
        parsed = JSON.parse(exampleText) as { examples?: unknown }
      } catch (error) {
        problems.push({
          code: 'load',
          message: `aggregate: cannot read ${exampleFile}: ${(error as Error).message}`,
        })
        continue
      }
      const dir = subpath === '.' ? '' : subpath
      examples.push({
        component,
        subpath,
        dir,
        spec: dir ? `${aggregateName}/${dir}` : aggregateName,
        file: { package: aggregateName, examples: Array.isArray(parsed.examples) ? parsed.examples : [] },
      })
    }
    for (const sourceDir of dirs) {
      const index = JSON.parse(await readFile(join(sourceDir, 'index.json'), 'utf8')) as FactIndex
      const entry =
        typeof index.entry === 'string' ? index.entry : relative(join(root, outDir), sourceDir).split(sep).join('/')
      found.push({ component, subpath, sourceDir, entry, index })
    }
  }
  if (problems.length > 0) return { aggregate: aggregateName, placed, examples, problems }

  const count = new Map<string, number>()
  for (const f of found) count.set(f.component, (count.get(f.component) ?? 0) + 1)
  const owners = new Map<string, string>()
  const hasRoot = found.some((f) => f.subpath === '.')
  for (const f of found) {
    const base = f.subpath === '.' ? '' : f.subpath
    const dir = count.get(f.component) === 1 ? base : [base, f.entry].filter(Boolean).join('/')
    const who = `"${f.component}" (sub-path "${f.subpath}", entry "${f.entry}")`
    const clash = owners.get(dir)
    if (clash !== undefined) {
      problems.push({
        code: 'load',
        message: `aggregate: the name "${dir || '.'}" is taken by both ${clash} and ${who}`,
      })
    }
    if (hasRoot && (dir === 'schemas' || dir.startsWith('schemas/'))) {
      problems.push({
        code: 'load',
        message: `aggregate: the name "${dir}" is taken by the root schemas/ directory (${who})`,
      })
    }
    owners.set(dir, who)
    placed.push({
      component: f.component,
      subpath: f.subpath,
      sourceDir: f.sourceDir,
      entry: f.entry,
      dir,
      spec: dir ? `${aggregateName}/${dir}` : aggregateName,
      index: f.index,
      schemas: await readSchemaFiles(f.sourceDir),
    })
  }
  if (problems.length > 0) return { aggregate: aggregateName, placed, examples, problems }

  // A component writes a location in another component with that component's package name (and entry). In the
  // published index it is the aggregate spec, and a location in the same index is a bare id again.
  const published = new Map<string, string>()
  for (const p of placed) {
    published.set(`${p.component}/${p.entry}`, p.spec)
    if (count.get(p.component) === 1) published.set(p.component, p.spec)
  }
  for (const p of placed) {
    const rewrite = (location: string): string => {
      const at = location.lastIndexOf(':')
      if (at === -1) return location
      const spec = published.get(location.slice(0, at))
      if (spec === undefined) return location
      return spec === p.spec ? location.slice(at + 1) : `${spec}:${location.slice(at + 1)}`
    }
    // `factLink` writes a location inside a sentence of the content. It is rewritten the same way.
    const keys = [...published.keys()]
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const inText = keys.length > 0 ? new RegExp(`(?<![\\w@/.-])(${keys.join('|')}):(?=[a-z0-9])`, 'g') : undefined
    const rewriteText = (text: string): string =>
      inText
        ? text.replace(inText, (_m, key: string) => (published.get(key) === p.spec ? '' : `${published.get(key)}:`))
        : text
    const { indexFormat, package: _package, entry: _entry, ...rest } = p.index
    p.index = {
      ...(indexFormat !== undefined ? { indexFormat } : {}),
      package: aggregateName,
      entry: p.dir || '.',
      component: p.component,
      ...rest,
      facts: p.index.facts.map((fact) =>
        rewriteFact(fact, rewrite, (spec) => published.get(spec) ?? spec, rewriteText),
      ),
    } as FactIndex
  }
  return { aggregate: aggregateName, placed, examples, problems }
}

/** Copy of `value` with every string passed through `fn`. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
  }
  return value
}

function rewriteFact(
  fact: Fact,
  rewrite: (location: string) => string,
  rewriteSpec: (spec: string) => string,
  rewriteText: (text: string) => string,
): Fact {
  const out = { ...fact } as Fact & Record<string, unknown>
  for (const key of ['title', 'description', 'content', 'variants'] as const) {
    if (fact[key] !== undefined) out[key] = mapStrings(fact[key], rewriteText) as never
  }
  // A derived fact names its upstream by spec. That spec is published under the aggregate name too.
  if (fact.source?.kind === 'derived') out.source = { ...fact.source, from: rewriteSpec(fact.source.from) }
  if (Array.isArray(fact.derivedFrom)) out.derivedFrom = fact.derivedFrom.map(rewrite)
  if (typeof fact.when?.movedTo === 'string') out.when = { ...fact.when, movedTo: rewrite(fact.when.movedTo) }
  return out
}

/** The `exports` map the aggregate package.json needs for these indexes. */
export function aggregateExports(
  placed: readonly PlacedIndex[],
  outDir: string,
  examples: readonly Pick<PlacedExamples, 'dir'>[] = [],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const x of examples) {
    out[x.dir ? `./${x.dir}/examples.json` : './examples.json'] = `./${outDir}/${x.dir ? `${x.dir}/` : ''}examples.json`
  }
  for (const p of placed) {
    const key = p.dir ? `./${p.dir}` : '.'
    const root = key === '.' ? '' : `${key.slice(2)}/`
    out[key === '.' ? './index.json' : `${key}/index.json`] = `./${outDir}/${root}index.json`
    out[key === '.' ? './schemas/*' : `${key}/schemas/*`] = `./${outDir}/${root}schemas/*`
  }
  return out
}

/** Checks the placed indexes and writes them under `<cwd>/<outDir>`. Returns the files written, relative to `cwd`. */
export async function writeAggregate(
  cwd: string,
  outDir: string,
  plan: AggregatePlan,
): Promise<{ problems: Problem[]; files: string[] }> {
  const indexes: IndexInput[] = plan.placed.map((p) => ({
    origin: `${outDir}/${p.dir ? `${p.dir}/` : ''}index.json`,
    index: p.index,
    schemas: p.schemas,
  }))
  const problems = checkFacts({ indexes, scan: false }).problems
  if (problems.length > 0) return { problems, files: [] }

  await rm(join(cwd, outDir), { recursive: true, force: true })
  const files: string[] = []
  for (const p of plan.placed) {
    const base = join(cwd, outDir, p.dir)
    await mkdir(base, { recursive: true })
    await writeFile(join(base, 'index.json'), `${JSON.stringify(p.index, null, 2)}\n`)
    files.push(`${outDir}/${p.dir ? `${p.dir}/` : ''}index.json`)
    for (const s of p.schemas) {
      const target = join(base, 'schemas', s.file)
      await mkdir(dirname(target), { recursive: true })
      await cp(join(p.sourceDir, 'schemas', s.file), target)
      files.push(`${outDir}/${p.dir ? `${p.dir}/` : ''}schemas/${s.file}`)
    }
  }
  for (const x of plan.examples) {
    const base = join(cwd, outDir, x.dir)
    await mkdir(base, { recursive: true })
    await writeFile(join(base, 'examples.json'), `${JSON.stringify(x.file, null, 2)}\n`)
    files.push(`${outDir}/${x.dir ? `${x.dir}/` : ''}examples.json`)
  }
  return { problems: [], files }
}
