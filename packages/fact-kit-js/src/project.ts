import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkFacts } from './check.ts'
import type { CheckResult, ExampleInput, IndexInput } from './check.ts'
import { InputError, LoadError, loadEntries, loadExampleGroups, readIndexInput, readPackageName } from './load.ts'
import type { FactIds } from './author.ts'
import { buildIndex } from './build.ts'
import { policyProblems } from './naming.ts'
import { docRefProblems, findRepoRoot, implProblems, libRowProblems, testIncludes } from './rules.ts'
import type { KnownFacts } from './rules.ts'
import type { FactIndex, Problem } from './types.ts'
import { derivedSources, installedVersionProblems, lockProblems, readLock } from './upstream.ts'
import { parseVersion } from './version.ts'

/** The settings of `fact-kit.config.json`. Command-line options override the file. */
export interface ProjectConfig {
  /** Directory of fact sources, relative to the package. Defaults to `facts`. */
  factsDir?: string
  /** Directory of example files, relative to the package. Defaults to `examples`. */
  examplesDir?: string
  /** Built `index.json` files (or directories holding one) to check as well, e.g. the facts a separate examples package depends on. */
  indexFiles?: string[]
  /** Hosts URLs may point at. See `CheckOptions.allowedDomains`. */
  allowedDomains?: string[]
  /** Aggregate package only: sub-path (`.` for the root) -> the component package whose built indexes go there. */
  aggregate?: Record<string, string>
  /** Root of the repository, relative to the package. Every package.json under it is checked for `-facts` dependencies. Defaults to the nearest parent that holds `.git`. */
  repoRoot?: string
  /** Directories of tests, relative to the package. A `pending` label needs a test that passes it as `include`. */
  testDirs?: string[]
  /** Directories of markdown, relative to the package. `check` finds `fact:<id>` in them that name no fact, and `diff --impact` searches them for references to a fact. */
  docsDirs?: string[]
  /** Directories of the implementation, relative to the package. Code there must not import a `-facts` package. */
  implDirs?: string[]
}

export interface CheckProjectOptions extends ProjectConfig {
  /** Package directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Config file path. Defaults to `fact-kit.config.json` in `cwd` when it exists. */
  configFile?: string
  /** Component -> version of the train being released, see `CheckOptions.train`. */
  train?: Record<string, string>
}

export const CONFIG_FILE = 'fact-kit.config.json'

const STRING_SETTINGS = ['factsDir', 'examplesDir', 'repoRoot'] as const
const LIST_SETTINGS = ['indexFiles', 'allowedDomains', 'testDirs', 'docsDirs', 'implDirs'] as const

function validateConfig(config: unknown, file: string): ProjectConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new InputError(`${file}: the config must be a JSON object`)
  }
  const c = config as Record<string, unknown>
  for (const key of STRING_SETTINGS) {
    if (c[key] !== undefined && typeof c[key] !== 'string') throw new InputError(`${file}: "${key}" must be a string`)
  }
  for (const key of LIST_SETTINGS) {
    if (c[key] !== undefined && !(Array.isArray(c[key]) && (c[key] as unknown[]).every((v) => typeof v === 'string'))) {
      throw new InputError(`${file}: "${key}" must be a list of strings`)
    }
  }
  return c as ProjectConfig
}

/** Reads the config. A config file that is named but missing, unreadable or not valid is an {@link InputError}. */
export async function readConfig(cwd: string, configFile?: string): Promise<ProjectConfig> {
  const file = configFile ? resolve(cwd, configFile) : join(cwd, CONFIG_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !configFile) return {}
    throw new InputError(`cannot read config ${file}: ${(error as Error).message}`)
  }
  try {
    return validateConfig(JSON.parse(text), file)
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError(`cannot read config ${file}: ${(error as Error).message}`)
  }
}

/** Reads `--train` values: `<component>=<version>`. Throws {@link InputError} on anything else. */
export function parseTrain(values: readonly string[]): Record<string, string> {
  const train: Record<string, string> = {}
  for (const value of values) {
    const eq = value.indexOf('=')
    const component = eq === -1 ? '' : value.slice(0, eq)
    const version = eq === -1 ? '' : value.slice(eq + 1)
    if (!component || !parseVersion(version)) {
      throw new InputError(`--train expects <component>=<version> with a semver version, got "${value}"`)
    }
    train[component] = version
  }
  return train
}

/**
 * Loads the package's fact sources, built index files and examples from disk and runs {@link checkFacts}, then the
 * rules that read files around them. A directory that does not exist counts as empty, so a package with no facts
 * yet passes. Throws {@link InputError} when the check can not run: bad settings, or a file it was told to read
 * that can not be read.
 */
export async function checkProject(options: CheckProjectOptions = {}): Promise<CheckResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new InputError(`${cwd} is not a directory`)
  }
  const file = await readConfig(cwd, options.configFile)
  const { train, cwd: _cwd, configFile: _configFile, ...given } = options
  const config = {
    ...file,
    ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)),
  } as ProjectConfig
  if (train) parseTrain(Object.entries(train).map(([c, v]) => `${c}=${v}`))
  const factsDir = config.factsDir ?? 'facts'
  const examplesDir = config.examplesDir ?? 'examples'
  const root = resolve(cwd, config.repoRoot ?? findRepoRoot(cwd))

  const problems: Problem[] = []
  const indexes: IndexInput[] = []
  const examples: ExampleInput[] = []
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      if (!(error instanceof LoadError)) throw error
      problems.push({ code: error.code, message: error.message, location: error.file })
    }
  }

  let ids: FactIds = new Map()
  await guard(async () => {
    const entries = await loadEntries(join(cwd, factsDir), { cwd })
    ids = entries.ids
    if (entries.length === 0) return
    let packageName: string
    try {
      packageName = await readPackageName(cwd)
    } catch (error) {
      throw new InputError((error as Error).message)
    }
    for (const e of entries) {
      problems.push(...e.problems)
      indexes.push({
        origin: `${factsDir}/${e.entry}/index.ts`,
        index: buildIndex(packageName, e),
        schemas: e.schemas,
        source: true,
        subsets: e.subsets,
        refs: e.refs,
      })
    }
  })

  for (const path of config.indexFiles ?? []) {
    const { indexFile: _file, ...input } = await readIndexInput(cwd, path)
    indexes.push(input)
    problems.push(...installedVersionProblems(input.index, cwd, path))
  }

  await guard(async () => {
    const loaded = await loadExampleGroups(join(cwd, examplesDir), examplesDir, ids)
    problems.push(...loaded.problems)
    examples.push(...loaded.examples)
  })

  // The same comparison the build makes: the sources built now against `derived.lock.json`.
  await guard(async () => {
    problems.push(
      ...lockProblems(await readLock(cwd), derivedSources(indexes.filter((i) => i.source).map((i) => i.index))),
    )
  })

  const pendingTested = hasPending(indexes) ? await testIncludes(config.testDirs ?? [], cwd) : undefined

  const result = checkFacts({
    indexes,
    examples,
    ...(config.allowedDomains ? { allowedDomains: config.allowedDomains } : {}),
    ...(train ? { train } : {}),
    ...(pendingTested ? { pendingTested } : {}),
  })

  const extra: Problem[] = []
  if (indexes.some((i) => i.source)) extra.push(...(await libRowProblems(join(cwd, factsDir, '_lib'), cwd)))
  extra.push(...(await implProblems(root, cwd, config.implDirs ?? [])))
  const policy = await policyProblems(root, cwd, config.aggregate)
  extra.push(...policy.problems)
  if (config.docsDirs?.length) extra.push(...(await docRefProblems(config.docsDirs, cwd, knownFacts(indexes))))

  return {
    ...result,
    problems: [...problems, ...result.problems, ...extra],
    warnings: [...result.warnings, ...policy.warnings],
  }
}

function hasPending(indexes: readonly IndexInput[]): boolean {
  return indexes.some(
    (i) =>
      i.source === true &&
      ((i.index as Partial<FactIndex> | null)?.facts ?? []).some((f) =>
        (Array.isArray(f?.variants) ? f.variants : []).some(
          (v) => (v as { pending?: unknown } | null)?.pending !== undefined,
        ),
      ),
  )
}

function knownFacts(indexes: readonly IndexInput[]): KnownFacts {
  const ids = new Set<string>()
  const bySpec = new Map<string, Set<string>>()
  for (const { index } of indexes) {
    const head = index as Partial<FactIndex> | null
    const own = new Set<string>()
    for (const f of Array.isArray(head?.facts) ? head.facts : []) {
      if (typeof f?.id === 'string') {
        ids.add(f.id)
        own.add(f.id)
      }
    }
    if (typeof head?.package === 'string' && typeof head.entry === 'string') {
      bySpec.set(`${head.package}/${head.entry}`, own)
    }
  }
  return { ids, bySpec }
}
