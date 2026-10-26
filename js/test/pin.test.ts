import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, test } from 'vitest'
import { binPath, cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterAll(() => cleanTmp())

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args])).stdout

/** A component package with every shape of `since` that `pin` meets, and a `_lib` file. */
const SOURCE = `import { history } from 'fact-kit'
import { shared } from '../_lib/shared.ts'

export default {
  describes: { demo: 'next' },
  facts: [
    {
      id: 'demo.single',
      title: '釘版 😀 中文', content: { value: 1 }, variants: [{ since: 'next', content: { value: 1 } }],
    },
    {
      id: 'demo.array',
      variants: [
        { since: ['0.48.1', 'next'], content: { value: 2 } },
        { since: ["0.47.0", "next"], content: { value: 3 } },
      ],
    },
    {
      id: 'demo.pending',
      variants: [
        { since: 'next', pending: 'later', content: { value: 4 } },
        { since: ['0.48.1', 'next'], 'pending': 'later', content: { value: 5 } },
        { since: 'next', pending: undefined, content: { value: 6 } },
      ],
    },
    {
      id: 'demo.history',
      variants: history(
        { since: '0.40.0', value: { a: 1 } },
        { since: ['0.48.1', 'next'], set: { '/b': { since: 'next' } } },
        { since: 'next', pending: 'later', set: { '/c': 1 } },
      ),
    },
    { id: 'demo.pinned', variants: [{ since: '0.45.0', content: { value: 7 } }] },
    { id: 'demo.when', when: { since: 'next' }, content: { value: 8 } },
    { id: 'demo.spread', variants: [{ ...shared, since: 'next', content: { value: 9 } }] },
    { id: 'demo.template', variants: [{ since: \`next\`, content: { value: 10 } }] },
  ],
}
`
const LIB = `export const shared = { stability: 'experimental' }\nexport const row = { since: 'next' }\n`

async function sample(source = SOURCE): Promise<string> {
  const dir = makeTmp('pin')
  writeTree(dir, {
    'package.json': { name: 'demo', type: 'module' },
    'facts/demo/index.ts': source,
    'facts/_lib/shared.ts': LIB,
  })
  await git(dir, 'init', '-q')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

const changedLines = (diff: string): string[] => diff.split('\n').filter((l) => /^[+-][^+-]/.test(l))

describe('fact-kit pin --version', () => {
  test('pins the next of rows that are not pending, and nothing else', async () => {
    const dir = await sample()
    const r = await cli(['pin', '--version', '0.49.0', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    const lines = changedLines(await git(dir, 'diff'))
    const text = lines.join('\n')
    // The files that changed.
    expect(await git(dir, 'diff', '--name-only')).toBe('facts/demo/index.ts\n')
    // 9 rows were pinned: single, 2 array, the pending: undefined row, history array, 'when', template, spread is left.
    const after = readFileSync(join(dir, 'facts/demo/index.ts'), 'utf8')
    expect(after).toContain(`variants: [{ since: '0.49.0', content: { value: 1 } }]`)
    expect(after).toContain(`{ since: ['0.48.1', '0.49.0'], content: { value: 2 } }`)
    expect(after).toContain(`{ since: ["0.47.0", "0.49.0"], content: { value: 3 } }`)
    expect(after).toContain(`{ since: '0.49.0', pending: undefined, content: { value: 6 } }`)
    expect(after).toContain(`{ since: ['0.48.1', '0.49.0'], set: { '/b': { since: 'next' } } }`)
    expect(after).toContain(`when: { since: '0.49.0' }`)
    expect(after).toContain('since: `0.49.0`')
    // Left alone: pending rows, a pending label that may hide in a spread, describes, data in content, history pending.
    expect(after).toContain(`{ since: 'next', pending: 'later', content: { value: 4 } }`)
    expect(after).toContain(`{ since: ['0.48.1', 'next'], 'pending': 'later', content: { value: 5 } }`)
    expect(after).toContain(`{ since: 'next', pending: 'later', set: { '/c': 1 } }`)
    expect(after).toContain(`{ ...shared, since: 'next', content: { value: 9 } }`)
    expect(after).toContain(`describes: { demo: 'next' }`)
    // Every changed line changed only inside a since.
    expect(lines.filter((l) => l.startsWith('-')).length).toBe(lines.filter((l) => l.startsWith('+')).length)
    expect(text).not.toContain('describes')
    expect(r.stderr).toMatch(/demo\.spread|index\.ts:\d+ a spread or computed key may hide "pending"/)
    expect(r.stdout).toContain('7 "next" pinned to 0.49.0 in 1 file(s)')
  })

  test('does not read facts/_lib', async () => {
    const dir = await sample()
    await cli(['pin', '--version', '0.49.0', '--cwd', dir])
    expect(await git(dir, 'diff', '--', 'facts/_lib')).toBe('')
    expect(readFileSync(join(dir, 'facts/_lib/shared.ts'), 'utf8')).toBe(LIB)
  })

  test('a second run changes nothing', async () => {
    const dir = await sample()
    await cli(['pin', '--version', '0.49.0', '--cwd', dir])
    const once = await git(dir, 'diff')
    const r = await cli(['pin', '--version', '0.49.0', '--cwd', dir])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('0 "next" pinned')
    expect(await git(dir, 'diff')).toBe(once)
    // A different version does not move what is pinned either.
    await cli(['pin', '--version', '0.50.0', '--cwd', dir])
    expect(await git(dir, 'diff')).toBe(once)
  })

  test('a pre-release is pinned as the whole string', async () => {
    const dir = await sample()
    const r = await cli(['pin', '--version', '0.49.0-alpha.1', '--cwd', dir])
    expect(r.code).toBe(0)
    const after = readFileSync(join(dir, 'facts/demo/index.ts'), 'utf8')
    expect(after).toContain(`{ since: ['0.48.1', '0.49.0-alpha.1'], content: { value: 2 } }`)
    expect(after).toContain(`variants: [{ since: '0.49.0-alpha.1', content: { value: 1 } }]`)
    const again = await cli(['pin', '--version', '0.49.0-alpha.1', '--cwd', dir])
    expect(again.stdout).toContain('0 "next" pinned')
    const stable = await git(dir, 'diff')
    // Build metadata is accepted and written as given.
    expect((await cli(['pin', '--version', '0.50.0+build.5', '--cwd', dir])).code).toBe(0)
    expect(await git(dir, 'diff')).toBe(stable)
  })

  test('takes one --version, and a semver one', async () => {
    const dir = await sample()
    const two = await cli(['pin', '--version', '0.49.0', '--version', '0.50.0', '--cwd', dir])
    expect(two.code).toBe(2)
    expect(two.stderr).toContain('pin takes one --version, got 2 (0.49.0, 0.50.0). Nothing was changed')
    expect(await git(dir, 'status', '--porcelain')).toBe('')
    for (const bad of ['0.49', 'v0.49.0', 'next', '']) {
      const r = await cli(['pin', '--version', bad, '--cwd', dir])
      expect(r.code, bad).toBe(2)
      expect(r.stderr).toContain('semver')
    }
    const none = await cli(['pin', '--cwd', dir])
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('--version <v> is required')
    expect(await git(dir, 'status', '--porcelain')).toBe('')
  })

  test('writes nothing when a file does not parse', async () => {
    const dir = await sample()
    writeTree(dir, { 'facts/zzz/index.ts': 'export default {\n' })
    const r = await cli(['pin', '--version', '0.49.0', '--cwd', dir])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('facts/zzz/index.ts: cannot parse')
    expect(await git(dir, 'diff')).toBe('')
  })

  test('offsets are right after characters outside ASCII', async () => {
    // oxc reports UTF-16 offsets, as JavaScript strings index, so text with CJK and surrogate pairs on the way is fine.
    const source = `export default { facts: [${Array.from({ length: 5 }, (_, i) => `{ id: 'x.${i}', title: '中文${'😀'.repeat(i + 1)}字', since: ['0.1.0', 'next'] }`).join(',\n')}] }\n`
    const dir = await sample(source)
    expect((await cli(['pin', '--version', '1.2.3', '--cwd', dir])).code).toBe(0)
    const after = readFileSync(join(dir, 'facts/demo/index.ts'), 'utf8')
    expect(after).toBe(source.replaceAll(`'next'`, `'1.2.3'`))
  })

  test('uses facts-dir from the config', async () => {
    const dir = makeTmp('pin-config')
    writeTree(dir, {
      'fact-kit.config.json': { factsDir: 'src-facts' },
      'src-facts/a/index.ts': `export default { facts: [{ since: 'next' }] }\n`,
      'facts/a/index.ts': `export default { facts: [{ since: 'next' }] }\n`,
    })
    expect((await cli(['pin', '--version', '1.0.0', '--cwd', dir])).code).toBe(0)
    expect(readFileSync(join(dir, 'src-facts/a/index.ts'), 'utf8')).toContain(`'1.0.0'`)
    expect(readFileSync(join(dir, 'facts/a/index.ts'), 'utf8')).toContain(`'next'`)
  })

  test('without oxc-parser it names the package and exits with 2', async () => {
    const dir = await sample()
    const block =
      'data:text/javascript,' +
      encodeURIComponent(
        `import { register } from 'node:module'; register('data:text/javascript,' + encodeURIComponent("export async function resolve(s, c, n) { if (s === 'oxc-parser') { const e = new Error('Cannot find package'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e } return n(s, c) }"))`,
      )
    let result: { code: number; stderr: string }
    try {
      await run(process.execPath, ['--import', block, binPath, 'pin', '--version', '1.0.0', '--cwd', dir])
      result = { code: 0, stderr: '' }
    } catch (error) {
      const e = error as { code: number; stderr: string }
      result = { code: e.code, stderr: e.stderr }
    }
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('pnpm add -D oxc-parser')
    expect(await git(dir, 'diff')).toBe('')
  })
})
