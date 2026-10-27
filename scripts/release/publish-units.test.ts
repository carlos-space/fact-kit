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

// The tag shape of the real config, which the fixtures need because the script reads it: <component>/v<version>,
// and for the Swift unit at "." the bare version.
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
  json('js/package.json', { name: 'fact-kit', version })
  json('.release-please-manifest.json', { js: version })
  json('release-please-config.json', {
    ...tagShape,
    packages: { js: { component: 'fact-kit', 'release-type': 'node' } },
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
    const r = run(dir, 'ga', 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage alpha, but this release's stage is ga/)
  })

  test('a prerelease version with stage latest is refused', () => {
    const { dir } = fixture('0.4.1-alpha.1')
    const r = run(dir, 'latest', 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/stage "latest" is not alpha, beta, rc or ga/)
  })

  test('a stable version with stage alpha is refused', () => {
    const { dir } = fixture('0.4.1')
    const r = run(dir, 'alpha', 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage ga, but this release's stage is alpha/)
  })

  test('a prerelease version with a different prerelease stage is refused', () => {
    const { dir } = fixture('0.4.1-beta.2')
    const r = run(dir, 'rc', 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/belongs to stage beta, but this release's stage is rc/)
  })

  test('a version that is not X.Y.Z or X.Y.Z-<stage>.N is refused', () => {
    const { dir } = fixture('0.4.1-staging.1')
    const r = run(dir, 'alpha', 'js')
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
    const r = run(dir, stage, 'js')
    expect(r.out).toContain(`check only: fact-kit@${version} passed (stage ${stage}, dist-tag ${tag})`)
    expect(r.status).toBe(0)
  })

  test('the stage is required', () => {
    const { dir } = fixture('0.4.1-alpha.1')
    const r = run(dir, 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/usage: publish-units\.sh <alpha\|beta\|rc\|ga>/)
  })
})

describe('publish-units.sh same-content check against the tag', () => {
  test('the package equal to its tag passes', () => {
    const { dir, git } = fixture('0.4.1-alpha.1')
    git('tag', 'fact-kit/v0.4.1-alpha.1')
    expect(run(dir, 'alpha', 'js').status).toBe(0)
  })

  test('the package changed since its tag is refused', () => {
    const { dir, git } = fixture('0.4.1-alpha.1')
    git('tag', 'fact-kit/v0.4.1-alpha.1')
    writeFileSync(join(dir, 'js/index.js'), 'export {}\n')
    git('add', '-A')
    git(...identity, 'commit', '-q', '-m', 'change after the tag')
    const r = run(dir, 'alpha', 'js')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag fact-kit\/v0\.4\.1-alpha\.1 不同/)
  })
})

// One fixture with a unit of every kind, each at the version under test. Only the shape of the files matters
// here: the checks read the manifest, the unit's own version file, the tag and the registry file.
function allKinds(version: string) {
  const r = repo()
  r.json('js/package.json', { name: 'fact-kit', version })
  r.write('py/pyproject.toml', `[project]\nname = "fact-kit"\nversion = "${version}"\n`)
  r.write('rs/Cargo.toml', `[package]\nname = "fact-kit"\nversion = "${version}"\n`)
  r.write('go/go.mod', 'module github.com/carlos-space/fact-kit/go\n\ngo 1.26\n')
  r.write('Package.swift', 'let package = Package(\n  name: "FactKit",\n  products: []\n)\n')
  r.write('swift/Sources/FactKit/Read.swift', '// swift\n')
  r.write('js/src/index.ts', 'export {}\n')
  r.json('package.json', { name: 'fact-kit-monorepo', version: '0.2.0', private: true })
  r.json('.release-please-manifest.json', { js: version, py: version, rs: version, go: version, '.': version })
  r.json('release-please-config.json', {
    ...tagShape,
    packages: {
      js: { component: 'fact-kit', 'release-type': 'node' },
      py: { component: 'py', 'release-type': 'python' },
      rs: { component: 'rs', 'release-type': 'rust' },
      go: { component: 'go', 'release-type': 'go' },
      '.': {
        component: 'swift',
        'release-type': 'simple',
        'include-component-in-tag': false,
        'include-v-in-tag': false,
        'exclude-paths': ['js', 'py', 'rs', 'go'],
      },
    },
  })
  r.commit()
  return r
}

describe('publish-units.sh with the reader units', () => {
  test.each([
    ['py', /check only: fact-kit 0\.3\.0-alpha\.1 passed \(stage alpha, PyPI\)/],
    ['rs', /check only: fact-kit 0\.3\.0-alpha\.1 passed \(stage alpha, crates\.io\)/],
    [
      'go',
      /check only: Go module github\.com\/carlos-space\/fact-kit\/go 0\.3\.0-alpha\.1 passed \(stage alpha, tag go\/v0\.3\.0-alpha\.1\)/,
    ],
    ['.', /check only: Swift package FactKit 0\.3\.0-alpha\.1 passed \(stage alpha, tag 0\.3\.0-alpha\.1\)/],
  ])('%s passes the checks and names its registry and tag', (path, pattern) => {
    const { dir } = allKinds('0.3.0-alpha.1')
    const r = run(dir, 'alpha', path)
    expect(r.out).toMatch(pattern)
    expect(r.status).toBe(0)
  })

  test('a unit file that does not carry the manifest version is refused', () => {
    const { dir, write, commit } = allKinds('0.3.0-alpha.1')
    write('py/pyproject.toml', '[project]\nname = "fact-kit"\nversion = "0.0.0"\n')
    commit()
    const r = run(dir, 'alpha', 'py')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/manifest says 0\.3\.0-alpha\.1 but py\/pyproject\.toml says 0\.0\.0/)
  })

  test('--registries names the registry of each unit, the Swift unit at the root included', () => {
    const { dir } = allKinds('0.3.0-alpha.1')
    const r = spawnSync(
      'bash',
      [join(dir, 'scripts/release/publish-units.sh'), '--registries', 'js', 'py', 'rs', 'go', '.'],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    )
    expect(r.stdout.trim().split('\n')).toEqual(['crates=true', 'go=true', 'npm=true', 'pypi=true', 'swift=true'])
  })

  test('the Swift unit is compared with its bare tag, and only on its own files', () => {
    const { dir, git, write, commit } = allKinds('0.3.0-alpha.1')
    git('tag', '0.3.0-alpha.1')
    // js/ and the root files are not the Swift unit: changing them after the tag is fine
    write('js/src/index.ts', 'export const changed = 1\n')
    write('README.md', 'changed\n')
    commit('change outside the Swift unit')
    expect(run(dir, 'alpha', '.').status).toBe(0)
    write('swift/Sources/FactKit/Read.swift', '// changed after the tag\n')
    commit('change inside the Swift unit')
    const r = run(dir, 'alpha', '.')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag 0\.3\.0-alpha\.1 不同/)
  })

  test('the Go unit is compared with go/v<version>', () => {
    const { dir, git, write, commit } = allKinds('0.3.0-alpha.1')
    git('tag', 'go/v0.3.0-alpha.1')
    write('go/read.go', 'package factkit\n')
    commit('change after the tag')
    const r = run(dir, 'alpha', 'go')
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/內容和 tag go\/v0\.3\.0-alpha\.1 不同/)
  })
})
