import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, impactOf } from '../src/index.ts'
import { cleanTmp, cli, componentTree, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

/** Two components. `down` derives from `up` through a published location, and one fact derives from that. */
async function sample() {
  const repo = makeTmp('impact')
  const prefix = (dir: string, tree: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(tree).map(([k, v]) => [`${dir}/${k}`, v]))
  writeTree(repo, {
    ...prefix('up', componentTree('@npm/up', { up: [{ id: 'demo.base' }, { id: 'demo.other' }] })),
    ...prefix(
      'down',
      componentTree('@npm/down', {
        down: [
          { id: 'demo.derived', derivedFrom: ['demo-facts:demo.base'] },
          { id: 'demo.leaf', derivedFrom: ['demo.derived'] },
          { id: 'demo.unrelated', derivedFrom: ['demo-facts:demo.other'] },
        ],
      }),
    ),
    'agg/package.json': { name: 'demo-facts', version: '1.0.0', type: 'module' },
    'agg/fact-kit.config.json': {
      aggregate: { '.': '@npm/up', down: '@npm/down' },
      docsDirs: ['docs', 'src'],
    },
    'agg/docs/guide.md': [
      '# Guide',
      'The base is `fact:demo.base`.',
      'Nothing here.',
      'See fact:demo-facts/down:demo.derived, and fact:demo.other.',
      '',
    ].join('\n'),
    'agg/src/reader.ts': [
      "import { readFacts } from 'fact-kit'",
      'const kit = readFacts("demo-facts")',
      'export const a = kit.get("demo.base")',
      "export const b = kit.value('demo.leaf')",
      'export const c = kit.has(`demo.derived`)',
      'export const d = kit.get("demo.other")',
      'export const e = kit.get(name)',
      '',
    ].join('\n'),
    // The import name has nothing to do with the id.
    'agg/src/facts.ts': "export const custom = { id: 'demo.leaf', tool: 'demo', content: { value: 1 } }\n",
    'agg/src/fact-object.ts': "import { custom as anything } from './facts.ts'\nexport const x = anything\n",
    // The name is the camelCase of an id, but the module exports another fact, and a missing module is skipped.
    'agg/src/decoy.ts':
      "import { demoBase } from './decoy-facts.ts'\nimport { demoDerived } from './missing.ts'\nexport const y = [demoBase, demoDerived]\n",
    'agg/src/decoy-facts.ts': "export const demoBase = { id: 'demo.elsewhere', tool: 'demo', content: { value: 1 } }\n",
  })
  for (const dir of ['up', 'down']) {
    expect((await buildFacts({ cwd: join(repo, dir) })).problems).toEqual([])
    linkPackage(join(repo, 'agg'), `@npm/${dir}`, join(repo, dir))
  }
  return join(repo, 'agg')
}

describe('c001 diff --impact', () => {
  test('lists downstream facts across components, with depth and via', async () => {
    const agg = await sample()
    const impact = await impactOf('demo.base', { cwd: agg })
    expect(impact.facts).toEqual([
      { id: 'demo-facts/down:demo.derived', depth: 1, via: 'demo.base' },
      { id: 'demo-facts/down:demo.leaf', depth: 2, via: 'demo-facts/down:demo.derived' },
    ])
  })

  test('finds fact: references in markdown and get/value/has calls and imports in TypeScript', async () => {
    const agg = await sample()
    const impact = await impactOf('demo.base', { cwd: agg })
    expect(impact.docs).toEqual([
      { file: 'docs/guide.md', line: 2, id: 'demo.base' },
      { file: 'docs/guide.md', line: 4, id: 'demo-facts/down:demo.derived' },
      { file: 'src/fact-object.ts', line: 1, id: 'demo-facts/down:demo.leaf' },
      { file: 'src/reader.ts', line: 3, id: 'demo.base' },
      { file: 'src/reader.ts', line: 4, id: 'demo-facts/down:demo.leaf' },
      { file: 'src/reader.ts', line: 5, id: 'demo-facts/down:demo.derived' },
    ])
  })

  test('lists an import of the fact object under any name', async () => {
    const impact = await impactOf('demo.base', { cwd: await sample() })
    expect(impact.docs).toContainEqual({ file: 'src/fact-object.ts', line: 1, id: 'demo-facts/down:demo.leaf' })
  })

  test('does not list an import named like a fact id when the module exports another value', async () => {
    const impact = await impactOf('demo.base', { cwd: await sample() })
    expect(impact.docs.filter((d) => d.file === 'src/decoy.ts')).toEqual([])
  })

  test('the CLI prints the --json shape, and text without it', async () => {
    const agg = await sample()
    const json = await cli(['diff', '--impact', 'demo.base', '--cwd', agg, '--json'])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.stdout)
    expect(Object.keys(parsed)).toEqual(['id', 'facts', 'docs', 'examples'])
    expect(parsed.examples).toEqual([])
    expect(parsed.facts[0]).toEqual({ id: 'demo-facts/down:demo.derived', depth: 1, via: 'demo.base' })
    const text = await cli(['diff', '--impact', 'demo.base', '--cwd', agg])
    expect(text.stdout).toContain('doc      src/reader.ts:3  demo.base')
    expect((await cli(['diff', '--impact', 'demo.base', 'a.json'], agg)).code).toBe(2)
    expect((await cli(['diff', '--impact', 'demo.nope', '--cwd', agg])).code).toBe(1)
  })

  test('a changed upstream fact shows up in diff and in --impact', async () => {
    const agg = await sample()
    const repo = join(agg, '..')
    const before = join(repo, 'up/dist/up/index.json')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const copy = join(repo, 'before.json')
    writeFileSync(copy, readFileSync(before))
    // The component is rebuilt with another value for demo.base.
    const changed = JSON.parse(readFileSync(before, 'utf8'))
    changed.facts[0].content.value = 2
    writeFileSync(before, JSON.stringify(changed))
    const diff = JSON.parse((await cli(['diff', copy, before, '--json'])).stdout)
    expect(diff.changed).toEqual(['demo.base'])
    expect(
      JSON.parse((await cli(['diff', '--impact', diff.changed[0], '--cwd', agg, '--json'])).stdout).facts,
    ).toHaveLength(2)
  })
})
