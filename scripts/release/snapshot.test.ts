import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// snapshot.sh sources scripts/lib from its own location and reads the config, the manifest and the tags of the
// repo it runs in, so each case copies both into a throwaway git repo. The repo stands for the tree a product
// tag points at: the tip of a release branch, whose config lists only the units of that release line while the
// manifest still holds every unit.
const script = join(import.meta.dirname, 'snapshot.sh')
const lib = join(import.meta.dirname, '..', 'lib')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com']

function releaseBranchTip(tags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'))
  made.push(dir)
  const git = (...args: string[]) => execFileSync('git', [...identity, ...args], { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, 'scripts/release'), { recursive: true })
  cpSync(script, join(dir, 'scripts/release/snapshot.sh'))
  cpSync(lib, join(dir, 'scripts/lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.0' }))
  writeFileSync(
    join(dir, 'release-please-config.json'),
    JSON.stringify({
      'include-component-in-tag': true,
      'tag-separator': '/',
      packages: { 'packages/fact-kit-py': { component: 'fact-kit-py' } },
    }),
  )
  writeFileSync(
    join(dir, '.release-please-manifest.json'),
    JSON.stringify({ 'packages/fact-kit-js': '0.8.0', 'packages/fact-kit-py': '0.3.0' }),
  )
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  for (const tag of tags) git('tag', tag)
  return () =>
    execFileSync('bash', ['scripts/release/snapshot.sh', '--product', '0.3.0', '--check-tags'], {
      cwd: dir,
      encoding: 'utf8',
    })
}

describe('snapshot.sh', () => {
  test('marks a unit the config of the release line does not list as not in this release', () => {
    const out = releaseBranchTip(['v0.3.0', 'fact-kit-py/v0.3.0'])()
    expect(out).toContain('| fact-kit-js | packages/fact-kit-js | 0.8.0 | 未入版（不在這次的發布設定） |')
    expect(out).toContain('| fact-kit-py | packages/fact-kit-py | 0.3.0 | fact-kit-py/v0.3.0 ✓ |')
  })

  test('still reports the missing tag of a unit on the release line', () => {
    const out = releaseBranchTip(['v0.3.0', 'fact-kit-py/v0.2.0'])()
    expect(out).toContain('| fact-kit-py | packages/fact-kit-py | 0.3.0 | fact-kit-py/v0.3.0 ✗ missing |')
  })
})
