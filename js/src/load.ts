import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveEntries } from './author.ts'
import type { SourceEntry, SubsetDecl } from './author.ts'
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
  /** JSON Schema files under `<entry>/schemas/`, keyed by path relative to that directory. */
  schemas: { file: string; schema: unknown }[]
}

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

/** Directories under `factsDir` that hold an `index.ts`. Directories starting with `_` or `.` are helpers. */
async function findEntryDirs(factsDir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (dir !== factsDir && (await exists(join(dir, 'index.ts')))) found.push(dir)
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isDirectory() || item.name.startsWith('_') || item.name.startsWith('.') || SKIPPED_DIRS.has(item.name))
        continue
      await walk(join(dir, item.name))
    }
  }
  await walk(factsDir)
  return found
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
 * `{ describes, facts }`. The TypeScript is run by Node's built-in type stripping, so it must use erasable
 * syntax only and relative imports must carry the `.ts` extension. A missing `factsDir` yields no entries.
 * `history`, `relates`, `factLink` and `derive` are expanded once every entry is loaded, because a fact may
 * relate to a fact of another entry.
 */
export async function loadEntries(factsDir: string, options: LoadEntriesOptions = {}): Promise<LoadedEntry[]> {
  const raw: (SourceEntry & { dir: string })[] = []
  for (const dir of await findEntryDirs(factsDir)) {
    const file = join(dir, 'index.ts')
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    } catch (error) {
      // `history` and `keyed` name the key that does not fit, which is the whole message.
      if ((error as Error | undefined)?.name === 'HistoryError')
        throw new LoadError(file, (error as Error).message, 'history')
      // The same for a builder, `mf.*` and the rows of `history` that a builder checks again.
      if ((error as Error | undefined)?.name === 'BuilderError')
        throw new LoadError(file, (error as Error).message, 'builder')
      throw new LoadError(file, `cannot run the module: ${(error as Error).message}`)
    }
    const value = (mod.default ?? mod) as Partial<FactsSource> | undefined
    if (!value || typeof value !== 'object' || !Array.isArray(value.facts)) {
      throw new LoadError(file, 'must default-export an object with a `facts` array (and `describes`)')
    }
    raw.push({
      entry: relative(factsDir, dir).split(sep).join('/'),
      dir,
      origin: relative(options.cwd ?? dirname(factsDir), file)
        .split(sep)
        .join('/'),
      source: { describes: {}, ...value } as FactsSource,
    })
  }
  const cwd = options.cwd ?? dirname(factsDir)
  const resolved = resolveEntries(raw, { cwd, packageName: options.packageName ?? (await tryPackageName(cwd)) })
  const entries: LoadedEntry[] = []
  for (const [i, e] of raw.entries()) {
    entries.push({
      entry: e.entry,
      dir: e.dir,
      module: (resolved[i] as (typeof resolved)[number]).module,
      problems: (resolved[i] as (typeof resolved)[number]).problems,
      subsets: (resolved[i] as (typeof resolved)[number]).subsets,
      schemas: await readSchemas(e.dir),
    })
  }
  return entries
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
