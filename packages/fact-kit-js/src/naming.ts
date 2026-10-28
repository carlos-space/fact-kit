import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { resolveComponent } from './aggregate.ts'
import { InputError, LoadError, loadEntries, readPackageName } from './load.ts'
import type { Problem } from './types.ts'

/** The rules about package names that read `release-policy.json`: the scope it must name, and the names of facts packages. */

export const POLICY_FILE = 'release-policy.json'

interface Policy {
  access?: unknown
  scope?: unknown
  units?: Record<string, { access?: unknown } | undefined>
}

const posix = (path: string): string => path.split(sep).join('/')
const withoutScope = (name: string): string => name.replace(/^@[^/]+\//, '')
const isRestricted = (access: unknown): boolean => access === 'restricted'

/** The policy at the root of the repository, or undefined when there is none. Throws {@link InputError} for a file that is not JSON. */
async function readPolicy(root: string): Promise<Policy | undefined> {
  const file = join(root, POLICY_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new InputError(`cannot read ${file}: ${(error as Error).message}`)
  }
  try {
    const policy = JSON.parse(text) as unknown
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) throw new Error('not a JSON object')
    return policy as Policy
  } catch (error) {
    throw new InputError(`cannot read ${file}: ${(error as Error).message}`)
  }
}

/** The release-please component of the package in `cwd`, when `release-please-config.json` lists its directory. */
async function releaseUnitOf(root: string, cwd: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(await readFile(join(root, 'release-please-config.json'), 'utf8')) as {
      packages?: Record<string, { component?: unknown } | undefined>
    }
    const path = posix(relative(root, cwd)) || '.'
    const entry = config.packages?.[path]
    if (!entry) return undefined
    return typeof entry.component === 'string' ? entry.component : basename(path)
  } catch {
    return undefined
  }
}

/**
 * Rules that read `release-policy.json` at `root`. Nothing is checked in a repository without one.
 * `policy-scope`: the policy has a restricted `access`, at the top or in a unit, and no top-level `scope`.
 * `facts-name`: for an aggregate package, its own name and the names of its component packages. The prefix
 * `@<scope>/` follows the `access` of the aggregate's unit, whichever unit a component describes. The suffix
 * `.<publish target>` is on every package whose base name another package of the aggregate has too.
 */
export async function policyProblems(
  root: string,
  cwd: string,
  aggregate: Readonly<Record<string, string>> | undefined,
): Promise<{ problems: Problem[]; warnings: Problem[] }> {
  const policy = await readPolicy(root)
  if (!policy) return { problems: [], warnings: [] }
  const problems: Problem[] = []
  const warnings: Problem[] = []
  const scope = typeof policy.scope === 'string' && policy.scope !== '' ? policy.scope : undefined
  const anyRestricted =
    isRestricted(policy.access) || Object.values(policy.units ?? {}).some((u) => isRestricted(u?.access))
  if (anyRestricted && scope === undefined) {
    problems.push({
      code: 'policy-scope',
      message: `${POLICY_FILE} has a restricted access but no top-level "scope", such as "@carlos-space"`,
      location: POLICY_FILE,
    })
  }
  if (aggregate) {
    const found = await nameProblems(root, cwd, aggregate, policy, scope)
    problems.push(...found.problems)
    warnings.push(...found.warnings)
  }
  return { problems, warnings }
}

/** The directories the `packages` patterns of `pnpm-workspace.yaml` at `root` match. `*` is one level, `**` any number. */
async function workspaceDirs(root: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    return []
  }
  const patterns: string[] = []
  let inPackages = false
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line)
    else if (inPackages) {
      const m = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*$/.exec(line)
      const pattern = m?.[1] ?? m?.[2] ?? m?.[3]
      if (pattern !== undefined && !pattern.startsWith('!')) patterns.push(pattern)
    }
  }
  const subdirs = async (dir: string): Promise<string[]> => {
    try {
      const items = await readdir(dir, { withFileTypes: true })
      return items
        .filter((i) => i.isDirectory() && i.name !== 'node_modules' && !i.name.startsWith('.'))
        .map((i) => join(dir, i.name))
    } catch {
      return []
    }
  }
  const expand = async (dir: string, parts: string[]): Promise<string[]> => {
    const [head, ...rest] = parts
    if (head === undefined) return [dir]
    if (head === '**') {
      const here = await expand(dir, rest)
      const deeper = await Promise.all((await subdirs(dir)).map((d) => expand(d, parts)))
      return [...here, ...deeper.flat()]
    }
    if (head === '*') return (await Promise.all((await subdirs(dir)).map((d) => expand(d, rest)))).flat()
    return expand(join(dir, head), rest)
  }
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    for (const d of await expand(
      root,
      pattern.split('/').filter((x) => x !== '' && x !== '.'),
    ))
      dirs.add(d)
  }
  return [...dirs]
}

/** The directory of the workspace package called `name`, found through `pnpm-workspace.yaml`. */
async function findInWorkspace(root: string, name: string): Promise<string | undefined> {
  for (const dir of await workspaceDirs(root)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (pkg.name === name) return dir
    } catch {
      // not a package
    }
  }
  return undefined
}

/** `factsDir` of the component's own fact-kit.config.json, `facts` when it has none. */
async function factsDirOf(dir: string): Promise<string> {
  try {
    const config = JSON.parse(await readFile(join(dir, 'fact-kit.config.json'), 'utf8')) as { factsDir?: unknown }
    return typeof config.factsDir === 'string' ? config.factsDir : 'facts'
  } catch {
    return 'facts'
  }
}

interface Part {
  name: string
  dir: string
  /** `<publish name without @<org>/>-facts`, or `<describes key>-facts` for a component with no publish target. */
  base: string
  target: string | undefined
}

/**
 * Reads a component package: its name, and the base name and publish target its facts give it. The package is
 * found in node_modules under the aggregate, else in the workspace `pnpm-workspace.yaml` lists. Without a package
 * the result is a warning, and so it is for facts that can not be loaded or name no unit.
 */
async function readPart(
  root: string,
  cwd: string,
  subpath: string,
  component: string,
): Promise<{ part?: Part; warning?: Problem }> {
  const warn = (message: string): { warning: Problem } => ({
    warning: {
      code: 'facts-name',
      message: `${component}: ${message}, so its name is not checked`,
      location: POLICY_FILE,
    },
  })
  const dir = (await resolveComponent(cwd, component)) ?? (await findInWorkspace(root, component))
  if (dir === undefined) {
    return warn('no package of that name is in node_modules or in the packages of pnpm-workspace.yaml')
  }
  try {
    const name = await readPackageName(dir)
    const entries = await loadEntries(join(dir, await factsDirOf(dir)), { cwd: dir, packageName: name })
    const first = entries.find((e) => e.module.publish !== undefined) ?? entries[0]
    const keys = Object.keys(first?.module.describes ?? {})
    const publish = first?.module.publish
    const unitName =
      typeof publish?.name === 'string'
        ? withoutScope(publish.name)
        : keys.length === 1
          ? keys[0]
          : // A component that describes no version is named by the sub-path it hangs on.
            subpath === '.'
            ? undefined
            : subpath
    if (unitName === undefined)
      return warn(
        'its facts have no publish name, do not describe exactly one component, and it is the root of the aggregate',
      )
    return {
      part: {
        name,
        dir,
        base: `${unitName}-facts`,
        target: typeof publish?.target === 'string' ? publish.target : undefined,
      },
    }
  } catch (error) {
    // Whatever is wrong with the sources, `check` of that package reports it.
    if (error instanceof LoadError) return warn(`its facts can not be loaded (${error.message})`)
    throw error
  }
}

async function nameProblems(
  root: string,
  cwd: string,
  aggregate: Readonly<Record<string, string>>,
  policy: Policy,
  scope: string | undefined,
): Promise<{ problems: Problem[]; warnings: Problem[] }> {
  const problems: Problem[] = []
  const warnings: Problem[] = []
  let aggregateName: string
  try {
    aggregateName = await readPackageName(cwd)
  } catch (error) {
    throw new InputError((error as Error).message)
  }
  const aggregateBase = withoutScope(aggregateName)
  // The unit of the aggregate: its release-please component, else the unit named like the package.
  const candidates = [await releaseUnitOf(root, cwd), aggregateBase]
  const unit = candidates.find((c): c is string => c !== undefined && policy.units?.[c] !== undefined)
  const access = (unit !== undefined ? policy.units?.[unit]?.access : undefined) ?? policy.access
  const prefix = isRestricted(access) && scope !== undefined ? `${scope}/` : ''
  const unitText = unit !== undefined ? `the unit ${unit}` : 'the repository'
  const accessText = isRestricted(access) ? 'restricted' : 'public'
  const where = (file: string) => posix(relative(root, file))

  if (!aggregateBase.endsWith('-facts')) {
    problems.push({
      code: 'facts-name',
      message: `the aggregate package ${aggregateName} must be named <name>-facts`,
      location: where(join(cwd, 'package.json')),
    })
  } else if (aggregateName !== `${prefix}${aggregateBase}`) {
    problems.push({
      code: 'facts-name',
      message: `the aggregate package is named ${aggregateName}, but the access of ${unitText} is ${accessText}, so the name is ${prefix}${aggregateBase}`,
      location: where(join(cwd, 'package.json')),
    })
  }

  const parts: Part[] = []
  for (const [subpath, component] of Object.entries(aggregate)) {
    const read = await readPart(root, cwd, subpath, component)
    if (read.part) parts.push(read.part)
    if (read.warning) warnings.push(read.warning)
  }
  for (const part of parts) {
    const location = where(join(part.dir, 'package.json'))
    const shared = part.base === aggregateBase || parts.some((p) => p !== part && p.base === part.base)
    if (shared && part.target === undefined) {
      problems.push({
        code: 'facts-name',
        message: `${part.name} has the base name ${part.base}, which another package of ${aggregateName} has too, and it has no publish target to tell them apart. Rename its unit`,
        location,
      })
      continue
    }
    const expected = `${prefix}${part.base}${shared ? `.${part.target}` : ''}`
    if (part.name === expected) continue
    const suffixWhy = shared
      ? `its base name ${part.base} is shared, so it ends in .${part.target}`
      : `its base name ${part.base} is not shared, so it has no suffix`
    const prefixWhy = `the access of ${unitText} of ${aggregateName} is ${accessText}, so it ${prefix ? `starts with ${prefix}` : 'has no @<scope>/ prefix'}`
    problems.push({
      code: 'facts-name',
      message: `${part.name} must be named ${expected}: ${suffixWhy}, and ${prefixWhy}`,
      location,
    })
  }
  return { problems, warnings }
}
