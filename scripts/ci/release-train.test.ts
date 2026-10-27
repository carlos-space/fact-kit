import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// release-train.sh asks GitHub for the open Release PR of a branch. A fake `gh` on PATH answers from files, so
// nothing leaves the machine.
const script = join(import.meta.dirname, 'release-train.sh')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { prs: { headRefName: string }[]; manifest: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'release-train-'))
  made.push(dir)
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  cpSync(script, join(dir, 'scripts/ci/release-train.sh'))
  writeFileSync(
    join(dir, 'release-please-config.json'),
    JSON.stringify({
      packages: { 'packages/fact-kit-js': { component: 'fact-kit-js' }, facts: { component: 'fact-kit-facts' } },
    }),
  )
  writeFileSync(
    join(dir, 'release-policy.json'),
    JSON.stringify({ units: { 'fact-kit-js': {}, 'fact-kit-facts': {}, 'fact-kit-py': {} } }),
  )
  writeFileSync(join(dir, 'prs.json'), JSON.stringify(options.prs))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(options.manifest))
  // `gh pr list ... --jq <filter>` and `gh api ... --jq .content`: the fake applies the filter with jq itself.
  writeFileSync(
    join(dir, 'bin/gh'),
    [
      '#!/usr/bin/env bash',
      'filter=""; args=("$@")',
      'for ((i = 0; i < ${#args[@]}; i++)); do [[ "${args[i]}" == --jq ]] && filter="${args[i + 1]}"; done',
      'echo "$*" >> "$FAKE_GH_LOG"',
      'if [[ "$1" == pr ]]; then jq -r "$filter" "$FAKE_DIR/prs.json"',
      'else jq -c "{content: (tojson | @base64)}" "$FAKE_DIR/manifest.json" | jq -r "$filter"; fi',
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'bin/gh'), 0o755)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function run(dir: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync('bash', [join(dir, 'scripts/ci/release-train.sh'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_GH_LOG: join(dir, 'gh.log'),
      ...env,
    },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('release-train.sh', () => {
  const env = { BRANCH: 'release/v0.8', REPO: 'o/r' }

  test('prints the version of the unit that the Release PR manifest holds', () => {
    const dir = fixture({
      prs: [{ headRefName: 'feature/x' }, { headRefName: 'release-please--branches--release/v0.8' }],
      manifest: { 'packages/fact-kit-js': '0.8.0-alpha.1', facts: '0.2.0' },
    })
    const r = run(dir, env)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('FACT_KIT_TRAIN=--train fact-kit=0.8.0-alpha.1\n')
  })

  test('names the describes key of the unit when it is given, and the component when it is not', () => {
    const dir = fixture({
      prs: [{ headRefName: 'release-please--branches--release/v0.8' }],
      manifest: { 'packages/fact-kit-js': '0.8.0', facts: '0.2.0' },
    })
    expect(run(dir, env, 'fact-kit-js', 'fact-kit').stdout).toBe('FACT_KIT_TRAIN=--train fact-kit=0.8.0\n')
    expect(run(dir, env, 'fact-kit-js').stdout).toBe('FACT_KIT_TRAIN=--train fact-kit-js=0.8.0\n')
  })

  test('takes the unit of another component from the config', () => {
    const dir = fixture({
      prs: [{ headRefName: 'release-please--branches--release/v0.8' }],
      manifest: { 'packages/fact-kit-js': '0.8.0', facts: '0.2.0' },
    })
    expect(run(dir, env, 'fact-kit-facts').stdout).toBe('FACT_KIT_TRAIN=--train fact-kit-facts=0.2.0\n')
  })

  test('prints nothing when the branch has no open Release PR', () => {
    const dir = fixture({ prs: [{ headRefName: 'feature/x' }], manifest: {} })
    const r = run(dir, env)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('no open Release PR')
  })

  test('prints nothing for a unit of the policy that is not on this train', () => {
    const dir = fixture({ prs: [{ headRefName: 'release-please--branches--release/v0.8' }], manifest: {} })
    const r = run(dir, env, 'fact-kit-py')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('fact-kit-py is not on the train of release/v0.8')
  })

  test('fails when the manifest has no version for the unit, and when the component is unknown', () => {
    const dir = fixture({
      prs: [{ headRefName: 'release-please--branches--release/v0.8' }],
      manifest: { facts: '1.0.0' },
    })
    expect(run(dir, env).status).not.toBe(0)
    expect(run(dir, env, 'nope').stderr).toContain('no unit of component nope')
  })
})
