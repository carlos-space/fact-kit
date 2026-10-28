import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanTmp, cli, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

interface Part {
  /** package.json name of the component package. */
  name: string
  /** What the component's facts describe, e.g. `fact-kit-js`. */
  describes: string
  publish?: { target: string; name: string }
  /** Where the package is, relative to the repository. Defaults to `parts/<i>`. */
  dir?: string
  /** `factsDir` of the component's own config. Defaults to `facts`. */
  factsDir?: string
  /** Text of the entry module, for facts that do not load. */
  source?: string
}

interface Repo {
  policy?: Record<string, unknown>
  aggregate: string
  parts: Part[]
  /** The release-please component of the aggregate. Defaults to the aggregate name without scope. */
  unit?: string
  /** The whole release-please-config.json. `null` leaves the file out. Overrides `unit`. */
  releasePlease?: unknown
  /** Directory of the aggregate in the repository. Defaults to `facts`. */
  aggregateDir?: string
  /** The `packages` patterns of pnpm-workspace.yaml. Without them there is no such file. */
  workspace?: string[]
}

interface Run {
  code: number
  problems: { code: string; message: string; location: string | null }[]
  stderr: string
}

/**
 * A repository with an aggregate package in `facts/` and one component package per part, linked into the
 * aggregate's node_modules the way pnpm links a workspace dependency. Checks the aggregate.
 */
async function check(repo: Repo, { install = true } = {}): Promise<Run> {
  const dir = makeTmp('naming')
  const aggDir = repo.aggregateDir ?? 'facts'
  const where = (i: number) => repo.parts[i]?.dir ?? `parts/${i}`
  const files: Record<string, unknown> = {
    [`${aggDir}/package.json`]: { name: repo.aggregate, version: '1.0.0', type: 'module' },
    [`${aggDir}/fact-kit.config.json`]: {
      repoRoot: aggDir === '.' ? '.' : '..',
      aggregate: Object.fromEntries(repo.parts.map((p, i) => [i === 0 ? '.' : `sub${i}`, p.name])),
    },
  }
  if (repo.releasePlease !== null) {
    files['release-please-config.json'] = repo.releasePlease ?? {
      packages: { [aggDir]: { component: repo.unit ?? repo.aggregate.replace(/^@[^/]+\//, '') } },
    }
  }
  if (repo.workspace)
    files['pnpm-workspace.yaml'] = `packages:\n${repo.workspace.map((w) => `  - '${w}'`).join('\n')}\n`
  if (repo.policy) files['release-policy.json'] = repo.policy
  for (const [i, p] of repo.parts.entries()) {
    const factsDir = p.factsDir ?? 'facts'
    files[`${where(i)}/package.json`] = { name: p.name, version: '0.0.0', private: true, type: 'module' }
    if (p.factsDir) files[`${where(i)}/fact-kit.config.json`] = { factsDir: p.factsDir }
    files[`${where(i)}/${factsDir}/x/index.ts`] =
      p.source ??
      `export default { describes: ${p.describes === '' ? '{}' : `{ '${p.describes}': '1.0.0' }`}, ${p.publish ? `publish: ${JSON.stringify(p.publish)}, ` : ''}facts: [] }\n`
  }
  writeTree(dir, files)
  if (install) {
    for (const [i, p] of repo.parts.entries()) linkPackage(join(dir, aggDir), p.name, join(dir, where(i)))
  }
  const r = await cli(['check', '--cwd', join(dir, aggDir), '--json'])
  let problems: Run['problems'] = []
  try {
    problems = JSON.parse(r.stdout).problems
  } catch {
    // exit code 2 prints no JSON
  }
  return { code: r.code, problems, stderr: r.stderr }
}
const codes = (r: Run) => r.problems.map((p) => p.code)

const npm = { target: 'npm', name: 'demo' }
const go = { target: 'go', name: 'demo' }
const pub = { product: { name: 'demo', members: [] }, access: 'public', units: {} }
const restricted = { ...pub, access: 'restricted', scope: '@carlos-space' }

/** Aggregate `demo-facts` and two components that publish under the aggregate's base name. */
const shared = (aggregate: string, a: string, b: string): Repo => ({
  aggregate,
  parts: [
    { name: a, describes: 'demo', publish: npm },
    { name: b, describes: 'demo-go', publish: go },
  ],
})

describe('c004 check: package names against release-policy.json (m160/d002)', () => {
  test('a public repository: the base name of the publish name, with the publish target when it is shared', async () => {
    const r = await check({ ...shared('demo-facts', 'demo-facts.npm', 'demo-facts.go'), policy: pub })
    expect([r.code, r.problems]).toEqual([0, []])
    // A component that does not share its base name has no suffix, and one without a publish target uses its describes key.
    const other = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [
        { name: 'demo-facts.npm', describes: 'demo', publish: npm },
        { name: 'other-facts', describes: 'other', publish: { target: 'pypi', name: 'other' } },
        { name: 'git-facts', describes: 'git' },
      ],
    })
    expect([other.code, other.problems]).toEqual([0, []])
  })

  test('facts-name: a name without the suffix, the npm one included', async () => {
    const r = await check({ ...shared('demo-facts', 'demo-facts', 'demo-facts.go'), policy: pub })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
    expect(r.problems[0]?.message).toContain('demo-facts.npm')
    const both = await check({ ...shared('demo-facts', 'demo-facts', 'demo-facts-go'), policy: pub })
    expect(codes(both)).toEqual(['facts-name', 'facts-name'])
  })

  test('facts-name: a component whose base name is the aggregate name is suffixed even when alone', async () => {
    const r = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [{ name: 'demo-facts', describes: 'demo', publish: npm }],
    })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
  })

  test('facts-name: a suffix where the base name is not shared', async () => {
    const r = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [{ name: 'other-facts.npm', describes: 'other', publish: { target: 'npm', name: 'other' } }],
    })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
    expect(r.problems[0]?.message).toContain('other-facts')
  })

  test('a restricted aggregate: every name carries @<scope>/, and the suffix goes after the base name', async () => {
    const ok = await check({
      ...shared('@carlos-space/demo-facts', '@carlos-space/demo-facts.npm', '@carlos-space/demo-facts.go'),
      policy: restricted,
    })
    expect([ok.code, ok.problems]).toEqual([0, []])
    const bare = await check({
      ...shared('@carlos-space/demo-facts', 'demo-facts.npm', '@carlos-space/demo-facts.go'),
      policy: restricted,
    })
    expect([bare.code, codes(bare)]).toEqual([1, ['facts-name']])
    const metaBare = await check({
      ...shared('demo-facts', '@carlos-space/demo-facts.npm', '@carlos-space/demo-facts.go'),
      policy: restricted,
    })
    expect([metaBare.code, codes(metaBare)]).toEqual([1, ['facts-name']])
    expect(metaBare.problems[0]?.message).toContain('@carlos-space/demo-facts')
  })

  test('facts-name: a public aggregate with a prefix on a name', async () => {
    const r = await check({
      ...shared('demo-facts', '@carlos-space/demo-facts.npm', 'demo-facts.go'),
      policy: { ...pub, scope: '@carlos-space' },
    })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
  })

  test('the prefix follows the aggregate unit, not the unit a component describes: that unit is not in the policy', async () => {
    const repo = { ...shared('@carlos-space/demo-facts', 'demo-facts.npm', 'demo-facts.go'), policy: restricted }
    const bare = await check({ ...repo, parts: [{ name: 'product-web-facts', describes: 'product-web' }] })
    expect([bare.code, codes(bare)]).toEqual([1, ['facts-name']])
    const prefixed = await check({
      ...repo,
      parts: [{ name: '@carlos-space/product-web-facts', describes: 'product-web' }],
    })
    expect([prefixed.code, prefixed.problems]).toEqual([0, []])
  })

  test('the prefix follows the aggregate unit, not the unit a component describes: that unit is public in the policy', async () => {
    const policy = {
      ...restricted,
      units: {
        'demo-facts': { kind: 'package', stages: ['ga'] },
        'product-web': { kind: 'package', stages: ['ga'], access: 'public' },
      },
    }
    const repo = { aggregate: '@carlos-space/demo-facts', policy }
    const bare = await check({ ...repo, parts: [{ name: 'product-web-facts', describes: 'product-web' }] })
    expect([bare.code, codes(bare)]).toEqual([1, ['facts-name']])
    const prefixed = await check({
      ...repo,
      parts: [{ name: '@carlos-space/product-web-facts', describes: 'product-web' }],
    })
    expect([prefixed.code, prefixed.problems]).toEqual([0, []])
  })

  test('the access of the aggregate unit overrides the one of the repository, both ways', async () => {
    const unit = (access: string) => ({ 'demo-facts': { kind: 'package', stages: ['ga'], access } })
    const part = { describes: 'git' }
    const over = await check({
      aggregate: '@carlos-space/demo-facts',
      parts: [{ ...part, name: '@carlos-space/git-facts' }],
      policy: { ...pub, scope: '@carlos-space', units: unit('restricted') },
    })
    expect([over.code, over.problems]).toEqual([0, []])
    const under = await check({
      aggregate: 'demo-facts',
      parts: [{ ...part, name: 'git-facts' }],
      policy: { ...restricted, units: unit('public') },
    })
    expect([under.code, under.problems]).toEqual([0, []])
  })

  test('the aggregate unit is read from release-please-config.json, else from the aggregate name', async () => {
    const policy = {
      ...restricted,
      access: 'public',
      units: { 'my-unit': { kind: 'package', stages: ['ga'], access: 'restricted' } },
    }
    const repo = {
      aggregate: '@carlos-space/demo-facts',
      parts: [{ name: '@carlos-space/git-facts', describes: 'git' }],
      policy,
    }
    expect((await check({ ...repo, unit: 'my-unit' })).code).toBe(0)
    // The unit is not in the policy under that name, so the repository access (public) applies.
    expect(codes(await check({ ...repo, unit: 'unknown' }))).toEqual(['facts-name', 'facts-name'])
  })

  test('policy-scope: restricted with no top-level scope, in the repository or in a unit', async () => {
    const parts = [{ name: 'demo-facts.npm', describes: 'demo', publish: npm }]
    const top = await check({ aggregate: 'demo-facts', parts, policy: { ...pub, access: 'restricted' } })
    expect([top.code, codes(top)]).toEqual([1, ['policy-scope']])
    expect(top.problems[0]).toMatchObject({ location: 'release-policy.json' })
    const unit = await check({
      aggregate: 'demo-facts',
      parts,
      policy: { ...pub, units: { 'other-unit': { kind: 'package', stages: ['ga'], access: 'restricted' } } },
    })
    expect(codes(unit)).toEqual(['policy-scope'])
    // With a scope, or with nothing restricted, the rule is quiet.
    expect(codes(await check({ aggregate: 'demo-facts', parts, policy: pub }))).toEqual([])
  })

  test('no release-policy.json: the names are not checked', async () => {
    const r = await check(shared('demo-facts', 'whatever', 'anything'))
    expect([r.code, r.problems]).toEqual([0, []])
  })

  test('a component that is not in node_modules is found through the packages of pnpm-workspace.yaml', async () => {
    const parts = [
      { name: 'demo-facts.npm', describes: 'demo', publish: npm, dir: 'packages/a/npm' },
      { name: 'demo-facts', describes: 'demo-go', publish: go, dir: 'packages/a/go' },
    ]
    const repo = { aggregate: 'demo-facts', policy: pub, parts, workspace: ['packages/*/*', 'facts'] }
    // The wrong name is found without a link, so it is reported, and nothing is skipped.
    const r = await check(repo, { install: false })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
    expect(r.problems[0]?.message).toContain('demo-facts.go')
    expect(r.stderr).not.toContain('warning')
    const ok = await check(
      { ...repo, parts: [parts[0] as Part, { ...(parts[1] as Part), name: 'demo-facts.go' }] },
      { install: false },
    )
    expect([ok.code, ok.problems, ok.stderr]).toEqual([0, [], expect.not.stringContaining('warning')])
    // `**` reaches any depth, and a pattern with a leading `./` or a trailing `/` still matches.
    const deep = await check({ ...repo, workspace: ['./packages/**/'] }, { install: false })
    expect(codes(deep)).toEqual(['facts-name'])
  })

  test('a component that is neither in node_modules nor in the workspace is a warning, not silence', async () => {
    const repo = { ...shared('demo-facts', 'demo-facts', 'demo-facts.go'), policy: pub }
    for (const workspace of [undefined, ['elsewhere/*']]) {
      const r = await check({ ...repo, ...(workspace ? { workspace } : {}) }, { install: false })
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('warning facts-name: demo-facts.go')
      expect(r.stderr).toContain('pnpm-workspace.yaml')
    }
  })

  test('a component whose facts cannot be loaded is a warning with the reason, and its name is not checked', async () => {
    const r = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [{ name: 'wrong-facts', describes: 'demo', source: 'throw new Error("boom")\n' }],
    })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('warning facts-name: wrong-facts')
    expect(r.stderr).toContain('boom')
  })

  test('the facts of a component are read from the factsDir of its own config', async () => {
    const parts = [{ name: 'demo-facts.npm', describes: 'demo', publish: npm, factsDir: 'src-facts' }]
    const ok = await check({ aggregate: 'demo-facts', policy: pub, parts })
    expect([ok.code, ok.problems, ok.stderr]).toEqual([0, [], expect.not.stringContaining('warning')])
    // Read from the default directory the facts are not found, which would be a warning above. A wrong name is reported.
    const lost = await check({ aggregate: 'demo-facts', policy: pub, parts: [{ ...parts[0], name: 'wrong-facts' }] })
    expect(codes(lost)).toEqual(['facts-name'])
  })

  test('no release-please-config.json: the unit is the one named like the aggregate package', async () => {
    const policy = {
      ...pub,
      scope: '@carlos-space',
      units: { 'demo-facts': { kind: 'package', stages: ['ga'], access: 'restricted' } },
    }
    const parts = [{ name: '@carlos-space/git-facts', describes: 'git' }]
    const repo = { aggregate: '@carlos-space/demo-facts', policy, parts, releasePlease: null }
    expect((await check(repo)).code).toBe(0)
    // Another aggregate name finds no unit, so the repository access (public) applies and the prefix is extra.
    const other = await check({ ...repo, aggregate: '@carlos-space/other-facts' })
    expect(codes(other)).toEqual(['facts-name', 'facts-name'])
  })

  test('an aggregate at the repository root is the release-please path ".", and an entry with no component is named by its directory', async () => {
    const units = { 'root-unit': { kind: 'package', stages: ['ga'], access: 'restricted' } }
    const policy = { ...pub, scope: '@carlos-space', units }
    const parts = [{ name: '@carlos-space/git-facts', describes: 'git' }]
    const root = await check({
      aggregate: '@carlos-space/demo-facts',
      policy,
      parts,
      aggregateDir: '.',
      releasePlease: { packages: { '.': { component: 'root-unit' } } },
    })
    expect([root.code, root.problems]).toEqual([0, []])
    const named = await check({
      aggregate: '@carlos-space/demo-facts',
      policy: { ...policy, units: { facts: units['root-unit'] } },
      parts,
      releasePlease: { packages: { facts: {} } },
    })
    expect([named.code, named.problems]).toEqual([0, []])
  })

  test('facts-name: a base name shared with the aggregate by a component with no publish target', async () => {
    const r = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [{ name: 'demo-facts-part', describes: 'demo' }],
    })
    expect([r.code, codes(r)]).toEqual([1, ['facts-name']])
    expect(r.problems[0]?.message).toContain('no publish target')
  })

  test('a component that describes no version is named by its sub-path, and the root one has no name to go by', async () => {
    const root = { name: 'demo-facts.npm', describes: 'demo', publish: npm }
    const ok = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [root, { name: 'sub1-facts', describes: '' }],
    })
    expect([ok.code, ok.problems, ok.stderr]).toEqual([0, [], expect.not.stringContaining('warning')])
    const bad = await check({
      aggregate: 'demo-facts',
      policy: pub,
      parts: [root, { name: 'other-facts', describes: '' }],
    })
    expect(codes(bad)).toEqual(['facts-name'])
    expect(bad.problems[0]?.message).toContain('sub1-facts')
    const lone = await check({ aggregate: 'demo-facts', policy: pub, parts: [{ name: 'whatever', describes: '' }] })
    expect([lone.code, lone.stderr]).toEqual([0, expect.stringContaining('warning facts-name: whatever')])
  })
})
