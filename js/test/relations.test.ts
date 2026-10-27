import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, derive, factLink } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

/** A fact object, written as source text. */
const factSrc = (name: string, more = '') =>
  `{ id: 'demo.${name}', tool: 'demo', topics: ['t'], title: '${name}', content: { value: 1 }, source: { kind: 'published' }${more} }`

const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module' }

describe('c002 relates and factLink', () => {
  const files = {
    'package.json': pkg,
    // The shared fact lives in a helper directory and is listed by entry a.
    'facts/_lib/base.ts': `export const base = ${factSrc('base')}\n`,
    'facts/a/index.ts': [
      `import { factLink } from '${src}'`,
      "import { base } from '../_lib/base.ts'",
      'const sibling = ' + factSrc('sibling', ', relates: [base]'),
      'const linked = { ' +
        factSrc('linked').slice(2, -2) +
        ', content: { statement: `Works like ${factLink(base)}, see ${factLink(sibling)}.` } }',
      "export default { describes: { demo: '1.0.0' }, facts: [base, sibling, linked] }",
      '',
    ].join('\n'),
    'facts/b/index.ts': [
      "import { base } from '../_lib/base.ts'",
      'const other = ' + factSrc('other', ', relates: [base]'),
      "export default { describes: { demo: '1.0.0' }, facts: [other] }",
      '',
    ].join('\n'),
  }

  test('a fact of the same package in relates or factLink goes into derivedFrom', async () => {
    const dir = makeTmp('relates')
    writeTree(dir, files)
    const result = await buildFacts({ cwd: dir, writeExports: true })
    expect(result.problems).toEqual([])
    const a = readJson(join(dir, 'dist/a/index.json')).facts
    const byId = Object.fromEntries(a.map((f: any) => [f.id, f]))
    expect(byId['demo.base'].derivedFrom).toBeUndefined()
    expect(byId['demo.sibling'].derivedFrom).toEqual(['demo.base'])
    expect('relates' in byId['demo.sibling']).toBe(false)
    // factLink became the fact location, and the linked facts are in derivedFrom in order of appearance.
    expect(byId['demo.linked'].content.statement).toBe('Works like demo.base, see demo.sibling.')
    expect(byId['demo.linked'].derivedFrom).toEqual(['demo.base', 'demo.sibling'])
    // Across entries the location carries the spec of the entry that holds the fact.
    const b = readJson(join(dir, 'dist/b/index.json')).facts
    expect(b[0].derivedFrom).toEqual(['demo-facts/a:demo.base'])
    // check accepts it: the locations exist.
    const checked = await cli(['check', '--cwd', dir, '--json'])
    expect(JSON.parse(checked.stdout)).toEqual({ problems: [] })
    expect(checked.code).toBe(0)
  })

  test('relating is by object, so renaming the id does not break it', async () => {
    const dir = makeTmp('relates-rename')
    writeTree(dir, { ...files, 'facts/_lib/base.ts': `export const base = ${factSrc('renamed')}\n` })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const sibling = readJson(join(dir, 'dist/a/index.json')).facts.find((f: any) => f.id === 'demo.sibling')
    expect(sibling.derivedFrom).toEqual(['demo.renamed'])
  })

  test('a fact object of another package, imported from it, fails check and build and the message says to use derive', async () => {
    const dir = makeTmp('relates-foreign')
    writeTree(dir, {
      'package.json': pkg,
      // Stands for a module of another package: its tool is not one this package uses.
      'other/fact.ts': `export const outsider = ${factSrc('outsider').replace("id: 'demo.outsider', tool: 'demo'", "id: 'other.outsider', tool: 'other'")}\n`,
      'facts/a/index.ts': [
        `import { factLink } from '${src}'`,
        "import { outsider } from '../../other/fact.ts'",
        'const mine = ' + factSrc('mine', ', relates: [outsider]'),
        'const text = { ' + factSrc('text').slice(2, -2) + ', content: { statement: `see ${factLink(outsider)}` } }',
        "export default { describes: { demo: '1.0.0' }, facts: [mine, text] }",
        '',
      ].join('\n'),
    })
    const checked = await cli(['check', '--cwd', dir, '--json'])
    expect(checked.code).toBe(1)
    const problems = JSON.parse(checked.stdout).problems
    expect(problems.map((p: any) => p.code)).toEqual(['relates-foreign', 'relates-foreign'])
    expect(problems[0].message).toContain('"other.outsider"')
    expect(problems[0].message).toContain('derive(upstreamSpec, id)')
    const built = await cli(['build', '--cwd', dir])
    expect(built.code).toBe(1)
    expect(built.stderr).toContain('relates-foreign')
    expect(built.stderr).toContain('nothing was written')
  })

  test('a fact object of this package that no entry lists fails with a message that says to list it', async () => {
    const dir = makeTmp('relates-unlisted')
    writeTree(dir, {
      'package.json': pkg,
      'facts/_lib/lost.ts': `export const lost = ${factSrc('lost')}\n`,
      'facts/a/index.ts': [
        `import { factLink } from '${src}'`,
        "import { lost } from '../_lib/lost.ts'",
        'const mine = ' + factSrc('mine', ', relates: [lost]'),
        'const text = { ' + factSrc('text').slice(2, -2) + ', content: { statement: `see ${factLink(lost)}` } }',
        "export default { describes: { demo: '1.0.0' }, facts: [mine, text] }",
        '',
      ].join('\n'),
    })
    const checked = await cli(['check', '--cwd', dir, '--json'])
    const problems = JSON.parse(checked.stdout).problems
    expect(problems.map((p: any) => p.code)).toEqual(['relates-foreign', 'relates-foreign'])
    expect(problems[0].message).toContain('"demo.lost"')
    expect(problems[0].message).toContain('not listed in the `facts` of any entry')
    expect(problems[0].message).not.toContain('derive(')
  })

  test('factLink returns one placeholder per fact and needs an object', () => {
    const f = { id: 'demo.x' } as never
    expect(factLink(f)).toBe(factLink(f))
    expect(factLink(f)).not.toBe(factLink({ id: 'demo.y' } as never))
    expect(() => factLink('demo.x' as never)).toThrow(/expected a fact object/)
  })
})

describe('c003 derive', () => {
  const upstream = (version: string) => ({
    'node_modules/@up/x-facts/package.json': {
      name: '@up/x-facts',
      version,
      exports: { './cli/index.json': './dist/cli/index.json' },
    },
    'node_modules/@up/x-facts/dist/cli/index.json': {
      indexFormat: '1.1',
      package: '@up/x-facts',
      entry: 'cli',
      describes: { up: '4.0.0' },
      facts: [
        {
          id: 'up.thing',
          tool: 'up',
          topics: ['t'],
          title: 'Thing',
          content: { value: ['a', 'b'] },
          derivedFrom: ['up.other'],
          source: { kind: 'published' },
        },
      ],
    },
  })
  const files = (map = '') => ({
    'package.json': { ...pkg, devDependencies: { '@up/x-facts': '*' } },
    'facts/d/index.ts': [
      `import { derive } from '${src}'`,
      `export default { describes: { demo: '1.0.0' }, facts: [derive('@up/x-facts/cli', 'up.thing'${map})] }`,
      '',
    ].join('\n'),
  })

  test('derived.lock.json records the upstream version, and the build fails once another version is installed', async () => {
    const dir = makeTmp('derive')
    writeTree(dir, { ...files(), ...upstream('1.0.0') })
    const first = await cli(['build', '--cwd', dir, '--write-exports'])
    expect(first.stderr).toBe('')
    expect(first.code).toBe(0)
    const built = readJson(join(dir, 'dist/d/index.json'))
    const fact = built.facts[0]
    expect(fact).toMatchObject({
      id: 'up.thing',
      content: { value: ['a', 'b'] },
      derivedFrom: ['@up/x-facts/cli:up.thing'],
      source: { kind: 'derived', from: '@up/x-facts/cli', version: '1.0.0' },
    })
    expect('verify' in fact).toBe(false)
    expect(readJson(join(dir, 'derived.lock.json'))).toEqual({ '@up/x-facts/cli': '1.0.0' })
    console.log(
      'first build ->',
      JSON.stringify(fact.source),
      JSON.stringify(readJson(join(dir, 'derived.lock.json'))),
      `exit ${first.code}`,
    )

    // Another version is installed. The lock still says 1.0.0.
    writeTree(dir, upstream('1.1.0'))
    const second = await cli(['build', '--cwd', dir])
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('derive-version')
    expect(second.stderr).toContain('@up/x-facts/cli 1.0.0 (derived.lock.json), but 1.1.0 is installed')
    console.log('second build ->', second.stderr.trim().replace(/\n/g, '\n    '), `\n    exit ${second.code}`)
    expect(readJson(join(dir, 'derived.lock.json'))).toEqual({ '@up/x-facts/cli': '1.0.0' })

    // The old dist plays no part: the same failure without it.
    rmSync(join(dir, 'dist'), { recursive: true })
    expect((await cli(['build', '--cwd', dir])).code).toBe(1)

    // check compares the lock with the installed upstream too, and so does check on a built index.
    const checked = await cli(['check', '--cwd', dir, '--json'])
    expect(checked.code).toBe(1)
    expect(JSON.parse(checked.stdout).problems.map((p: any) => p.code)).toEqual(['derive-version'])
    writeTree(dir, { 'built/d/index.json': built })
    const viaIndex = await cli(['check', '--cwd', dir, '--facts-dir', 'none', '--index', 'built/d'])
    expect(viaIndex.code).toBe(1)
    expect(viaIndex.stderr).toContain('derived from @up/x-facts/cli 1.0.0, but 1.1.0 is installed')

    // After looking at the upstream change, the build rewrites the lock.
    const accepted = await cli(['build', '--cwd', dir, '--accept-upstream'])
    expect(accepted.code).toBe(0)
    expect(readJson(join(dir, 'derived.lock.json'))).toEqual({ '@up/x-facts/cli': '1.1.0' })
    const after = readJson(join(dir, 'dist/d/index.json'))
    expect(after.facts[0].source.version).toBe('1.1.0')
    expect((await cli(['check', '--cwd', dir])).code).toBe(0)

    // Without the old dist the build gives the same result.
    rmSync(join(dir, 'dist'), { recursive: true })
    const rebuilt = await cli(['build', '--cwd', dir])
    expect(rebuilt.code).toBe(0)
    expect(readJson(join(dir, 'dist/d/index.json'))).toEqual(after)
  })

  test('a missing lock is written from the installed version, and a package without derived facts gets none', async () => {
    const dir = makeTmp('derive-nolock')
    writeTree(dir, { ...files(), ...upstream('3.0.0') })
    expect((await cli(['build', '--cwd', dir, '--write-exports'])).code).toBe(0)
    expect(readJson(join(dir, 'derived.lock.json'))).toEqual({ '@up/x-facts/cli': '3.0.0' })
    const plain = makeTmp('derive-plain')
    writeTree(plain, { 'package.json': pkg, 'facts/a/index.ts': 'export default { describes: {}, facts: [] }\n' })
    expect((await cli(['build', '--cwd', plain, '--write-exports'])).code).toBe(0)
    expect(existsSync(join(plain, 'derived.lock.json'))).toBe(false)
  })

  test('map changes the fields of the copy', async () => {
    const dir = makeTmp('derive-map')
    writeTree(dir, {
      ...files(
        ", (up) => ({ id: 'demo.thing', tool: 'demo', title: up.title + ' here', content: { value: [...up.content.value, 'c'] } })",
      ),
      ...upstream('2.3.4'),
    })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const fact = readJson(join(dir, 'dist/d/index.json')).facts[0]
    expect(fact).toMatchObject({
      id: 'demo.thing',
      title: 'Thing here',
      content: { value: ['a', 'b', 'c'] },
      derivedFrom: ['@up/x-facts/cli:up.thing'],
      source: { version: '2.3.4' },
    })
  })

  test('an upstream that is not installed, or that lacks the fact, is a derive problem', async () => {
    const dir = makeTmp('derive-missing')
    writeTree(dir, files())
    const missing = await cli(['check', '--cwd', dir, '--json'])
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.stdout).problems.map((p: any) => p.code)).toEqual(['derive'])
    expect(JSON.parse(missing.stdout).problems[0].message).toContain('cannot resolve')
    writeTree(dir, upstream('1.0.0'))
    writeTree(dir, { 'facts/d/index.ts': files()['facts/d/index.ts'].replace('up.thing', 'up.ghost') })
    const ghost = await cli(['build', '--cwd', dir])
    expect(ghost.code).toBe(1)
    expect(ghost.stderr).toContain('has no fact "up.ghost"')
  })

  test('derive returns a description that the build resolves', () => {
    const d = derive('@up/x-facts/cli', 'up.thing')
    expect(d).toMatchObject({ spec: '@up/x-facts/cli', id: 'up.thing' })
    expect(JSON.parse(JSON.stringify(d))).toEqual({ spec: '@up/x-facts/cli', id: 'up.thing' })
  })
})
