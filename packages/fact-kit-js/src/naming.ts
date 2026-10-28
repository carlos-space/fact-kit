import { readFile } from 'node:fs/promises'
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
): Promise<Problem[]> {
  const policy = await readPolicy(root)
  if (!policy) return []
  const problems: Problem[] = []
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
  if (aggregate) problems.push(...(await nameProblems(root, cwd, aggregate, policy, scope)))
  return problems
}

interface Part {
  name: string
  dir: string
  /** `<publish name without @<org>/>-facts`, or `<describes key>-facts` for a component with no publish target. */
  base: string
  target: string | undefined
}

/** Reads a component package: its name, and the base name and publish target its facts give it. Undefined when it can not be worked out. */
async function readPart(cwd: string, component: string): Promise<Part | undefined> {
  const dir = await resolveComponent(cwd, component)
  // A component that is not installed can not be read. `build` reports it.
  if (dir === undefined) return undefined
  try {
    const name = await readPackageName(dir)
    const entries = await loadEntries(join(dir, 'facts'), { cwd: dir, packageName: name })
    const first = entries.find((e) => e.module.publish !== undefined) ?? entries[0]
    const keys = Object.keys(first?.module.describes ?? {})
    const publish = first?.module.publish
    const unitName =
      typeof publish?.name === 'string' ? withoutScope(publish.name) : keys.length === 1 ? keys[0] : undefined
    if (unitName === undefined) return undefined
    return {
      name,
      dir,
      base: `${unitName}-facts`,
      target: typeof publish?.target === 'string' ? publish.target : undefined,
    }
  } catch (error) {
    // Whatever is wrong with the sources, `check` of that package reports it.
    if (error instanceof LoadError) return undefined
    throw error
  }
}

async function nameProblems(
  root: string,
  cwd: string,
  aggregate: Readonly<Record<string, string>>,
  policy: Policy,
  scope: string | undefined,
): Promise<Problem[]> {
  const problems: Problem[] = []
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
  for (const component of Object.values(aggregate)) {
    const part = await readPart(cwd, component)
    if (part) parts.push(part)
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
  return problems
}
