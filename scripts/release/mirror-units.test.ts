import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// mirror-units.sh finds its repo from its own location and sources scripts/lib, so each case copies both into a
// throwaway git repo that holds a Go and a Swift package, and uses a local bare repository as the mirror
// (MIRROR_REMOTE), so nothing leaves the machine.
const script = join(import.meta.dirname, 'mirror-units.sh')
const lib = join(import.meta.dirname, '..', 'lib')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']
const tagShape = { 'include-component-in-tag': true, 'include-v-in-tag': true, 'tag-separator': '/' }
const units = {
  go: { path: 'packages/fact-kit-go', file: 'go.mod', body: 'module github.com/carlos-space/fact-kit-go\n' },
  swift: { path: 'packages/fact-kit-swift', file: 'Package.swift', body: '// swift-tools-version: 5.9\n' },
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-units-'))
  made.push(dir)
  const git = (...args: string[]) =>
    execFileSync('git', [...identity, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  mkdirSync(join(dir, 'scripts/release'), { recursive: true })
  cpSync(script, join(dir, 'scripts/release/mirror-units.sh'))
  cpSync(lib, join(dir, 'scripts/lib'), { recursive: true })
  git('init', '-q', '-b', 'main')
  write(
    'release-please-config.json',
    JSON.stringify({
      ...tagShape,
      packages: {
        'packages/fact-kit-go': { component: 'fact-kit-go', 'release-type': 'go' },
        'packages/fact-kit-swift': { component: 'fact-kit-swift', 'release-type': 'simple' },
        'packages/fact-kit-js': { component: 'fact-kit-js', 'release-type': 'node' },
      },
    }),
  )
  write('packages/fact-kit-js/package.json', '{"name":"fact-kit","version":"0.8.0"}')
  for (const u of Object.values(units)) write(`${u.path}/${u.file}`, u.body)
  const manifest = (versions: Record<string, string>) =>
    write('.release-please-manifest.json', JSON.stringify(versions))
  const commit = (message: string) => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
  }
  // A release: write the version into the manifest, commit, and tag the unit like release-please does.
  const release = (unit: keyof typeof units, version: string, change = `change for ${version}`) => {
    const u = units[unit]
    write(`${u.path}/notes.txt`, change)
    manifest({ [u.path]: version })
    commit(`release ${unit} ${version}`)
    git('tag', '-f', `fact-kit-${unit}/v${version}`)
  }
  const mirror = join(dir, 'mirror.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', mirror])
  const mirrorGit = (...args: string[]) =>
    execFileSync('git', ['--git-dir', mirror, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [join(dir, 'scripts/release/mirror-units.sh'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, MIRROR_REMOTE: mirror, ...env },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  return { dir, git, write, manifest, commit, release, mirror, mirrorGit, run }
}

describe('mirror-units.sh', () => {
  test.each([
    ['go', '0.3.0-alpha.2', 'v0.3.0-alpha.2'],
    ['go', '1.2.0', 'v1.2.0'],
    ['swift', '0.3.0-alpha.2', '0.3.0-alpha.2'],
    ['swift', '1.2.0', '1.2.0'],
  ] as const)('%s %s is tagged %s in the mirror, and the package is at the mirror root', (unit, version, tag) => {
    const t = setup()
    t.release(unit, version)
    const r = t.run([units[unit].path])
    expect(r.status, r.out).toBe(0)
    expect(t.mirrorGit('tag', '--list').split('\n')).toEqual([tag])
    expect(t.mirrorGit('rev-parse', 'refs/heads/main')).toBe(t.mirrorGit('rev-parse', `${tag}^{commit}`))
    expect(t.mirrorGit('ls-tree', '--name-only', 'main').split('\n')).toContain(units[unit].file)
    expect(t.mirrorGit('ls-tree', '--name-only', 'main')).not.toMatch(/packages/)
  })

  test('a rerun changes nothing and says the version is already mirrored', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.2')
    expect(t.run([units.go.path]).status).toBe(0)
    const before = t.mirrorGit('for-each-ref')
    const r = t.run([units.go.path])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/already mirrored/)
    expect(t.mirrorGit('for-each-ref')).toBe(before)
  })

  test('a later release is a fast-forward of main, and a change outside the unit adds no mirror commit', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.1')
    expect(t.run([units.go.path]).status).toBe(0)
    const first = t.mirrorGit('rev-parse', 'main')
    t.write('README.md', 'something outside the unit')
    t.commit('docs: outside the unit')
    t.release('go', '0.3.0-alpha.2')
    const r = t.run([units.go.path])
    expect(r.status, r.out).toBe(0)
    const second = t.mirrorGit('rev-parse', 'main')
    expect(second).not.toBe(first)
    expect(t.mirrorGit('merge-base', '--is-ancestor', first, second)).toBe('')
    expect(t.mirrorGit('rev-list', '--count', `${first}..${second}`)).toBe('1')
    expect(t.mirrorGit('tag', '--list').split('\n')).toEqual(['v0.3.0-alpha.1', 'v0.3.0-alpha.2'])
  })

  test('the mirror commits are the same when computed twice', () => {
    const a = setup()
    a.release('swift', '0.3.0-alpha.1')
    a.run([units.swift.path])
    const first = a.mirrorGit('rev-parse', 'main')
    rmSync(join(a.mirror), { recursive: true, force: true })
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', a.mirror])
    a.run([units.swift.path])
    expect(a.mirrorGit('rev-parse', 'main')).toBe(first)
  })

  test('an older version dispatched again after a newer one only adds its tag', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.1')
    t.release('go', '0.3.0-alpha.2')
    // alpha.2 is mirrored first (a gap), then alpha.1 arrives
    expect(t.run([units.go.path]).status).toBe(0)
    const main = t.mirrorGit('rev-parse', 'main')
    t.manifest({ [units.go.path]: '0.3.0-alpha.1' })
    const r = t.run([units.go.path])
    expect(r.status, r.out).toBe(0)
    expect(t.mirrorGit('rev-parse', 'main')).toBe(main)
    expect(t.mirrorGit('tag', '--list').split('\n')).toEqual(['v0.3.0-alpha.1', 'v0.3.0-alpha.2'])
  })

  test('a mirror tag that points at another commit is refused', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.1')
    expect(t.run([units.go.path]).status).toBe(0)
    t.release('go', '0.3.0-alpha.1', 'the same version, different content')
    const r = t.run([units.go.path])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must not move/)
  })

  test('a main that is not an ancestor is refused and nothing is pushed', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.1')
    const other = t.dir + '-other'
    made.push(other)
    execFileSync('git', ['clone', '-q', t.mirror, other], { stdio: 'ignore' })
    writeFileSync(join(other, 'stray.txt'), 'pushed by hand')
    execFileSync('git', [...identity, '-C', other, 'add', '-A'])
    execFileSync('git', [...identity, '-C', other, 'commit', '-q', '-m', 'stray'])
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' })
    const stray = t.mirrorGit('rev-parse', 'main')
    const r = t.run([units.go.path])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/fast-forward/)
    expect(t.mirrorGit('rev-parse', 'main')).toBe(stray)
    expect(t.mirrorGit('tag', '--list')).toBe('')
  })

  test('--dry-run prints the commit, tag and files and pushes nothing', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.2')
    const r = t.run(['--dry-run', units.go.path])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/mirror tag\s+v0\.3\.0-alpha\.2/)
    expect(r.out).toMatch(/split commit\s+[0-9a-f]{40}/)
    expect(r.out).toMatch(/^ {2}go\.mod$/m)
    expect(r.out).toMatch(/^go\.mod: module github\.com\/carlos-space\/fact-kit-go$/m)
    expect(t.mirrorGit('for-each-ref')).toBe('')
  })

  test('--dry-run works before the release tag exists; a real run does not', () => {
    const t = setup()
    t.release('swift', '0.3.0-alpha.1')
    t.git('tag', '-d', 'fact-kit-swift/v0.3.0-alpha.1')
    const dry = t.run(['--dry-run', units.swift.path])
    expect(dry.status, dry.out).toBe(0)
    expect(dry.out).toMatch(/mirror tag\s+0\.3\.0-alpha\.1/)
    const real = t.run([units.swift.path])
    expect(real.status).not.toBe(0)
    expect(real.out).toMatch(/has not been released/)
    expect(t.mirrorGit('for-each-ref')).toBe('')
  })

  test('a unit that is neither Go nor Swift is skipped', () => {
    const t = setup()
    t.release('go', '0.3.0-alpha.1')
    const r = t.run(['packages/fact-kit-js'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/not a Go or Swift unit/)
    expect(t.mirrorGit('for-each-ref')).toBe('')
  })
})
