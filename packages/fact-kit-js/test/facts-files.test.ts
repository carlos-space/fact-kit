import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }
const entryOnly = "export default { describes: { demo: '1.2.0' } }\n"
const fact = (name: string, topic = 't') =>
  `{ id: 'demo.${name}', tool: 'demo', topics: ['${topic}'], title: '${name}', content: { value: 1 }, source: { kind: 'published' } }`
const plain = (...facts: string[]) => `export default [${facts.join(', ')}]\n`
/** A `*.facts.ts` written the way the split rules want: the tool only inside factsOf(...). */
const viaFactsOf = (topic: string, names: string[]) =>
  [
    `import { factsOf } from '${src}'`,
    `const mf = factsOf({ tool: 'demo', topics: ['${topic}'], source: { kind: 'published' } as any })`,
    `export default [${names.map((n) => `mf.value('${n}', 1)`).join(', ')}]`,
    '',
  ].join('\n')

const builtIds = (dir: string, entry: string): string[] =>
  JSON.parse(readFileSync(join(dir, 'dist', entry, 'index.json'), 'utf8')).facts.map((f: any) => f.id)

async function check(dir: string, args: string[] = []) {
  const r = await cli(['check', '--cwd', dir, '--json', ...args])
  let problems: { code: string; message: string; location: string | null }[] = []
  try {
    problems = JSON.parse(r.stdout).problems
  } catch {
    // exit code 2 prints no JSON
  }
  return { code: r.code, problems, codes: problems.map((p) => p.code), stderr: r.stderr }
}

describe('c001 collecting *.facts.ts', () => {
  const tree = {
    'package.json': pkg,
    'facts/a/index.ts': entryOnly,
    'facts/a/two.facts.ts': plain(fact('two')),
    'facts/a/one.facts.ts': plain(fact('one')),
  }

  test('index.ts with entry fields only: build gets the facts of both files, sorted by path, and check passes', async () => {
    const dir = makeTmp('ff')
    writeTree(dir, tree)
    const result = await buildFacts({ cwd: dir })
    expect(result.problems).toEqual([])
    expect(builtIds(dir, 'a')).toEqual(['demo.one', 'demo.two'])
    expect(await check(dir)).toMatchObject({ code: 0, problems: [] })
  })

  test('the facts of index.ts come first, then the files by relative path in code-unit order', async () => {
    const dir = makeTmp('ff-order')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/index.ts': `export default { describes: { demo: '1.2.0' }, facts: [${fact('head')}] }\n`,
      'facts/a/b.facts.ts': plain(fact('b')),
      'facts/a/a/z.facts.ts': plain(fact('az')),
      'facts/a/a.facts.ts': plain(fact('a')),
      'facts/a/C.facts.ts': plain(fact('upper')),
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    // "C.facts.ts" < "a.facts.ts" < "a/z.facts.ts" < "b.facts.ts"
    expect(builtIds(dir, 'a')).toEqual(['demo.head', 'demo.upper', 'demo.a', 'demo.az', 'demo.b'])
  })

  test('a subdirectory with its own index.ts is another entry and keeps its files', async () => {
    const dir = makeTmp('ff-nested')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/index.ts': entryOnly,
      'facts/a/x.facts.ts': plain(fact('x')),
      'facts/a/sub/index.ts': entryOnly,
      'facts/a/sub/y.facts.ts': plain(fact('y')),
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    expect(builtIds(dir, 'a')).toEqual(['demo.x'])
    expect(builtIds(dir, 'a/sub')).toEqual(['demo.y'])
  })

  test('an old-style index.ts that imports its topic files builds as before', async () => {
    const dir = makeTmp('ff-old')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/topic.ts': `export const facts = [${fact('imported')}]\n`,
      'facts/a/index.ts':
        "import { facts } from './topic.ts'\nexport default { describes: { demo: '1.2.0' }, facts }\n",
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    expect(builtIds(dir, 'a')).toEqual(['demo.imported'])
  })

  test('a *.facts.ts that does not default-export an array stops the build', async () => {
    const dir = makeTmp('ff-bad')
    writeTree(dir, { 'package.json': pkg, 'facts/a/index.ts': entryOnly, 'facts/a/x.facts.ts': 'export default {}\n' })
    await expect(buildFacts({ cwd: dir })).rejects.toMatchObject({
      code: 'load',
      file: expect.stringContaining('x.facts.ts'),
    })
    const r = await cli(['build', '--cwd', dir])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('must default-export an array of facts')
  })
})

describe('c002 build and check find the sources by the collection rule', () => {
  test('check reads the *.facts.ts of an entry, and reports a problem found only there', async () => {
    const dir = makeTmp('ff-check')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/index.ts': entryOnly,
      'facts/a/x.facts.ts': plain(fact('x').replace("kind: 'published'", "kind: 'observed', basis: 'nope'")),
    })
    const r = await check(dir)
    expect(r.code).toBe(1)
    expect(r.problems[0]?.location).toContain('facts/a/index.ts#/facts/0')
  })

  test('a *.facts.ts under no entry, or under a _ directory, is facts-file-orphan in check and build', async () => {
    const dir = makeTmp('ff-orphan')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/index.ts': entryOnly,
      'facts/a/ok.facts.ts': plain(fact('ok')),
      'facts/top.facts.ts': plain(fact('top')),
      'facts/lone/z.facts.ts': plain(fact('z')),
      'facts/a/_hidden/h.facts.ts': plain(fact('h')),
      'facts/_lib/l.facts.ts': plain(fact('l')),
    })
    const r = await check(dir)
    expect(r.codes).toEqual(['facts-file-orphan', 'facts-file-orphan', 'facts-file-orphan', 'facts-file-orphan'])
    expect(r.problems.map((p) => p.location).sort()).toEqual([
      'facts/_lib/l.facts.ts',
      'facts/a/_hidden/h.facts.ts',
      'facts/lone/z.facts.ts',
      'facts/top.facts.ts',
    ])
    const built = await buildFacts({ cwd: dir })
    expect(built.problems.map((p) => p.code)).toEqual(Array(4).fill('facts-file-orphan'))
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  test('a fact that index.ts imports and a file also gives is a duplicate-id', async () => {
    const dir = makeTmp('ff-dup')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/shared.ts': `export const shared = ${fact('same')}\n`,
      'facts/a/index.ts':
        "import { shared } from './shared.ts'\nexport default { describes: { demo: '1.2.0' }, facts: [shared] }\n",
      'facts/a/again.facts.ts': "import { shared } from './shared.ts'\nexport default [shared]\n",
    })
    const r = await check(dir)
    expect(r.codes).toEqual(['duplicate-id'])
  })
})

describe('c003 build reads factsDir from the config file', () => {
  const files = {
    'package.json': pkg,
    'src/facts/a/index.ts': entryOnly,
    'src/facts/a/x.facts.ts': plain(fact('x')),
    'other/a/index.ts': entryOnly,
    'other/a/y.facts.ts': plain(fact('y')),
  }

  test('without --facts-dir the build uses factsDir of fact-kit.config.json', async () => {
    const dir = makeTmp('fd')
    writeTree(dir, { ...files, 'fact-kit.config.json': { factsDir: 'src/facts' } })
    const r = await cli(['build', '--cwd', dir, '--write-exports'])
    expect(r.code).toBe(0)
    expect(builtIds(dir, 'a')).toEqual(['demo.x'])
  })

  test('--facts-dir wins over the config file', async () => {
    const dir = makeTmp('fd-flag')
    writeTree(dir, { ...files, 'fact-kit.config.json': { factsDir: 'src/facts' } })
    const r = await cli(['build', '--cwd', dir, '--facts-dir', 'other', '--write-exports'])
    expect(r.code).toBe(0)
    expect(builtIds(dir, 'a')).toEqual(['demo.y'])
  })

  test('with no setting anywhere the default is facts', async () => {
    const dir = makeTmp('fd-default')
    writeTree(dir, { 'package.json': pkg, 'facts/a/index.ts': entryOnly, 'facts/a/x.facts.ts': plain(fact('x')) })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    expect(builtIds(dir, 'a')).toEqual(['demo.x'])
  })
})

describe('c004 split rules', () => {
  const on = { 'fact-kit.config.json': { splitRules: true } }
  const base = (more: Record<string, unknown>) => ({
    'package.json': pkg,
    'facts/a/index.ts': entryOnly,
    ...more,
  })
  const many = (n: number) =>
    viaFactsOf(
      't',
      Array.from({ length: n }, (_, i) => `n${i}`),
    )

  test('a good file passes with the rules on', async () => {
    const dir = makeTmp('sr-ok')
    writeTree(dir, { ...on, ...base({ 'facts/a/x.facts.ts': viaFactsOf('t', ['one', 'two']) }) })
    expect(await check(dir)).toMatchObject({ code: 0, problems: [] })
  })

  test('40 facts pass, 41 are split-size', async () => {
    const dir = makeTmp('sr-size')
    writeTree(dir, { ...on, ...base({ 'facts/a/x.facts.ts': many(40) }) })
    expect((await check(dir)).codes).toEqual([])
    writeTree(dir, { 'facts/a/x.facts.ts': many(41) })
    const r = await check(dir)
    expect(r.codes).toEqual(['split-size'])
    expect(r.problems[0]?.location).toBe('facts/a/x.facts.ts')
  })

  test('maxFactsPerFile moves the limit', async () => {
    const dir = makeTmp('sr-max')
    writeTree(dir, {
      'fact-kit.config.json': { splitRules: true, maxFactsPerFile: 2 },
      ...base({ 'facts/a/x.facts.ts': many(3) }),
    })
    expect((await check(dir)).codes).toEqual(['split-size'])
  })

  test('two values of topics[0] in one file are split-topic', async () => {
    const dir = makeTmp('sr-topic')
    writeTree(dir, {
      ...on,
      ...base({
        'facts/a/x.facts.ts': [
          `import { factsOf } from '${src}'`,
          "const one = factsOf({ tool: 'demo', topics: ['p'], source: { kind: 'published' } as any })",
          "const two = factsOf({ tool: 'demo', topics: ['q'], source: { kind: 'published' } as any })",
          "export default [one.value('a', 1), two.value('b', 1)]",
          '',
        ].join('\n'),
      }),
    })
    expect((await check(dir)).codes).toEqual(['split-topic'])
  })

  test('a tool written outside factsOf is split-tool', async () => {
    const dir = makeTmp('sr-tool')
    writeTree(dir, { ...on, ...base({ 'facts/a/x.facts.ts': plain(fact('raw')) }) })
    const r = await check(dir)
    expect(r.codes).toEqual(['split-tool'])
    expect(r.problems[0]?.location).toBe('facts/a/x.facts.ts:1')
  })

  test('a fact object in index.ts, next to *.facts.ts files, is split-index', async () => {
    const dir = makeTmp('sr-index')
    writeTree(dir, {
      ...on,
      ...base({
        'facts/a/index.ts': `export default { describes: { demo: '1.2.0' }, facts: [${fact('head')}] }\n`,
        'facts/a/x.facts.ts': viaFactsOf('t', ['one']),
      }),
    })
    const r = await check(dir)
    expect(r.codes).toEqual(['split-index'])
    expect(r.problems[0]?.location).toBe('facts/a/index.ts:1')
  })

  test('the rules are off without the setting, and an entry with no *.facts.ts is never judged', async () => {
    const dir = makeTmp('sr-off')
    writeTree(
      dir,
      base({
        'facts/a/x.facts.ts': many(41),
        'facts/b/index.ts': `export default { describes: { demo: '1.2.0' }, facts: [${fact('b')}] }\n`,
      }),
    )
    expect((await check(dir)).codes).toEqual([])
    writeTree(dir, on)
    expect((await check(dir)).codes).toEqual(['split-size'])
  })
})
