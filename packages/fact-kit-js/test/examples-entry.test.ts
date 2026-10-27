import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { aggregateExports, buildFacts, exampleFactRefs, impactOf } from '../src/index.ts'
import type { ExampleGroup } from '../src/index.ts'
import { cleanTmp, cli, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

const FACTS = [
  `import { factsOf, observedDoc } from '${src}'`,
  "export const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
  "export const limits = mf.value('limits', { max: 3 })",
  'export const rule = mf.statement(\'rule\', "Keep it small")',
  "export default { describes: { demo: '1.0.0' }, facts: [limits, rule] }",
].join('\n')

/** The first scenario's code is a snippet that would throw if it were run. */
const scenario = (outcome: string, facts = "['demo.limits']") =>
  `{ title: 'One', situation: 's', code: [{ caption: 'a.ts', lang: 'ts', source: 'throw new Error("never run")' }], outcome: [${outcome}], points: ['p'], facts: ${facts} }`

function component(name: string, examples: string, extraFacts = FACTS) {
  const dir = makeTmp('examples-entry')
  writeTree(dir, {
    'package.json': { name, version: '1.0.0', type: 'module', exports: {} },
    'facts/demo/index.ts': extraFacts,
    'examples/g.ts': [
      `import { defineExamples, ref, statementFrom } from '${src}'`,
      "import { limits, rule } from '../facts/demo/index.ts'",
      'void [ref, statementFrom, limits, rule]',
      examples,
    ].join('\n'),
  })
  return dir
}

const group = (outcome: string, facts?: string) =>
  `export default defineExamples({ id: 'first', name: 'First', situation: 's', claim: 'c', scenarios: [${scenario(outcome, facts)}] })`

describe('c002 build writes examples.json', () => {
  test('a component writes dist/examples.json and the exports key, and the index does not change', async () => {
    const dir = component('demo-facts', group("'plain', ref(limits, 'max'), ref(rule)"))
    const before = component('demo-facts', 'export default []')
    expect((await buildFacts({ cwd: before, writeExports: true })).problems).toEqual([])
    const r = await buildFacts({ cwd: dir, writeExports: true })
    expect(r.problems).toEqual([])
    expect(r.files).toContain('dist/examples.json')
    const out = readJson(join(dir, 'dist/examples.json'))
    expect(out.package).toBe('demo-facts')
    expect(out.examples).toHaveLength(1)
    expect(out.examples[0].scenarios[0].code[0].source).toBe('throw new Error("never run")')
    expect(out.examples[0].scenarios[0].outcome).toEqual([
      'plain',
      { fact: 'demo.limits', field: 'max' },
      { fact: 'demo.rule' },
    ])
    expect(readJson(join(dir, 'package.json')).exports['./examples.json']).toBe('./dist/examples.json')
    expect(readFileSync(join(dir, 'dist/demo/index.json'), 'utf8')).toBe(
      readFileSync(join(before, 'dist/demo/index.json'), 'utf8'),
    )
  })

  test('an existing ExampleGroup written as plain JSON builds and checks as before', async () => {
    const dir = component('demo-facts', 'export {}')
    writeTree(dir, {
      'examples/g.ts': 'export default []\n',
      'examples/plain.json': {
        id: 'old',
        name: 'Old',
        situation: 's',
        claim: 'c',
        scenarios: [
          {
            title: 'One',
            situation: 's',
            code: [{ caption: 'a.ts', lang: 'ts', source: 'x' }],
            outcome: ['A file appears'],
            points: ['p'],
            facts: ['demo.limits'],
          },
        ],
      },
    })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    expect(readJson(join(dir, 'dist/examples.json')).examples[0].id).toBe('old')
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(JSON.parse(check.stdout).problems).toEqual([])
  })

  test('a package without examples writes no examples.json and removes a stale one', async () => {
    const dir = component('demo-facts', 'export default []')
    writeTree(dir, { 'dist/examples.json': '{}' })
    const r = await buildFacts({ cwd: dir, writeExports: true })
    expect(r.problems).toEqual([])
    expect(existsSync(join(dir, 'dist/examples.json'))).toBe(false)
    expect(readJson(join(dir, 'package.json')).exports['./examples.json']).toBeUndefined()
  })

  test('the build and check pass when the snippet is code that throws when run', async () => {
    const dir = component('demo-facts', group("'ok'"))
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(JSON.parse(check.stdout).problems).toEqual([])
  })
})

describe('c003 outcome references', () => {
  test('a mistyped id in outcome fails check and build, and the message names it', async () => {
    const dir = component('demo-facts', group("{ fact: 'demo.limitz' }"))
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(check.code).toBe(1)
    const problems = JSON.parse(check.stdout).problems
    expect(problems).toHaveLength(1)
    expect(problems[0].code).toBe('unknown-fact-id')
    expect(problems[0].message).toContain('demo.limitz')
    expect(problems[0].location).toContain('/scenarios/0/outcome/0/fact')
    const build = await buildFacts({ cwd: dir, writeExports: true })
    expect(build.problems.map((p) => p.message).join('\n')).toContain('demo.limitz')
    expect(existsSync(join(dir, 'dist/examples.json'))).toBe(false)
  })

  test('a field that no row of the fact has is a ref problem', async () => {
    const dir = component('demo-facts', group("{ fact: 'demo.limits', field: 'nope' }"))
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    const problems = JSON.parse(check.stdout).problems
    expect(problems.map((p: any) => p.code)).toEqual(['ref'])
    expect(problems[0].message).toContain('nope')
  })

  test('a ref to a fact that is not listed in any entry is a ref problem', async () => {
    const dir = component(
      'demo-facts',
      [
        "const stray = { id: 'demo.stray', tool: 'demo', topics: ['t'], title: 'x', content: { value: 1 }, source: { kind: 'published' } }",
        `export default defineExamples({ id: 'first', name: 'First', situation: 's', claim: 'c', scenarios: [${scenario('ref(stray as any)')}] })`,
      ].join('\n'),
    )
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(JSON.parse(check.stdout).problems.map((p: any) => p.code)).toEqual(['ref'])
  })

  test('statementFrom renders from the fact, and the outcome follows when the value changes', async () => {
    const outcome = "statementFrom(limits, (v) => ({ en: `At most ${v.max}`, 'zh-TW': `最多 ${v.max}` }))"
    const dir = component('demo-facts', group(outcome))
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    expect(readJson(join(dir, 'dist/examples.json')).examples[0].scenarios[0].outcome).toEqual([
      { fact: 'demo.limits', text: { en: 'At most 3', 'zh-TW': '最多 3' } },
    ])
    writeTree(dir, { 'facts/demo/index.ts': FACTS.replace('{ max: 3 }', '{ max: 9 }') })
    // A new process, because this one has the old facts module cached.
    expect((await cli(['build', '--cwd', dir])).code).toBe(0)
    expect(readJson(join(dir, 'dist/examples.json')).examples[0].scenarios[0].outcome).toEqual([
      { fact: 'demo.limits', text: { en: 'At most 9', 'zh-TW': '最多 9' } },
    ])
  })

  test('exampleFactRefs lists the outcome references with their place', () => {
    const g = {
      id: 'g',
      name: 'g',
      situation: 's',
      claim: 'c',
      facts: ['a.one'],
      scenarios: [
        {
          title: 't',
          situation: 's',
          code: [],
          outcome: ['x', { fact: 'a.two', field: 'f' }],
          points: [],
          facts: ['a.three'],
        },
      ],
    } as ExampleGroup
    expect(exampleFactRefs(g)).toEqual([
      { id: 'a.one', location: '/facts/0', in: 'facts' },
      { id: 'a.three', location: '/scenarios/0/facts/0', in: 'facts' },
      { id: 'a.two', location: '/scenarios/0/outcome/1/fact', in: 'outcome', field: 'f' },
    ])
  })
})

/** Two components under one aggregate: `up` holds the examples (at the root), `down` has none. */
async function aggregateSample() {
  const repo = makeTmp('examples-agg')
  const mk = (name: string, ex: string, facts: string) => {
    const dir = join(repo, name)
    writeTree(dir, {
      'package.json': { name: `@npm/${name}`, version: '1.0.0', type: 'module', exports: {} },
      'facts/f/index.ts': facts,
      'examples/g.ts': [`import { defineExamples } from '${src}'`, ex].join('\n'),
    })
    return dir
  }
  const upDir = mk('up', group("{ fact: 'demo.limits' }, { fact: 'demo.rule' }"), FACTS)
  writeTree(upDir, {
    'examples/g.ts': [
      `import { defineExamples } from '${src}'`,
      `export default defineExamples({ id: 'first', name: 'First', situation: 's', claim: 'c', facts: ['demo.rule'], scenarios: [${scenario("{ fact: 'demo.limits' }")}] })`,
    ].join('\n'),
  })
  const downDir = mk('down', group("'only text'", "['dwn.limits']"), FACTS.replaceAll('demo', 'dwn'))
  writeTree(repo, {
    'agg/package.json': { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} },
    'agg/fact-kit.config.json': { aggregate: { '.': '@npm/up', down: '@npm/down' } },
  })
  for (const [dir, name] of [
    [upDir, 'up'],
    [downDir, 'down'],
  ] as const) {
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    linkPackage(join(repo, 'agg'), `@npm/${name}`, dir)
  }
  return join(repo, 'agg')
}

describe('c002 aggregate', () => {
  test('examples.json goes next to the index of its sub-path, with the aggregate name, and into exports', async () => {
    const agg = await aggregateSample()
    const r = await buildFacts({ cwd: agg, writeExports: true })
    expect(r.problems).toEqual([])
    expect(r.files).toContain('dist/examples.json')
    expect(r.files).toContain('dist/down/examples.json')
    expect(readJson(join(agg, 'dist/examples.json')).package).toBe('demo-facts')
    expect(readJson(join(agg, 'dist/down/examples.json')).examples[0].scenarios[0].facts).toEqual(['dwn.limits'])
    const exportsMap = readJson(join(agg, 'package.json')).exports
    expect(exportsMap['./examples.json']).toBe('./dist/examples.json')
    expect(exportsMap['./down/examples.json']).toBe('./dist/down/examples.json')
    expect(readJson(join(agg, 'dist/index.json')).package).toBe('demo-facts')
  })

  test('aggregateExports adds the examples keys only for the given placements', () => {
    expect(aggregateExports([], 'dist', [{ dir: '' }, { dir: 'a/b' }] as any)).toEqual({
      './examples.json': './dist/examples.json',
      './a/b/examples.json': './dist/a/b/examples.json',
    })
  })
})

describe('c003 diff --impact lists the examples', () => {
  test('the --json output has examples: [{ spec, group, scenario, id, in }]', async () => {
    const agg = await aggregateSample()
    expect((await buildFacts({ cwd: agg, writeExports: true })).problems).toEqual([])
    const outcome = await cli(['diff', '--impact', 'demo.limits', '--cwd', agg, '--json'])
    expect(outcome.code).toBe(0)
    const parsed = JSON.parse(outcome.stdout)
    expect(Object.keys(parsed)).toEqual(['id', 'facts', 'docs', 'examples'])
    expect(parsed.examples).toEqual([
      { spec: 'demo-facts', group: 'first', scenario: 'One', id: 'demo.limits', in: 'facts' },
      { spec: 'demo-facts', group: 'first', scenario: 'One', id: 'demo.limits', in: 'outcome' },
    ])
    const viaGroup = await impactOf('demo.rule', { cwd: agg })
    expect(viaGroup.examples).toEqual([
      { spec: 'demo-facts', group: 'first', scenario: 'One', id: 'demo.rule', in: 'facts' },
    ])
    const text = await cli(['diff', '--impact', 'demo.limits', '--cwd', agg])
    expect(text.stdout).toContain('example  demo-facts first / One  demo.limits  (in outcome)')
  })

  test('a fact no example names gives an empty examples list', async () => {
    const agg = await aggregateSample()
    expect((await buildFacts({ cwd: agg, writeExports: true })).problems).toEqual([])
    expect((await impactOf('dwn.rule', { cwd: agg })).examples).toEqual([])
  })

  test('the sub-path spec is used for examples of a component that hangs on a sub-path', async () => {
    const agg = await aggregateSample()
    expect((await buildFacts({ cwd: agg, writeExports: true })).problems).toEqual([])
    const impact = await impactOf('dwn.limits', { cwd: agg })
    expect(impact.examples).toEqual([
      { spec: 'demo-facts/down', group: 'first', scenario: 'One', id: 'dwn.limits', in: 'facts' },
    ])
  })
})
