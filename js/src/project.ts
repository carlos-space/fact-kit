import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { checkFacts } from './check.ts'
import type { CheckResult, ExampleInput, IndexInput } from './check.ts'
import { LoadError, loadEntries, loadExamples, readPackageName, readSchemas } from './load.ts'
import { buildIndex } from './build.ts'
import type { Problem } from './types.ts'

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
}

export interface CheckProjectOptions extends ProjectConfig {
  /** Package directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Config file path. Defaults to `fact-kit.config.json` in `cwd` when it exists. */
  configFile?: string
}

export const CONFIG_FILE = 'fact-kit.config.json'

export async function readConfig(cwd: string, configFile?: string): Promise<ProjectConfig> {
  const file = configFile ? resolve(cwd, configFile) : join(cwd, CONFIG_FILE)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ProjectConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !configFile) return {}
    throw new LoadError(file, `cannot read config: ${(error as Error).message}`)
  }
}

/**
 * Loads the package's fact sources, built index files and examples from disk and runs {@link checkFacts}.
 * A directory that does not exist counts as empty, so a package with no facts yet passes.
 */
export async function checkProject(options: CheckProjectOptions = {}): Promise<CheckResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const file = await readConfig(cwd, options.configFile).catch((error: unknown) => {
    if (error instanceof LoadError) return error
    throw error
  })
  if (file instanceof LoadError) {
    return {
      problems: [{ code: 'load', message: file.message, location: file.file }],
      counts: { indexes: 0, facts: 0, schemas: 0, examples: 0 },
    }
  }
  const config = {
    ...file,
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  } as ProjectConfig
  const factsDir = config.factsDir ?? 'facts'
  const examplesDir = config.examplesDir ?? 'examples'

  const problems: Problem[] = []
  const indexes: IndexInput[] = []
  const examples: ExampleInput[] = []
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (error) {
      if (!(error instanceof LoadError)) throw error
      problems.push({ code: 'load', message: error.message, location: error.file })
    }
  }

  await guard(async () => {
    const entries = await loadEntries(join(cwd, factsDir))
    if (entries.length === 0) return
    const packageName = await readPackageName(cwd)
    for (const e of entries) {
      indexes.push({ origin: `${factsDir}/${e.entry}/index.ts`, index: buildIndex(packageName, e), schemas: e.schemas })
    }
  })

  for (const path of config.indexFiles ?? []) {
    await guard(async () => {
      const abs = resolve(cwd, path)
      const isDir = (await stat(abs).catch(() => undefined))?.isDirectory() ?? false
      const indexFile = isDir ? join(abs, 'index.json') : abs
      let index: unknown
      try {
        index = JSON.parse(await readFile(indexFile, 'utf8'))
      } catch (error) {
        throw new LoadError(path, `cannot read index file: ${(error as Error).message}`)
      }
      indexes.push({ origin: path, index, schemas: await readSchemas(dirname(indexFile)) })
    })
  }

  await guard(async () => {
    for (const loaded of await loadExamples(join(cwd, examplesDir), examplesDir)) {
      for (const group of loaded.groups) examples.push({ origin: loaded.origin, group })
    }
  })

  const result = checkFacts({
    indexes,
    examples,
    ...(config.allowedDomains ? { allowedDomains: config.allowedDomains } : {}),
  })
  return { ...result, problems: [...problems, ...result.problems] }
}
