import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, test } from 'vitest'
import { binPath, cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterAll(() => cleanTmp())

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args])).stdout
const gitMayFail = async (cwd: string, ...args: string[]): Promise<void> => {
  try {
    await git(cwd, ...args)
  } catch {
    // a merge with conflicts exits with 1
  }
}

const FILE = 'facts/demo/index.ts'
const row = (since: string, value = 1): string => `        { since: ${since}, content: { value: ${value} } },\n`
/** Three facts far enough apart that git makes one conflict block for each. */
const source = (a: string, b: string, c: string): string =>
  `export default {
  facts: [
    {
      id: 'demo.a',
      variants: [
${row(a)}      ],
    },
    // ----
    // ----
    // ----
    {
      id: 'demo.b',
      variants: [
${row(b, 2)}      ],
    },
    // ----
    // ----
    // ----
    {
      id: 'demo.c',
      variants: [
${row(c, 3)}      ],
    },
  ],
}
`

/** A repository whose main and patch branches both changed the file, merged with `--no-commit`. */
async function conflicting(
  base: string,
  main: string,
  patch: string,
  style: 'merge' | 'diff3' | 'zdiff3' = 'merge',
): Promise<string> {
  const dir = makeTmp('merge-since')
  writeTree(dir, { 'package.json': { name: 'demo', type: 'module' }, [FILE]: base })
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'base')
  await git(dir, 'checkout', '-q', '-b', 'patch')
  writeFileSync(join(dir, FILE), patch)
  await git(dir, 'commit', '-q', '-am', 'patch')
  await git(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, FILE), main)
  await git(dir, 'commit', '-q', '-am', 'main')
  await gitMayFail(dir, '-c', `merge.conflictStyle=${style}`, 'merge', '--no-ff', '--no-commit', 'patch')
  return dir
}

const text = (dir: string): string => readFileSync(join(dir, FILE), 'utf8')

describe('fact-kit merge-since: conflict blocks', () => {
  test('two sides each added a version: both are kept, in order', async () => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']"),
      source("['0.48.1', '0.50.0']", "['0.48.1']", "['0.48.1']"),
    )
    expect(text(dir)).toContain('<<<<<<<')
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`resolved ${FILE}: 1 block(s)`)
    expect(text(dir)).toBe(source("['0.48.1', '0.49.1', '0.50.0']", "['0.48.1']", "['0.48.1']"))
  })

  test('two versions on one release line: the smaller one stays', async () => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1', '0.49.2']", "['0.48.1']", "['0.48.1']"),
      source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']"),
    )
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(text(dir)).toBe(source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']"))
  })

  test('next goes last, and a pre-release is smaller than its release', async () => {
    const base = source("['0.48.1']", "'next'", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1']", "['0.48.1', 'next']", "['0.48.1', '0.49.0']"),
      source("['0.48.1']", "['0.48.2', 'next']", "['0.48.1', '0.49.0-alpha.1']"),
    )
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(text(dir)).toBe(source("['0.48.1']", "['0.48.1', 'next']", "['0.48.1', '0.49.0-alpha.1']"))
  })

  test.each(['diff3', 'zdiff3'] as const)('reads the %s marker style', async (style) => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1', '0.49.1']", "'0.40.0'", "['0.48.1']"),
      source("['0.48.1', '0.50.0']", "'0.40.0'", "['0.48.1']"),
      style,
    )
    expect(text(dir)).toContain('|||||||')
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(text(dir)).toBe(source("['0.48.1', '0.49.1', '0.50.0']", "'0.40.0'", "['0.48.1']"))
  })

  test('a block that differs elsewhere stays, with file and line, and the other blocks are written', async () => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const mainSide = source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']").replace('value: 3', 'value: 30')
    const patchSide = source("['0.48.1', '0.50.0']", "['0.48.1']", "['0.48.1', '0.49.0']").replace(
      /value: 3/,
      'value: 31',
    )
    const dir = await conflicting(base, mainSide, patchSide)
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code).toBe(1)
    const after = text(dir)
    // The first block was settled and written, the third is still a conflict.
    expect(after).toContain(`{ since: ['0.48.1', '0.49.1', '0.50.0'], content: { value: 1 } }`)
    const line = after.split('\n').findIndex((l) => l.startsWith('<<<<<<<')) + 1
    expect(line).toBeGreaterThan(0)
    expect(r.stderr).toContain(`${FILE}:${line} the two sides differ in more than the "since" values`)
    expect(r.stderr).toContain('1 conflict(s) left')
    // Run again: nothing more happens, the same line is reported.
    const again = await cli(['merge-since', '--cwd', dir])
    expect(again.code).toBe(1)
    expect(again.stderr).toContain(`${FILE}:${line} `)
    expect(text(dir)).toBe(after)
  })

  test('a since that is not a version is left as it is', async () => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1', 'soon']", "['0.48.1']", "['0.48.1']"),
      source("['0.48.1', '0.50.0']", "['0.48.1']", "['0.48.1']"),
    )
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`${FILE}:`)
    expect(r.stderr).toContain('"soon" is not a version')
  })

  test('keeps CRLF line endings', async () => {
    const crlf = (s: string): string => s.replaceAll('\n', '\r\n')
    const base = crlf(source("['0.48.1']", "['0.48.1']", "['0.48.1']"))
    const dir = await conflicting(
      base,
      crlf(source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']")),
      crlf(source("['0.48.1', '0.50.0']", "['0.48.1']", "['0.48.1']")),
    )
    expect((await cli(['merge-since', '--cwd', dir])).code).toBe(0)
    expect(text(dir)).toBe(crlf(source("['0.48.1', '0.49.1', '0.50.0']", "['0.48.1']", "['0.48.1']")))
  })

  test('only reads files under --cwd', async () => {
    const base = source("['0.48.1']", "['0.48.1']", "['0.48.1']")
    const dir = await conflicting(
      base,
      source("['0.48.1', '0.49.1']", "['0.48.1']", "['0.48.1']"),
      source("['0.48.1', '0.50.0']", "['0.48.1']", "['0.48.1']"),
    )
    const other = join(dir, 'other')
    writeTree(dir, { 'other/x.txt': 'x\n' })
    const r = await cli(['merge-since', '--cwd', other])
    expect(r.code).toBe(0)
    expect(text(dir)).toContain('<<<<<<<')
  })
})

describe('fact-kit merge-since: rows only the merged-in side has', () => {
  const MAIN_ROW = row("'0.7.1'", 1)
  const body = (rows: string, tail = ''): string =>
    `export default {\n  facts: [\n    {\n      id: 'demo.a',\n      variants: [\n${rows}      ],\n    },\n${tail}  ],\n}\n`

  async function patched(): Promise<string> {
    const dir = makeTmp('merge-since-normalize')
    const base = body(MAIN_ROW, '    // ----\n    // ----\n    // ----\n    // ----\n')
    writeTree(dir, { 'package.json': { name: 'demo', type: 'module' }, [FILE]: base })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'base')
    await git(dir, 'checkout', '-q', '-b', 'patch')
    writeFileSync(
      join(dir, FILE),
      body(MAIN_ROW + row("'0.49.1'", 2), '    // ----\n    // ----\n    // ----\n    // ----\n'),
    )
    await git(dir, 'commit', '-q', '-am', 'patch')
    await git(dir, 'checkout', '-q', 'main')
    writeFileSync(
      join(dir, FILE),
      base.replace(
        '    // ----\n    // ----\n    // ----\n    // ----\n',
        '    // ----\n    // ----\n    // ----\n    // main\n',
      ),
    )
    await git(dir, 'commit', '-q', '-am', 'main')
    await git(dir, 'merge', '--no-ff', '--no-commit', 'patch')
    return dir
  }

  test('a new single patch version becomes [version, next], an old one stays', async () => {
    const dir = await patched()
    expect(text(dir)).toContain(`since: '0.49.1'`)
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`normalized ${FILE}:`)
    const after = text(dir)
    expect(after).toContain(`{ since: ['0.49.1', 'next'], content: { value: 2 } }`)
    expect(after).toContain(`{ since: '0.7.1', content: { value: 1 } }`)
    // Run again: no difference.
    const second = await cli(['merge-since', '--cwd', dir])
    expect(second.code).toBe(0)
    expect(second.stdout).not.toContain('normalized')
    expect(text(dir)).toBe(after)
  })

  test('a minor version, a pre-release and a pending row are not rewritten', async () => {
    const dir = await patched()
    writeFileSync(
      join(dir, FILE),
      body(
        MAIN_ROW +
          row("'0.50.0'", 3) +
          row("'0.49.2-alpha.1'", 4) +
          `        { since: '0.49.3', pending: 'x', content: { value: 5 } },\n` +
          row("['0.49.4']", 6),
      ),
    )
    const before = text(dir)
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(text(dir)).toBe(before)
  })

  test('works once the merge is committed, from the first parent', async () => {
    const dir = await patched()
    await git(dir, 'commit', '-q', '-m', 'merge')
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code, r.stderr).toBe(0)
    expect(text(dir)).toContain(`{ since: ['0.49.1', 'next'], content: { value: 2 } }`)
  })

  test('outside a merge it exits with 2', async () => {
    const dir = makeTmp('merge-since-none')
    writeTree(dir, { 'package.json': { name: 'demo' } })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', 'base')
    const r = await cli(['merge-since', '--cwd', dir])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('no merge to read')
    const notGit = makeTmp('merge-since-nogit')
    expect((await cli(['merge-since', '--cwd', notGit])).code).toBe(2)
  })

  test('without oxc-parser it names the package and exits with 2', async () => {
    const dir = await patched()
    const block =
      'data:text/javascript,' +
      encodeURIComponent(
        `import { register } from 'node:module'; register('data:text/javascript,' + encodeURIComponent("export async function resolve(s, c, n) { if (s === 'oxc-parser') { const e = new Error('Cannot find package'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e } return n(s, c) }"))`,
      )
    let code = 0
    let stderr = ''
    try {
      await run(process.execPath, ['--import', block, binPath, 'merge-since', '--cwd', dir])
    } catch (error) {
      code = (error as { code: number }).code
      stderr = (error as { stderr: string }).stderr
    }
    expect(code).toBe(2)
    expect(stderr).toContain('pnpm add -D oxc-parser')
  })
})
