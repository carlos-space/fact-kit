import { access, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEntries, resolveExamples } from './author.ts'
import type { FactIds, RefDecl, SourceEntry, SubsetDecl } from './author.ts'
import type { FactsModule, FactsSource, Problem } from './types.ts'

export interface LoadedEntry {
  /** Sub-path of the entry, e.g. `cli` or `hooks/events`. */
  entry: string
  /** Absolute directory of the entry. */
  dir: string
  /** The facts as the build writes them: `history`, `relates`, `factLink` and `derive` already expanded. */
  module: FactsModule
  /** Problems found while expanding the sources, such as `relates-foreign` and `derive`. `check` reports them. */
  problems: Problem[]
  /** The lists that `subsetOf` keeps inside the list of another fact. `check` tests them at every version boundary. */
  subsets: SubsetDecl[]
  /** The `ref`s the facts write. `check` tests them against the rows of the facts they point at. */
  refs: RefDecl[]
  /** JSON Schema files under `<entry>/schemas/`, keyed by path relative to that directory. */
  schemas: { file: string; schema: unknown }[]
  /** The `*.facts.ts` files the entry collected, in the order their facts follow those of `index.ts`. */
  factsFiles: LoadedFactsFile[]
}

/** One collected `*.facts.ts`. `file` is relative to the package directory, with `/`. */
export interface LoadedFactsFile {
  file: string
  /** How many facts the file holds. */
  count: number
  /** The distinct values of `topics[0]` its facts have, in the order they first appear. */
  topics: string[]
}

/** What `loadEntries` returns: the entries, `ids` for every fact object of them, and `orphans` (`facts-file-orphan`). */
export type LoadedEntries = LoadedEntry[] & { ids: FactIds; orphans: Problem[] }

/** Raised when a source file cannot be loaded. The CLI reports it as a `load` problem. */
export class LoadError extends Error {
  readonly file: string
  /** The problem code the CLI reports it as. */
  readonly code: 'load' | 'history' | 'builder'
  constructor(file: string, message: string, code: 'load' | 'history' | 'builder' = 'load') {
    super(message)
    this.name = 'LoadError'
    this.file = file
    this.code = code
  }
}

/** Raised when `check` can not run: bad settings or an input it was told to read is unreadable. The CLI exits with 2. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

const SKIPPED_DIRS = new Set(['schemas', 'node_modules'])

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const FACTS_FILE = '.facts.ts'

interface Scanned {
  /** Entry directories, in walk order. */
  entryDirs: string[]
  /** `*.facts.ts` files, with the entry directory they belong to, or none when they are orphans. */
  files: { file: string; entryDir?: string }[]
}

/**
 * Walks `factsDir`. A directory under it that holds an `index.ts` is an entry, unless a `_` directory is on the way.
 * A `*.facts.ts` belongs to the nearest entry above it. One under no entry, or inside a `_` directory, has none.
 * Directories starting with `.` and `node_modules` and `schemas` are not walked.
 */
async function scanFactsDir(factsDir: string): Promise<Scanned> {
  const out: Scanned = { entryDirs: [], files: [] }
  async function walk(dir: string, entryDir: string | undefined, hidden: boolean): Promise<void> {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let current = entryDir
    if (dir !== factsDir && !hidden && (await exists(join(dir, 'index.ts')))) {
      out.entryDirs.push(dir)
      current = dir
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isDirectory()) {
        if (item.name.startsWith('.') || SKIPPED_DIRS.has(item.name)) continue
        await walk(join(dir, item.name), current, hidden || item.name.startsWith('_'))
      } else if (item.name.endsWith(FACTS_FILE)) {
        out.files.push({ file: join(dir, item.name), ...(hidden || !current ? {} : { entryDir: current }) })
      }
    }
  }
  await walk(factsDir, undefined, false)
  return out
}

export async function readSchemas(dir: string): Promise<LoadedEntry['schemas']> {
  const root = join(dir, 'schemas')
  const out: LoadedEntry['schemas'] = []
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
        try {
          out.push({
            file: relative(root, path).split(sep).join('/'),
            schema: JSON.parse(await readFile(path, 'utf8')),
          })
        } catch (error) {
          throw new LoadError(path, `cannot read JSON Schema file: ${(error as Error).message}`)
        }
      }
    }
  }
  await walk(root)
  return out
}

export interface LoadEntriesOptions {
  /** Package directory, where `derive` finds the installed upstream packages. Defaults to the parent of `factsDir`. */
  cwd?: string
  /** Name of the package, for the locations `relates` writes across entries. Defaults to the name in `cwd`'s package.json. */
  packageName?: string
}

/**
 * Loads every entry under `factsDir`. An entry is a directory holding `index.ts` that default-exports
 * `{ describes, facts? }`. The default export of each `*.facts.ts` below the entry is an array of facts that follows
 * the `facts` of `index.ts`, the files sorted by their path relative to the entry. The TypeScript is run by Node's built-in type stripping, so it must use erasable
 * syntax only and relative imports must carry the `.ts` extension. A missing `factsDir` yields no entries.
 * `history`, `relates`, `factLink` and `derive` are expanded once every entry is loaded, because a fact may
 * relate to a fact of another entry.
 */
export async function loadEntries(factsDir: string, options: LoadEntriesOptions = {}): Promise<LoadedEntries> {
  const cwd = options.cwd ?? dirname(factsDir)
  const posixRel = (file: string) => relative(cwd, file).split(sep).join('/')
  const scanned = await scanFactsDir(factsDir)
  const raw: (SourceEntry & { dir: string })[] = []
  const filesOf: LoadedFactsFile[][] = []
  for (const dir of scanned.entryDirs) {
    const file = join(dir, 'index.ts')
    const mod = await importSource(file)
    const value = (mod.default ?? mod) as Partial<FactsSource> | undefined
    if (!value || typeof value !== 'object' || (value.facts !== undefined && !Array.isArray(value.facts))) {
      throw new LoadError(file, 'must default-export an object with `describes`, and a `facts` array when it has facts')
    }
    // Code-unit order of the path relative to the entry, so the index is the same on every machine.
    const own = scanned.files
      .filter((f) => f.entryDir === dir)
      .map((f) => ({ path: f.file, key: relative(dir, f.file).split(sep).join('/') }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const collected: unknown[] = []
    const files: LoadedFactsFile[] = []
    for (const f of own) {
      const fileMod = await importSource(f.path)
      if (!Array.isArray(fileMod.default)) {
        throw new LoadError(f.path, 'must default-export an array of facts')
      }
      const items = fileMod.default as unknown[]
      const topics: string[] = []
      for (const item of items) {
        const first = (item as { topics?: unknown } | null)?.topics
        const topic = Array.isArray(first) ? first[0] : undefined
        if (typeof topic === 'string' && !topics.includes(topic)) topics.push(topic)
      }
      collected.push(...items)
      files.push({ file: posixRel(f.path), count: items.length, topics })
    }
    filesOf.push(files)
    raw.push({
      entry: relative(factsDir, dir).split(sep).join('/'),
      dir,
      origin: posixRel(file),
      source: { describes: {}, ...value, facts: [...(value.facts ?? []), ...collected] } as FactsSource,
    })
  }
  const resolved = resolveEntries(raw, { cwd, packageName: options.packageName ?? (await tryPackageName(cwd)) })
  const entries: LoadedEntry[] = []
  for (const [i, e] of raw.entries()) {
    entries.push({
      entry: e.entry,
      dir: e.dir,
      module: (resolved[i] as (typeof resolved)[number]).module,
      problems: (resolved[i] as (typeof resolved)[number]).problems,
      subsets: (resolved[i] as (typeof resolved)[number]).subsets,
      refs: (resolved[i] as (typeof resolved)[number]).refs,
      schemas: await readSchemas(e.dir),
      factsFiles: filesOf[i] as LoadedFactsFile[],
    })
  }
  const orphans: Problem[] = scanned.files
    .filter((f) => f.entryDir === undefined)
    .map((f) => ({
      code: 'facts-file-orphan',
      message: `${posixRel(f.file)} belongs to no entry: there is no index.ts in its directory or above it below the facts directory, or it is in a directory starting with "_"`,
      location: posixRel(f.file),
    }))
  return Object.assign(entries, { ids: resolved.ids, orphans })
}

/** Runs a source file. A failure is a {@link LoadError} with the code that says what failed. */
async function importSource(file: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>
  } catch (error) {
    // `history` and `keyed` name the key that does not fit, which is the whole message.
    if ((error as Error | undefined)?.name === 'HistoryError')
      throw new LoadError(file, (error as Error).message, 'history')
    // The same for a builder, `mf.*` and the rows of `history` that a builder checks again.
    if ((error as Error | undefined)?.name === 'BuilderError')
      throw new LoadError(file, (error as Error).message, 'builder')
    throw new LoadError(file, `cannot run the module: ${(error as Error).message}`)
  }
}

async function tryPackageName(cwd: string): Promise<string> {
  try {
    return await readPackageName(cwd)
  } catch {
    return ''
  }
}

/** Reads `name` from the package.json in `cwd`. */
export async function readPackageName(cwd: string): Promise<string> {
  const file = join(cwd, 'package.json')
  let pkg: { name?: unknown }
  try {
    pkg = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown }
  } catch (error) {
    throw new LoadError(file, `cannot read package.json: ${(error as Error).message}`)
  }
  if (typeof pkg.name !== 'string') throw new LoadError(file, 'package.json has no "name"')
  return pkg.name
}

/** One example group file: `.ts` (default export) or `.json`, holding a group or an array of groups. */
export interface LoadedExamples {
  origin: string
  groups: unknown[]
}

/** Loads every `.ts` and `.json` file under `dir` as example groups. A missing `dir` yields nothing. */
export async function loadExamples(dir: string, label: string): Promise<LoadedExamples[]> {
  const files: string[] = []
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
      if (item.isDirectory()) {
        if (!item.name.startsWith('_') && !item.name.startsWith('.') && item.name !== 'node_modules') await walk(path)
      } else if (/\.(ts|json)$/.test(item.name) && !item.name.endsWith('.d.ts')) files.push(path)
    }
  }
  await walk(dir)
  const out: LoadedExamples[] = []
  for (const file of files) {
    const origin = `${label}/${relative(dir, file).split(sep).join('/')}`
    let value: unknown
    try {
      value = file.endsWith('.json')
        ? JSON.parse(await readFile(file, 'utf8'))
        : ((await import(pathToFileURL(file).href)) as { default?: unknown }).default
    } catch (error) {
      throw new LoadError(origin, `cannot load examples: ${(error as Error).message}`)
    }
    if (value === undefined) throw new LoadError(origin, 'must default-export an example group or an array of them')
    out.push({ origin, groups: Array.isArray(value) ? value : [value] })
  }
  return out
}

/**
 * Loads the example groups under `dir` and turns the references in their outcome into fact ids, with the ids the
 * facts of `ids` have. `build` and `check` both read examples through this, so they see the same groups.
 */
export async function loadExampleGroups(
  dir: string,
  label: string,
  ids: FactIds,
): Promise<{ examples: { origin: string; group: unknown }[]; problems: Problem[] }> {
  const examples: { origin: string; group: unknown }[] = []
  const problems: Problem[] = []
  for (const loaded of await loadExamples(dir, label)) {
    const resolved = resolveExamples(loaded.groups, ids, loaded.origin)
    problems.push(...resolved.problems)
    for (const group of resolved.groups) examples.push({ origin: loaded.origin, group })
  }
  return { examples, problems }
}

/** Reads a built `index.json` (or the directory holding one) and its schema files. Throws {@link InputError} when it can not. */
export async function readIndexInput(
  cwd: string,
  path: string,
): Promise<{ origin: string; index: unknown; schemas: LoadedEntry['schemas']; indexFile: string }> {
  const abs = resolve(cwd, path)
  const isDir = (await stat(abs).catch(() => undefined))?.isDirectory() ?? false
  const indexFile = isDir ? join(abs, 'index.json') : abs
  let index: unknown
  try {
    index = JSON.parse(await readFile(indexFile, 'utf8'))
  } catch (error) {
    throw new InputError(`cannot read index file ${path}: ${(error as Error).message}`)
  }
  return { origin: path, index, schemas: await readSchemas(dirname(indexFile)), indexFile }
}
