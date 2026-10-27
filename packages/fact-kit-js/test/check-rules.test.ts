import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module' }

/** An entry holding the given facts (as source text), describing demo 1.2.0 unless told otherwise. */
const entry = (facts: string[], describes = "{ demo: '1.2.0' }", before = '') =>
  `${before}export default { describes: ${describes}, facts: [${facts.join(', ')}] }\n`
const fact = (name: string, more = '') =>
  `{ id: 'demo.${name}', tool: 'demo', topics: ['t'], title: '${name}', content: { value: 1 }, source: { kind: 'published' }${more} }`
const rows = (...variants: string[]) => `, variants: [${variants.join(', ')}]`
const row = (since: string, more = '') => `{ since: ${since}, content: { value: 1 }${more} }`

interface Run {
  code: number
  problems: { code: string; message: string; location: string | null }[]
  stderr: string
}

async function check(files: Record<string, unknown>, args: string[] = []): Promise<Run> {
  const dir = makeTmp('rules')
  writeTree(dir, { 'package.json': pkg, ...files })
  const r = await cli(['check', '--cwd', dir, '--json', ...args])
  let problems: Run['problems'] = []
  try {
    problems = JSON.parse(r.stdout).problems
  } catch {
    // exit code 2 prints no JSON
  }
  return { code: r.code, problems, stderr: r.stderr }
}
const codes = (r: Run) => r.problems.map((p) => p.code)

describe('c004 check: the rules of m149/d011', () => {
  test('a clean package: exit 0, no problems', async () => {
    const r = await check({ 'facts/a/index.ts': entry([fact('one', rows(row("'1.0.0'"), row("'next'")))]) })
    expect(r.code).toBe(0)
    expect(r.problems).toEqual([])
  })

  test('since-format: a since that is not a version', async () => {
    const r = await check({ 'facts/a/index.ts': entry([fact('one', rows(row("'soon'")))]) })
    expect([r.code, codes(r)]).toEqual([1, ['since-format']])
  })

  test('describes: more than one component', async () => {
    const r = await check({ 'facts/a/index.ts': entry([fact('one')], "{ demo: '1.0.0', other: '2.0.0' }") })
    expect([r.code, codes(r)]).toEqual([1, ['describes']])
  })

  test('describes: {} is allowed (m149/d016), and so is the same component in two entries', async () => {
    const r = await check({
      'facts/a/index.ts': entry([fact('one')], '{}'),
      'facts/b/index.ts': entry([fact('two')], '{}'),
    })
    expect(r.code).toBe(0)
  })

  test('lib-rows: a row with since in facts/_lib', async () => {
    const r = await check({
      'facts/_lib/rows.ts': "export const rows = [{ since: '1.0.0', content: { value: 1 } }]\nexport const LIMIT = 3\n",
      'facts/a/index.ts': entry([fact('one')]),
    })
    expect([r.code, codes(r)]).toEqual([1, ['lib-rows']])
    expect(r.problems[0]?.location).toBe('facts/_lib/rows.ts:1')
    // Functions and constants are fine, and so is the word in a string or comment.
    const ok = await check({
      'facts/_lib/ok.ts': "// since 1.0\nexport const NOTE = 'since: 1'\nexport const LIMIT = 3\n",
      'facts/a/index.ts': entry([fact('one')]),
    })
    expect(ok.code).toBe(0)
  })

  test('same-line: two versions of one release line in a since array', async () => {
    const r = await check({ 'facts/a/index.ts': entry([fact('one', rows(row("['0.49.0', '0.49.1']")))]) })
    expect([r.code, codes(r)]).toEqual([1, ['same-line']])
    expect(r.problems[0]?.message).toContain('release line 0.49')
  })

  test('relation-cycle: facts that relate to each other in a loop', async () => {
    const r = await check({
      'facts/a/index.ts': [
        `const a = ${fact('a')}`,
        `const b = ${fact('b', ', relates: [a]')}`,
        'a.relates = [b]',
        'export default { describes: { demo: "1.2.0" }, facts: [a, b] }',
        '',
      ].join('\n'),
    })
    expect([r.code, codes(r)]).toEqual([1, ['relation-cycle']])
    expect(r.problems[0]?.message).toMatch(/demo\.a -> demo\.b -> demo\.a|demo\.b -> demo\.a -> demo\.b/)
    // A fact that relates to itself is a loop too, and a chain is not.
    const self = await check({
      'facts/a/index.ts': `const a = ${fact('a')}\na.relates = [a]\nexport default { describes: {}, facts: [a] }\n`,
    })
    expect(codes(self)).toEqual(['relation-cycle'])
    const chain = await check({
      'facts/a/index.ts': `const a = ${fact('a')}\nconst b = ${fact('b', ', relates: [a]')}\nconst c = ${fact('c', ', relates: [a, b]')}\nexport default { describes: {}, facts: [a, b, c] }\n`,
    })
    expect(chain.code).toBe(0)
  })

  test('since-ahead: since newer than describes, until --train names that version', async () => {
    const files = { 'facts/a/index.ts': entry([fact('one', rows(row("'1.0.0'"), row("['1.0.5', '1.3.0']")))]) }
    const r = await check(files)
    expect([r.code, codes(r)]).toEqual([1, ['since-ahead']])
    expect(r.problems[0]?.message).toContain('1.3.0 is newer than demo 1.2.0')
    expect((await check(files, ['--train', 'demo=1.3.0'])).code).toBe(0)
    expect(codes(await check(files, ['--train', 'demo=1.2.9']))).toEqual(['since-ahead'])
    // A train of another component changes nothing here.
    expect(codes(await check(files, ['--train', 'other=9.0.0']))).toEqual(['since-ahead'])
    // "next" is never ahead.
    expect((await check({ 'facts/a/index.ts': entry([fact('one', rows(row("'next'")))]) })).code).toBe(0)
  })

  test('train-next: a component on the train has no next left that is not pending', async () => {
    const files = { 'facts/a/index.ts': entry([fact('one', rows(row("'1.0.0'"), row("['1.1.1', 'next']")))]) }
    expect((await check(files)).code).toBe(0)
    const r = await check(files, ['--train', 'demo=1.2.0'])
    expect([r.code, codes(r)]).toEqual([1, ['train-next']])
    expect(r.problems[0]?.location).toBe('facts/a/index.ts#/facts/0/variants/1/since')
    // A pending row may stay "next" (its label has a test).
    const pending = {
      'facts/a/index.ts': entry([fact('one', rows(row("'1.0.0'"), row("'next'", ", pending: 'later'")))]),
      'fact-kit.config.json': { testDirs: ['test'] },
      'test/later.test.ts': "export const x = { include: ['later'] }\n",
    }
    expect((await check(pending, ['--train', 'demo=1.2.0'])).code).toBe(0)
    // Another component's train does not apply.
    expect((await check(files, ['--train', 'other=1.2.0'])).code).toBe(0)
  })

  test('pending-untested: a pending label that no test includes', async () => {
    const facts = {
      'facts/a/index.ts': entry([fact('one', rows(row("'1.0.0'"), row("'next'", ", pending: 'later'")))]),
    }
    const none = await check(facts)
    expect([none.code, codes(none)]).toEqual([1, ['pending-untested']])
    expect(none.problems[0]?.message).toContain('"later"')
    const other = await check({
      ...facts,
      'fact-kit.config.json': { testDirs: ['test'] },
      'test/x.test.ts': "export const x = { include: ['sooner'] }\n",
    })
    expect(codes(other)).toEqual(['pending-untested'])
    const ok = await check({
      ...facts,
      'fact-kit.config.json': { testDirs: ['test'] },
      'test/x.test.ts':
        "import { readFacts } from 'fact-kit'\nreadFacts('demo-facts/a', { version: 'head', include: ['later'] })\n",
    })
    expect([ok.code, ok.problems]).toEqual([0, []])
  })

  test('doc-unknown-id: fact:<id> in docs that names no fact', async () => {
    const files = {
      'facts/a/index.ts': entry([fact('one')]),
      'fact-kit.config.json': { docsDirs: ['docs'] },
      'docs/guide.md':
        'Line one\nSee fact:demo.one and fact:demo.ghost. Also fact:demo-facts/a:demo.one and fact:demo-facts/a:demo.gone.\n',
    }
    const r = await check(files)
    expect([r.code, codes(r)]).toEqual([1, ['doc-unknown-id', 'doc-unknown-id']])
    expect(r.problems.map((p) => [p.location, /"([^"]+)"/.exec(p.message)?.[1]])).toEqual([
      ['docs/guide.md:2', 'demo.ghost'],
      ['docs/guide.md:2', 'demo-facts/a:demo.gone'],
    ])
    // A spec that is not loaded here can not be checked.
    const far = await check({ ...files, 'docs/guide.md': 'fact:other-facts/x:other.thing and fact:demo.one\n' })
    expect(far.code).toBe(0)
  })

  test('impl-imports-facts: code in implDirs imports a -facts package', async () => {
    const files = {
      'facts/a/index.ts': entry([fact('one')]),
      'fact-kit.config.json': { implDirs: ['src'] },
      'src/cli.ts':
        "import { x } from './x.ts'\nimport facts from '@scope/tool-facts/cli'\nconst y = await import('other-facts')\nconst z = require('demo-facts/a')\nexport { x, facts, y, z }\n",
    }
    const r = await check(files)
    expect([r.code, codes(r)]).toEqual([1, ['impl-imports-facts', 'impl-imports-facts', 'impl-imports-facts']])
    expect(r.problems.map((p) => p.location)).toEqual(['src/cli.ts:2', 'src/cli.ts:3', 'src/cli.ts:4'])
    const ok = await check({
      ...files,
      'src/cli.ts':
        "import { x } from './x.ts'\nimport { y } from 'node:path'\nimport z from 'facts-helper'\nexport { x, y, z }\n",
    })
    expect(ok.code).toBe(0)
  })

  test('impl-reads-facts-dist: code in implDirs names a path in facts/dist', async () => {
    const files = {
      'facts/a/index.ts': entry([fact('one')]),
      'fact-kit.config.json': { implDirs: ['src'] },
      'src/cli.ts': [
        "import data from '../facts/dist/a/index.json'",
        "const text = readFileSync('../facts/dist/a/index.json', 'utf8')",
        "const url = new URL('../../facts/dist/a/index.json', import.meta.url)",
        'const tpl = `${root}/facts/dist/a`',
        'export { data, text, url, tpl }',
        '',
      ].join('\n'),
    }
    const r = await check(files)
    expect([r.code, codes(r)]).toEqual([1, Array(4).fill('impl-reads-facts-dist')])
    expect(r.problems.map((p) => p.location)).toEqual(['src/cli.ts:1', 'src/cli.ts:2', 'src/cli.ts:3', 'src/cli.ts:4'])
    expect(r.problems[0]?.message).toContain('only tests and docs read them')
    // Tests are not in implDirs, and a string that only contains the letters is not a path part.
    const ok = await check({
      ...files,
      'test/read.test.ts': "import data from '../facts/dist/a/index.json'\nexport { data }\n",
      'src/cli.ts':
        "export const a = 'my-facts/distance'\nexport const b = 'facts/dist-old'\nexport const c = 'facts/distance'\n",
    })
    expect([ok.code, ok.problems]).toEqual([0, []])
    // Import of a -facts package and a facts/dist path on one line are both reported.
    const both = await check({ ...files, 'src/cli.ts': "import x from 'demo-facts/facts/dist/a'\nexport { x }\n" })
    expect(codes(both).sort()).toEqual(['impl-imports-facts', 'impl-reads-facts-dist'])
  })

  test('impl-depends-on-facts: a package that is not a facts package lists a -facts package in dependencies', async () => {
    const files = {
      'facts/a/index.ts': entry([fact('one')]),
      'fact-kit.config.json': { repoRoot: '.' },
      'tool/package.json': {
        name: 'tool',
        version: '1.0.0',
        dependencies: { 'tool-facts': '^1.0.0' },
        devDependencies: { 'other-facts': '1' },
      },
      'docs-site/package.json': { name: 'docs-site', dependencies: { react: '1' } },
      'node_modules/dep/package.json': { name: 'dep', dependencies: { 'x-facts': '1' } },
    }
    const r = await check(files)
    expect([r.code, codes(r)]).toEqual([1, ['impl-depends-on-facts']])
    expect(r.problems[0]).toMatchObject({ location: 'tool/package.json' })
    expect(r.problems[0]?.message).toContain('tool-facts')
  })

  test('the pending, doc and implementation rules read code with oxc-parser, which is installed here', async () => {
    const r = await check({
      'facts/a/index.ts': entry([fact('one')]),
      'fact-kit.config.json': { implDirs: ['nope'], testDirs: ['nope'], docsDirs: ['nope'] },
    })
    expect(r.code).toBe(0)
  })
})

describe('c004 check: exit code 2 for bad settings and input', () => {
  const ok = { 'facts/a/index.ts': entry([fact('one')]) }

  test.each([
    ['--train without =', ok, ['--train', 'demo']],
    ['--train with a version that is not semver', ok, ['--train', 'demo=1.x']],
    ['an option check does not have', ok, ['--nope']],
    ['an --index that does not exist', ok, ['--index', 'missing']],
    ['a --config that does not exist', ok, ['--config', 'missing.json']],
    ['a config that is not JSON', { ...ok, 'fact-kit.config.json': '{ nope' }, []],
    ['a config whose setting has the wrong type', { ...ok, 'fact-kit.config.json': { testDirs: 'test' } }, []],
    ['a --cwd that is not a directory', ok, ['--cwd', '/nonexistent-fact-kit-dir']],
  ])('%s', async (_name, files, args) => {
    const dir = makeTmp('exit2')
    writeTree(dir, { 'package.json': pkg, ...files })
    const hasCwd = args.includes('--cwd')
    const r = await cli(['check', ...(hasCwd ? [] : ['--cwd', dir]), ...args])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('fact-kit check:')
    expect(r.stdout).toBe('')
  })

  test('a package without a name, when there are facts, is a bad input', async () => {
    const dir = makeTmp('exit2-name')
    writeTree(dir, { 'package.json': { type: 'module' }, ...ok })
    expect((await cli(['check', '--cwd', dir])).code).toBe(2)
  })

  test('exit 1 stays for what is wrong in the facts, including a module that cannot run', async () => {
    const r = await check({ 'facts/a/index.ts': 'throw new Error("boom")\n' })
    expect([r.code, codes(r)]).toEqual([1, ['load']])
  })

  test('without --json the problems and their codes go to stderr', async () => {
    const dir = makeTmp('plain')
    writeTree(dir, { 'package.json': pkg, 'facts/a/index.ts': entry([fact('one', rows(row("'soon'")))]) })
    const r = await cli(['check', '--cwd', dir])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/^since-format: demo\.one: since "soon"/)
  })
})
