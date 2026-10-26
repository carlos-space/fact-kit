import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Fact, FactIndex } from './types.ts'

export interface FactReader {
  package: string
  /** Version of the installed fact package, from its `package.json`. */
  version: string
  entry: string
  /** The products and versions this entry describes. */
  describes: Readonly<Record<string, string>>
  facts: readonly Fact[]
  /** Whether a fact with this id exists. */
  has(id: string): boolean
  /** The fact with this id. Throws when there is none, so a typo fails the build instead of reading nothing. */
  get(id: string): Fact
  /** The `content.value` of the fact with this id. Throws when the fact has no value content. */
  value<T = unknown>(id: string): T
}

export interface ReadFactsOptions {
  /** Directory the package is resolved from, normally the hub being built. Defaults to `process.cwd()`. */
  root?: string
}

/** Splits `@scope/name/entry/sub` or `name/entry` into the package name and the sub-path. */
export function splitSpec(spec: string): { packageName: string; entry: string } {
  const parts = spec.split('/')
  const nameLength = spec.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, nameLength).join('/')
  const entry = parts.slice(nameLength).join('/')
  if (!packageName || (spec.startsWith('@') && parts.length < 2) || !entry) {
    throw new Error(`readFacts: "${spec}" is not of the form "<package>/<entry>"`)
  }
  return { packageName, entry }
}

/** The `package.json` version of the package `name` that contains `file`, found by walking up from it. */
function owningVersion(file: string, name: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
    if (pkg.name === name) return pkg.version ?? ''
  }
  return ''
}

/**
 * The version of package `name` as Node would find it from `root`: the first `node_modules/<name>` going up.
 * Read from the directory rather than resolved, because a package whose `exports` omit `./package.json`
 * cannot be resolved to it.
 */
function installedVersion(root: string, name: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
    if (dir === dirname(dir)) return undefined
  }
}

/**
 * Reads the built `index.json` of `<package>/<entry>` as installed under `root`, so each hub gets the
 * version its own lockfile pins. The fact package is resolved at call time with `createRequire` based at
 * `root`, never imported at the top of a module. The package must export `./<entry>/index.json`.
 *
 * Each key of `describes` is taken as an npm package name. When that package is installed under `root`, its
 * version must equal the described one, or the facts describe another version than the hub runs and reading
 * throws. A product that is not installed there, such as a CLI or a service, is not checked.
 */
export function readFacts(spec: string, options: ReadFactsOptions = {}): FactReader {
  const { packageName, entry } = splitSpec(spec)
  const root = options.root ?? process.cwd()
  const require = createRequire(join(root, 'noop.js'))
  let file: string
  try {
    file = require.resolve(`${packageName}/${entry}/index.json`)
  } catch (error) {
    throw new Error(
      `readFacts: cannot resolve "${packageName}/${entry}/index.json" from ${root}. ` +
        `Install ${packageName} there and check that it exports "./${entry}/index.json". (${(error as Error).message})`,
    )
  }
  const index = JSON.parse(readFileSync(file, 'utf8')) as Partial<FactIndex>
  if (!index || !Array.isArray(index.facts) || typeof index.package !== 'string') {
    throw new Error(`readFacts: ${file} is not a fact index`)
  }
  const describes = index.describes ?? {}
  for (const [product, described] of Object.entries(describes)) {
    const installed = installedVersion(root, product)
    if (installed !== undefined && installed !== described) {
      throw new Error(
        `readFacts: ${spec} describes ${product} ${described}, but ${root} has ${product} ${installed}. ` +
          `Install the ${packageName} version that describes ${product} ${installed}.`,
      )
    }
  }
  const facts = index.facts
  const byId = new Map(facts.map((f) => [f.id, f]))
  const get = (id: string): Fact => {
    const fact = byId.get(id)
    if (!fact) throw new Error(`readFacts: no fact "${id}" in ${spec}`)
    return fact
  }
  return {
    package: index.package,
    version: owningVersion(file, packageName),
    entry: index.entry ?? entry,
    describes,
    facts,
    has: (id) => byId.has(id),
    get,
    value: <T>(id: string): T => {
      const fact = get(id)
      if (!('value' in fact.content)) throw new Error(`readFacts: fact "${id}" in ${spec} has no value content`)
      return fact.content.value as T
    },
  }
}
