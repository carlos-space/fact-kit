import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// publish-units.sh finds its repo from its own location and sources scripts/lib, so each case copies both into
// a throwaway git repo that holds one package at the version under test. PUBLISH_CHECK_ONLY=1 stops the script
// after the checks, so nothing is packed, no registry is asked and nothing is uploaded.
const script = join(import.meta.dirname, 'publish-units.sh')
const lib = join(import.meta.dirname, '..', 'lib')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']

// The tag shape of the real config, which the fixtures need because the script reads it: <component>/v<version>.
const tagShape = { 'include-component-in-tag': true, 'include-v-in-tag': true, 'tag-separator': '/' }

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'publish-units-'))
  made.push(dir)
  mkdirSync(join(dir, 'scripts/release'), { recursive: true })
  cpSync(script, join(dir, 'scripts/release/publish-units.sh'))
  cpSync(lib, join(dir, 'scripts/lib'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const json = (file: string, value: unknown) => write(file, JSON.stringify(value, null, 2))
  const commit = (message = 'test fixture') => {
    git('add', '-A')
    git(...identity, 'commit', '-q', '-m', message)
  }
  git('init', '-q')
  return { dir, git, write, json, commit }
}

function fixture(version: string) {
  const { dir, git, json, commit } = repo()
  json('packages/fact-kit-js/package.json', { name: 'fact-kit', version })
  json('.release-please-manifest.json', { 'packages/fact-kit-js': version })
  json('release-please-config.json', {
    ...tagShape,
    packages: { 'packages/fact-kit-js': { component: 'fact-kit-js', 'release-type': 'node' } },
  })
  commit()
  return { dir, git }
}

function run(dir: string, ...args: string[]) {
  const r = spawnSync('bash', [join(dir, 'scripts/release/publish-units.sh'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PUBLISH_CHECK_ONLY: '1' },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('publish-units.sh stage and dist-tag checks', () => {
  test('a prerelease version with stage ga is refused', () => {
    const { dir } = fixture('0.4.1-alpha.1')
    const r = run(dir, 'ga', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage alpha, but this release's stage is ga/)
  })

  test('a prerelease version with stage latest is refused', () => {
    const { dir } = fixture('0.4.1-alpha.1')
    const r = run(dir, 'latest', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/stage "latest" is not alpha, beta, rc or ga/)
  })

  test('a stable version with stage alpha is refused', () => {
    const { dir } = fixture('0.4.1')
    const r = run(dir, 'alpha', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage ga, but this release's stage is alpha/)
  })

  test('a prerelease version with a different prerelease stage is refused', () => {
    const { dir } = fixture('0.4.1-beta.2')
    const r = run(dir, 'rc', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage beta, but this release's stage is rc/)
  })

  test('a version that is not X.Y.Z or X.Y.Z-<stage>.N is refused', () => {
    const { dir } = fixture('0.4.1-staging.1')
    const r = run(dir, 'alpha', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/release stage is unknown/)
  })

  test.each([
    ['0.4.1-alpha.1', 'alpha', 'alpha'],
    ['0.4.1-beta.1', 'beta', 'beta'],
    ['0.4.1-rc.3', 'rc', 'rc'],
    ['0.4.1', 'ga', 'latest'],
  ])('version %s with stage %s passes the checks and would publish under dist-tag %s', (version, stage, tag) => {
    const { dir } = fixture(version)
    const r = run(dir, stage, 'packages/fact-kit-js')
    expect(r.out).toContain(`check only: fact-kit@${version} passed (stage ${stage}, dist-tag ${tag})`)
    expect(r.status).toBe(0)
  })

  test('the stage is required', () => {
    const { dir } = fixture('0.4.1-alpha.1')
    const r = run(dir, 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/usage: publish-units\.sh <alpha\|beta\|rc\|ga>/)
  })
})

describe('publish-units.sh same-content check against the tag', () => {
  test('the package equal to its tag passes', () => {
    const { dir, git } = fixture('0.4.1-alpha.1')
    git('tag', 'fact-kit-js/v0.4.1-alpha.1')
    expect(run(dir, 'alpha', 'packages/fact-kit-js').status).toBe(0)
  })

  test('the package changed since its tag is refused', () => {
    const { dir, git } = fixture('0.4.1-alpha.1')
    git('tag', 'fact-kit-js/v0.4.1-alpha.1')
    writeFileSync(join(dir, 'packages/fact-kit-js/index.js'), 'export {}\n')
    git('add', '-A')
    git(...identity, 'commit', '-q', '-m', 'change after the tag')
    const r = run(dir, 'alpha', 'packages/fact-kit-js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag fact-kit-js\/v0\.4\.1-alpha\.1 不同/)
  })
})

// The facts package at a GA version, with a built index whose facts are the case under test. The rows are those
// of check's train-next rule: when.since, and variants[].since without pending.
function factsPackage(facts: unknown[], entry = 'dist/index.json') {
  const r = repo()
  r.json('facts/package.json', { name: 'fact-kit-facts', version: '0.6.1' })
  r.json(`facts/${entry}`, { indexFormat: '1.1', component: 'fact-kit-js', facts })
  r.json('.release-please-manifest.json', { facts: '0.6.1' })
  r.json('release-please-config.json', {
    ...tagShape,
    packages: { facts: { component: 'fact-kit-facts', 'release-type': 'node' } },
  })
  r.commit()
  return r
}

const fact = (id: string, extra: object) => ({ id, tool: 'fact-kit', content: { value: 1 }, ...extra })

describe('publish-units.sh refuses facts rows that still start at "next"', () => {
  test.each([
    ['a variant row at "next"', fact('fact-kit.a', { variants: [{ since: 'next', content: { value: 2 } }] })],
    [
      'a variant row whose release lines end in "next"',
      fact('fact-kit.a', { variants: [{ since: ['0.10.0', 'next'], content: { value: 2 } }] }),
    ],
    ['a fact whose when.since is "next"', fact('fact-kit.a', { when: { since: 'next' } })],
  ])('%s is refused and named', (_, bad) => {
    const { dir } = factsPackage([fact('fact-kit.ok', {}), bad])
    const r = run(dir, 'ga', 'facts')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/facts: index\.json still has rows that start at "next" \(fact-kit\.a\)/)
  })

  test('an entry index under dist/<entry>/ is checked too', () => {
    const { dir } = factsPackage([fact('fact-kit.a', { when: { since: 'next' } })], 'dist/fact-kit-py/index.json')
    const r = run(dir, 'ga', 'facts')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/fact-kit-py\/index\.json still has rows that start at "next"/)
  })

  test.each([
    ['pinned rows', fact('fact-kit.a', { when: { since: '0.11.0' }, variants: [{ since: '0.11.0', content: {} }] })],
    ['a pending row at "next"', fact('fact-kit.a', { variants: [{ since: 'next', pending: 'x', content: {} }] })],
    ['"next" inside the content, not a row', fact('fact-kit.a', { content: { value: [{ since: 'next' }] } })],
    [
      'release lines that only name "next" before the end',
      fact('fact-kit.a', { variants: [{ since: ['next', '0.11.0'], content: {} }] }),
    ],
  ])('%s pass', (_, ok) => {
    const { dir } = factsPackage([ok])
    const r = run(dir, 'ga', 'facts')
    expect(r.out).toContain('check only: fact-kit-facts@0.6.1 passed (stage ga, dist-tag latest)')
    expect(r.status).toBe(0)
  })
})

// One fixture with a unit of every kind, each at the version under test. Only the shape of the files matters
// here: the checks read the manifest, the unit's own version file, the tag and the registry file.
function allKinds(version: string) {
  const r = repo()
  r.json('packages/fact-kit-js/package.json', { name: 'fact-kit', version })
  r.write('packages/fact-kit-py/pyproject.toml', `[project]\nname = "fact-kit"\nversion = "${version}"\n`)
  r.write('packages/fact-kit-rs/Cargo.toml', `[package]\nname = "fact-kit"\nversion = "${version}"\n`)
  r.write('packages/fact-kit-go/go.mod', 'module github.com/carlos-space/fact-kit-go\n\ngo 1.26\n')
  r.write('packages/fact-kit-swift/Package.swift', 'let package = Package(\n  name: "FactKit",\n  products: []\n)\n')
  r.write('packages/fact-kit-swift/Sources/FactKit/Read.swift', '// swift\n')
  r.write('packages/fact-kit-js/src/index.ts', 'export {}\n')
  r.json('package.json', { name: 'fact-kit-monorepo', version: '0.2.0', private: true })
  r.json('.release-please-manifest.json', {
    'packages/fact-kit-js': version,
    'packages/fact-kit-py': version,
    'packages/fact-kit-rs': version,
    'packages/fact-kit-go': version,
    'packages/fact-kit-swift': version,
  })
  r.json('release-please-config.json', {
    ...tagShape,
    packages: {
      'packages/fact-kit-js': { component: 'fact-kit-js', 'release-type': 'node' },
      'packages/fact-kit-py': { component: 'fact-kit-py', 'release-type': 'python' },
      'packages/fact-kit-rs': { component: 'fact-kit-rs', 'release-type': 'rust' },
      'packages/fact-kit-go': { component: 'fact-kit-go', 'release-type': 'go' },
      'packages/fact-kit-swift': { component: 'fact-kit-swift', 'release-type': 'simple' },
    },
  })
  r.commit()
  return r
}

describe('publish-units.sh with the reader units', () => {
  test.each([
    ['packages/fact-kit-py', /check only: fact-kit 0\.3\.0-alpha\.1 passed \(stage alpha, PyPI\)/],
    ['packages/fact-kit-rs', /check only: fact-kit 0\.3\.0-alpha\.1 passed \(stage alpha, crates\.io\)/],
    [
      'packages/fact-kit-go',
      /check only: Go module github\.com\/carlos-space\/fact-kit-go 0\.3\.0-alpha\.1 passed \(stage alpha, tag fact-kit-go\/v0\.3\.0-alpha\.1\)/,
    ],
    [
      'packages/fact-kit-swift',
      /check only: Swift package FactKit 0\.3\.0-alpha\.1 passed \(stage alpha, tag fact-kit-swift\/v0\.3\.0-alpha\.1\)/,
    ],
  ])('%s passes the checks and names its registry and tag', (path, pattern) => {
    const { dir } = allKinds('0.3.0-alpha.1')
    const r = run(dir, 'alpha', path)
    expect(r.out).toMatch(pattern)
    expect(r.status).toBe(0)
  })

  test('a unit file that does not carry the manifest version is refused', () => {
    const { dir, write, commit } = allKinds('0.3.0-alpha.1')
    write('packages/fact-kit-py/pyproject.toml', '[project]\nname = "fact-kit"\nversion = "0.0.0"\n')
    commit()
    const r = run(dir, 'alpha', 'packages/fact-kit-py')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/manifest says 0\.3\.0-alpha\.1 but packages\/fact-kit-py\/pyproject\.toml says 0\.0\.0/)
  })

  test('--registries names the registry of each unit', () => {
    const { dir } = allKinds('0.3.0-alpha.1')
    const r = spawnSync(
      'bash',
      [
        join(dir, 'scripts/release/publish-units.sh'),
        '--registries',
        'packages/fact-kit-js',
        'packages/fact-kit-py',
        'packages/fact-kit-rs',
        'packages/fact-kit-go',
        'packages/fact-kit-swift',
      ],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    )
    expect(r.stdout.trim().split('\n')).toEqual(['crates=true', 'go=true', 'npm=true', 'pypi=true', 'swift=true'])
  })

  test('the Swift unit is compared with fact-kit-swift/v<version>, and only on its own files', () => {
    const { dir, git, write, commit } = allKinds('0.3.0-alpha.1')
    git('tag', 'fact-kit-swift/v0.3.0-alpha.1')
    // the other units and the root files are not the Swift unit: changing them after the tag is fine
    write('packages/fact-kit-js/src/index.ts', 'export const changed = 1\n')
    write('README.md', 'changed\n')
    commit('change outside the Swift unit')
    expect(run(dir, 'alpha', 'packages/fact-kit-swift').status).toBe(0)
    write('packages/fact-kit-swift/Sources/FactKit/Read.swift', '// changed after the tag\n')
    commit('change inside the Swift unit')
    const r = run(dir, 'alpha', 'packages/fact-kit-swift')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag fact-kit-swift\/v0\.3\.0-alpha\.1 不同/)
  })

  test('the Go unit is compared with fact-kit-go/v<version>', () => {
    const { dir, git, write, commit } = allKinds('0.3.0-alpha.1')
    git('tag', 'fact-kit-go/v0.3.0-alpha.1')
    write('packages/fact-kit-go/read.go', 'package factkit\n')
    commit('change after the tag')
    const r = run(dir, 'alpha', 'packages/fact-kit-go')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag fact-kit-go\/v0\.3\.0-alpha\.1 不同/)
  })
})
