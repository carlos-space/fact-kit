import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { assertIndex, selectFacts } from './select.ts'
import type { SelectOptions, SelectedFact } from './select.ts'
import type { FactIndex, Since } from './types.ts'
import { FactReadError, compareSemver, parseVersion } from './version.ts'

/** What `onRead` is told: the fact that was read and the fact package it came from. */
export interface FactRead {
  package: string
  /** Version of the installed fact package. It is not the version the reader asked for. */
  version: string
  entry: string
  id: string
  /** The `since` of the row that was read. */
  since: Since
}

export interface FactReader {
  package: string
  /** Version of the installed fact package, from its `package.json`. */
  version: string
  entry: string
  /** The component this entry describes and the version it covers. */
  describes: Readonly<Record<string, string>>
  /** The facts this reader sees, each flattened to the row that applies. */
  facts: readonly SelectedFact[]
  /** Whether a fact with this id exists. */
  has(id: string): boolean
  /** The fact with this id. Throws when there is none, so a typo fails the build instead of reading nothing. */
  get(id: string): SelectedFact
  /** The `content.value` of the fact with this id. Throws when the fact has no value content. */
  value<T = unknown>(id: string): T
}

export interface ReadFactsOptions extends SelectOptions {
  /** Directory the package is resolved from, normally the hub being built. Defaults to `process.cwd()`. */
  root?: string
  /**
   * Called, synchronously, each time a fact is read through this reader: once per `get` and `value`, once per
   * `has` that finds the fact, and once per read of a field other than `id` on an element of `facts`.
   * Filtering `facts` by `id` alone does not call it.
   */
  onRead?: (read: FactRead) => void
}

/**
 * Splits `@scope/name/path/to/entry` or `name/path` into the package name and the sub-path. The sub-path is
 * empty for a spec that names only the package.
 */
export function splitSpec(spec: string): { packageName: string; entry: string } {
  const parts = spec.split('/')
  const nameLength = spec.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, nameLength).join('/')
  const entry = parts.slice(nameLength).join('/')
  if (parts.length < nameLength || parts.some((p) => !p)) {
    throw new FactReadError('not-found', `readFacts: "${spec}" is not of the form "<package>" or "<package>/<path>"`)
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
 * Reads the built `index.json` of `<package>` or `<package>/<path>` as installed under `root`, so each hub gets
 * the version its own lockfile pins. The fact package is resolved at call time with `createRequire` based at
 * `root`, never imported at the top of a module. The package must export `./index.json` or `./<path>/index.json`.
 * The index may be format 1.0 or 1.1.
 *
 * `version`, `include`, `platform` and `os` choose what the reader sees, see {@link selectFacts}. Without
 * `version`, a described product that is installed under `root` sets it: the facts of the installed version are
 * read, and facts for an older version than the one `describes` names still work. An installed product that is
 * newer than the facts cover makes reading throw, because the facts do not say anything about that version yet.
 * A product that is not installed there, such as a CLI or a service, sets nothing, and the reader gets the
 * latest published facts.
 */
export function readFacts(spec: string, options: ReadFactsOptions = {}): FactReader {
  const { packageName, entry } = splitSpec(spec)
  const root = options.root ?? process.cwd()
  const require = createRequire(join(root, 'noop.js'))
  const target = entry ? `${packageName}/${entry}/index.json` : `${packageName}/index.json`
  let file: string
  try {
    file = require.resolve(target)
  } catch (error) {
    throw new FactReadError(
      'not-found',
      `readFacts: cannot resolve "${target}" from ${root}. ` +
        `Install ${packageName} there and check that it exports "./${entry ? `${entry}/` : ''}index.json". (${(error as Error).message})`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new FactReadError('not-an-index', `readFacts: ${file} is not a fact index (${(error as Error).message})`)
  }
  assertIndex(parsed, `readFacts: ${file}`)
  const index = parsed as FactIndex
  const describes = index.describes ?? {}

  let version = options.version
  let productVersion: string | undefined
  for (const [product, described] of version === undefined ? Object.entries(describes) : []) {
    const installed = installedVersion(root, product)
    if (installed === undefined) continue
    const a = parseVersion(installed)
    const b = parseVersion(described)
    // Versions that are not semver can only be told apart by equality.
    const newer = a && b ? compareSemver(a, b) > 0 : installed !== described
    if (newer) {
      throw new Error(
        `readFacts: ${spec} describes ${product} ${described}, but ${root} has ${product} ${installed}. ` +
          `Install the ${packageName} version that describes ${product} ${installed}.`,
      )
    }
    if (a && productVersion === undefined) productVersion = installed
  }
  if (version === undefined && productVersion !== undefined) version = productVersion

  const facts = selectFacts(index, {
    ...(version !== undefined ? { version } : {}),
    ...(options.include !== undefined ? { include: options.include } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.os !== undefined ? { os: options.os } : {}),
  })
  const byId = new Map(facts.map((f) => [f.id, f]))
  const packageVersion = owningVersion(file, packageName)
  const entryName = index.entry ?? entry
  const { onRead } = options
  const note = (fact: SelectedFact): void => {
    onRead?.({ package: index.package, version: packageVersion, entry: entryName, id: fact.id, since: fact.since })
  }
  const get = (id: string): SelectedFact => {
    const fact = byId.get(id)
    if (!fact) throw new Error(`readFacts: no fact "${id}" in ${spec}`)
    note(fact)
    return fact
  }
  // Elements of `facts` tell onRead only when a field other than `id` is read, so a listing that filters by id
  // is not counted as a use.
  const listed: readonly SelectedFact[] = onRead
    ? Object.freeze(
        facts.map(
          (fact) =>
            new Proxy(fact, {
              get(target, key, receiver) {
                if (typeof key === 'string' && key !== 'id') note(target)
                return Reflect.get(target, key, receiver)
              },
            }),
        ),
      )
    : facts
  return {
    package: index.package,
    version: packageVersion,
    entry: entryName,
    describes,
    facts: listed,
    has: (id) => {
      const fact = byId.get(id)
      if (fact) note(fact)
      return fact !== undefined
    },
    get,
    value: <T>(id: string): T => {
      const fact = get(id)
      if (!('value' in fact.content)) throw new Error(`readFacts: fact "${id}" in ${spec} has no value content`)
      return fact.content.value as T
    },
  }
}
