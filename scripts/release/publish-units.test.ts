import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// publish-units.sh finds its repo from its own location, so each case copies the script into a throwaway
// git repo that holds one package at the version under test. PUBLISH_CHECK_ONLY=1 stops the script after
// the checks, so nothing is packed, no registry is asked and nothing is uploaded.
const script = join(import.meta.dirname, 'publish-units.sh')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']

function fixture(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-units-'))
  made.push(dir)
  mkdirSync(join(dir, 'scripts/release'), { recursive: true })
  mkdirSync(join(dir, 'js'), { recursive: true })
  cpSync(script, join(dir, 'scripts/release/publish-units.sh'))
  const json = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2))
  json('js/package.json', { name: 'fact-kit', version })
  json('.release-please-manifest.json', { js: version })
  json('release-please-config.json', { packages: { js: { component: 'fact-kit' } } })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git(...identity, 'commit', '-q', '-m', 'test fixture')
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
