import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const readJson = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, any>
const readText = (file: string) => readFileSync(join(root, file), 'utf8')

const config = readJson('release-please-config.json')
const manifest = readJson('.release-please-manifest.json')
const policy = readJson('release-policy.json')

// path → component → release-type. The Swift unit sits at "." because SwiftPM only reads Package.swift at the
// repository root.
const expected: Record<string, { component: string; type: string }> = {
  js: { component: 'fact-kit', type: 'node' },
  facts: { component: 'fact-kit-facts', type: 'node' },
  py: { component: 'py', type: 'python' },
  rs: { component: 'rs', type: 'rust' },
  go: { component: 'go', type: 'go' },
  '.': { component: 'swift', type: 'simple' },
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

test('every npm unit has a package.json whose name matches its component', () => {
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    if (entry['release-type'] !== 'node') continue
    expect(existsSync(join(root, path, 'package.json')), path).toBe(true)
    const pkgName = readJson(`${path}/package.json`).name as string
    expect(pkgName.replace(/^@[^/]+\//, '')).toBe(entry.component)
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
test('each unit gets its own tag shape: the Swift unit a bare version, the others <component>/v<version>', () => {
  const tag = (path: string, version: string) =>
    execFileSync(
      'jq',
      ['-r', '--arg', 'p', path, '--arg', 'v', version, '-f', 'scripts/lib/unit-tag.jq', 'release-please-config.json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ).trim()
  expect(tag('js', '0.8.0')).toBe('fact-kit/v0.8.0')
  expect(tag('facts', '0.2.0')).toBe('fact-kit-facts/v0.2.0')
  expect(tag('py', '0.3.0-alpha.1')).toBe('py/v0.3.0-alpha.1')
  expect(tag('rs', '0.3.0')).toBe('rs/v0.3.0')
  expect(tag('go', '0.3.0')).toBe('go/v0.3.0')
  expect(tag('.', '0.3.0')).toBe('0.3.0')
  expect(tag('.', '0.3.0-alpha.1')).toBe('0.3.0-alpha.1')
})

test('every package.json version equals its manifest version', () => {
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    if (entry['release-type'] !== 'node') continue
    expect(readJson(`${path}/package.json`).version, path).toBe(manifest[path])
  }
})

test('the version file of the Python and Rust units equals the manifest version', () => {
  const python = /^version = "([^"]+)"$/m.exec(readText('py/pyproject.toml'))?.[1]
  const rust = /^version = "([^"]+)"$/m.exec(readText('rs/Cargo.toml'))?.[1]
  expect(python).toBe(manifest.py)
  expect(rust).toBe(manifest.rs)
  // Cargo.lock names the crate too, and publish uses --locked
  expect(/name = "fact-kit"\nversion = "([^"]+)"/.exec(readText('rs/Cargo.lock'))?.[1]).toBe(manifest.rs)
})

// The Swift unit is registered at the repository root, so release-please would hand it every commit. Its
// exclude-paths take away the commits that touch only other units. release-please matches directories, so
// every top-level directory that is not Swift has to be listed, or a commit that touches only that directory
// releases the Swift unit.
test('every top-level directory that is not Swift is in the exclude-paths of the Swift unit', () => {
  const swiftOwned = ['Sources', 'Tests', 'swift']
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file.includes('/'))
    .map((file) => file.split('/')[0])
  const directories = [...new Set(tracked)].sort()
  const excluded: string[] = config.packages['.']['exclude-paths']
  for (const dir of directories) {
    if (swiftOwned.includes(dir)) expect(excluded, dir).not.toContain(dir)
    else expect(excluded, `${dir} is a top-level directory, so it must be in exclude-paths of "."`).toContain(dir)
  }
  for (const dir of excluded) expect(directories, `${dir} is in exclude-paths but is not a directory`).toContain(dir)
})

test('the Swift unit carries no component and no v in its tag, and the others keep both', () => {
  const swift = config.packages['.']
  expect(swift['include-component-in-tag']).toBe(false)
  expect(swift['include-v-in-tag']).toBe(false)
  for (const [path, entry] of Object.entries<any>(config.packages)) {
    if (path === '.') continue
    expect(entry['include-component-in-tag'], path).toBeUndefined()
    expect(entry['include-v-in-tag'], path).toBeUndefined()
  }
})

// scripts/ci/check-release-policy.sh of git-flow-template compares the same two lists every day.
test('release-policy.json lists exactly the components of the config, each with alpha and ga', () => {
  const components = Object.values<any>(config.packages)
    .map((entry) => entry.component)
    .sort()
  expect(Object.keys(policy.units).sort()).toEqual(components)
  for (const [unit, entry] of Object.entries<any>(policy.units)) {
    expect(entry.kind, unit).toBe('package')
    expect(entry.stages, unit).toEqual(['alpha', 'ga'])
  }
})
