import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const readJson = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, any>
const readText = (file: string) => readFileSync(join(root, file), 'utf8')

const config = readJson('release-please-config.json')
const manifest = readJson('.release-please-manifest.json')
const policy = readJson('release-policy.json')

// path → component → release-type. The component of a unit is its directory name. The Swift package is a
// complete SwiftPM package in its own directory, which a later step mirrors into a repository of its own.
const expected: Record<string, { component: string; type: string }> = {
  'packages/fact-kit-js': { component: 'fact-kit-js', type: 'node' },
  facts: { component: 'fact-kit-facts', type: 'node' },
  'packages/fact-kit-py': { component: 'fact-kit-py', type: 'python' },
  'packages/fact-kit-rs': { component: 'fact-kit-rs', type: 'rust' },
  'packages/fact-kit-go': { component: 'fact-kit-go', type: 'go' },
  'packages/fact-kit-swift': { component: 'fact-kit-swift', type: 'simple' },
}

// On main the config lists every unit. A release branch scopes it to the units of its train
// (cut-release.sh --units), so the config may list fewer packages than the manifest, never more. The
// manifest always keeps every unit: release-please reads the other units' versions from it, and
// merge-back restores main's entries.
test('the manifest lists every package and the config lists some of them', () => {
  expect(Object.keys(manifest).sort()).toEqual(Object.keys(expected).sort())
  const configured = Object.keys(config.packages)
  expect(configured.length).toBeGreaterThan(0)
  for (const path of configured) expect(Object.keys(manifest), path).toContain(path)
})

test('every configured path has the component and release-type of its unit', () => {
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    expect(entry.component, path).toBe(expected[path].component)
    expect(entry['release-type'], path).toBe(expected[path].type)
  }
})

// The npm package name of a unit is its PublishName (fact-kit), or the MetaFactName (fact-kit-facts) for the
// aggregate of the facts. It need not equal the component, which is the directory name.
test('every npm unit has a package.json, and its component is the name of its directory', () => {
  const publishNames: Record<string, string> = { 'packages/fact-kit-js': 'fact-kit', facts: 'fact-kit-facts' }
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    expect(entry.component, path).toBe(path.split('/').at(-1) === 'facts' ? 'fact-kit-facts' : path.split('/').at(-1))
    if (entry['release-type'] !== 'node') continue
    expect(existsSync(join(root, path, 'package.json')), path).toBe(true)
    expect(readJson(`${path}/package.json`).name, path).toBe(publishNames[path])
  }
})

test('tags are <component>/v<version>, one version line per component, one Release PR per train', () => {
  expect(config['include-component-in-tag']).toBe(true)
  expect(config['tag-separator']).toBe('/')
  expect(config['include-v-in-tag']).toBe(true)
  expect(config['bump-minor-pre-major']).toBe(true)
  expect(config['initial-version']).toBe('0.1.0')
  // false: a train is one release/vX.Y branch, so its units share a single Release PR. linked-versions is
  // not used, so the units still version independently.
  expect(config['separate-pull-requests']).toBe(false)
})

// unit_tag in scripts/lib/common.sh reads this rule; snapshot.sh, publish-units.sh and finalize-release.sh
// all name tags through it.
test('every unit gets the tag <component>/v<version>', () => {
  const tag = (path: string, version: string) =>
    execFileSync(
      'jq',
      ['-r', '--arg', 'p', path, '--arg', 'v', version, '-f', 'scripts/lib/unit-tag.jq', 'release-please-config.json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ).trim()
  const cases: [string, string, string][] = [
    ['packages/fact-kit-js', '0.8.0', 'fact-kit-js/v0.8.0'],
    ['facts', '0.2.0', 'fact-kit-facts/v0.2.0'],
    ['packages/fact-kit-py', '0.3.0-alpha.1', 'fact-kit-py/v0.3.0-alpha.1'],
    ['packages/fact-kit-rs', '0.3.0', 'fact-kit-rs/v0.3.0'],
    ['packages/fact-kit-go', '0.3.0', 'fact-kit-go/v0.3.0'],
    ['packages/fact-kit-swift', '0.3.0', 'fact-kit-swift/v0.3.0'],
    ['packages/fact-kit-swift', '0.3.0-alpha.1', 'fact-kit-swift/v0.3.0-alpha.1'],
  ]
  // a release branch lists only the train's units, so check the ones this config has
  for (const [path, version, want] of cases) {
    if (path in config.packages) expect(tag(path, version), path).toBe(want)
  }
  for (const path of Object.keys(expected).filter((p) => !(p in config.packages))) {
    expect(() => tag(path, '1.0.0'), `${path} is not in this config, so it has no tag shape here`).toThrow()
  }
})

test('every package.json version equals its manifest version', () => {
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    if (entry['release-type'] !== 'node') continue
    expect(readJson(`${path}/package.json`).version, path).toBe(manifest[path])
  }
})

test('the version file of the Python and Rust units equals the manifest version', () => {
  const python = /^version = "([^"]+)"$/m.exec(readText('packages/fact-kit-py/pyproject.toml'))?.[1]
  const rust = /^version = "([^"]+)"$/m.exec(readText('packages/fact-kit-rs/Cargo.toml'))?.[1]
  expect(python).toBe(manifest['packages/fact-kit-py'])
  expect(rust).toBe(manifest['packages/fact-kit-rs'])
  // Cargo.lock names the crate too, and publish uses --locked
  expect(/name = "fact-kit"\nversion = "([^"]+)"/.exec(readText('packages/fact-kit-rs/Cargo.lock'))?.[1]).toBe(
    manifest['packages/fact-kit-rs'],
  )
})

// The Swift package carries its own Package.swift, so SwiftPM reads it from the directory of the unit and the unit
// needs no exclude-paths or special tag shape. The mirror repository takes the directory as its root.
test('the Swift unit is a complete SwiftPM package in its own directory and every unit has the same tag shape', () => {
  for (const file of ['Package.swift', 'Package.resolved', 'Sources/FactKit/Read.swift', 'Tests/FactKitTests']) {
    expect(existsSync(join(root, 'packages/fact-kit-swift', file)), file).toBe(true)
  }
  expect(existsSync(join(root, 'Package.swift'))).toBe(false)
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    expect(entry['include-component-in-tag'], path).toBeUndefined()
    expect(entry['include-v-in-tag'], path).toBeUndefined()
    expect(entry['exclude-paths'], path).toBeUndefined()
  }
})

// Every directory under packages/ is a unit of its own.
test('every directory under packages/ is a unit of the manifest', () => {
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/${d.name}`)
  for (const dir of dirs) expect(Object.keys(manifest), dir).toContain(dir)
})

// scripts/ci/check-release-policy.sh of git-flow-template compares the same two lists every day.
// The policy lists every unit, as main's config does; a release branch's config lists only the train's units.
test('release-policy.json lists exactly the components of every unit, each with alpha and ga', () => {
  const components = Object.values(expected)
    .map((unit) => unit.component)
    .sort()
  expect(Object.keys(policy.units).sort()).toEqual(components)
  for (const entry of Object.values<any>(config.packages)) expect(Object.keys(policy.units)).toContain(entry.component)
  for (const [unit, entry] of Object.entries<any>(policy.units)) {
    expect(entry.kind, unit).toBe('package')
    expect(entry.stages, unit).toEqual(['alpha', 'ga'])
  }
})
