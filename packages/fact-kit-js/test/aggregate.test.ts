import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, readFacts, validateIndex } from '../src/index.ts'
import { cleanTmp, cli, componentTree, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

/** Three components in one repository: a root one, a sub-path one and one with two entries. */
async function sample(rootEntries?: Record<string, { id: string }[]>) {
  const repo = makeTmp('aggregate')
  const components: Record<string, Parameters<typeof componentTree>[1]> = {
    core: rootEntries ?? { core: [{ id: 'core.one', value: 'a' }] },
    tool: { tool: [{ id: 'tool.one', derivedFrom: ['demo-facts:core.one'] }] },
    multi: {
      'multi/a': [{ id: 'multi.a' }],
      'multi/b': [{ id: 'multi.b', derivedFrom: ['@npm/multi/multi/a:multi.a'] }],
    },
  }
  for (const [dir, entries] of Object.entries(components)) {
    writeTree(repo, {
      ...Object.fromEntries(Object.entries(componentTree(`@npm/${dir}`, entries)).map(([k, v]) => [`${dir}/${k}`, v])),
    })
    expect((await buildFacts({ cwd: join(repo, dir) })).problems).toEqual([])
  }
  writeTree(repo, {
    'agg/package.json': { name: 'demo-facts', version: '1.0.0', type: 'module', files: ['dist'] },
    'agg/fact-kit.config.json': {
      aggregate: { '.': '@npm/core', tool: '@npm/tool', multi: '@npm/multi' },
    },
  })
  for (const dir of Object.keys(components)) linkPackage(join(repo, 'agg'), `@npm/${dir}`, join(repo, dir))
  return { repo, agg: join(repo, 'agg') }
}

describe('c002 aggregate build', () => {
  test('places root, sub-path and multi-entry components under dist/ and rewrites the identity', async () => {
    const { agg } = await sample()
    const result = await buildFacts({ cwd: agg, writeExports: true })
    expect(result.problems).toEqual([])
    expect(result.files).toEqual([
      'dist/index.json',
      'dist/tool/index.json',
      'dist/multi/multi/a/index.json',
      'dist/multi/multi/b/index.json',
    ])
    const root = readJson(join(agg, 'dist/index.json'))
    expect(root).toMatchObject({ package: 'demo-facts', entry: '.', component: '@npm/core' })
    expect(validateIndex(root)).toEqual([])
    expect(readJson(join(agg, 'dist/tool/index.json'))).toMatchObject({
      package: 'demo-facts',
      entry: 'tool',
      component: '@npm/tool',
    })
    const b = readJson(join(agg, 'dist/multi/multi/b/index.json'))
    expect(b.entry).toBe('multi/multi/b')
    // A location in another entry of the same component becomes the published spec.
    expect(b.facts[0].derivedFrom).toEqual(['demo-facts/multi/multi/a:multi.a'])
    expect(Object.keys(readJson(join(agg, 'package.json')).exports)).toEqual([
      './index.json',
      './schemas/*',
      './tool/index.json',
      './tool/schemas/*',
      './multi/multi/a/index.json',
      './multi/multi/a/schemas/*',
      './multi/multi/b/index.json',
      './multi/multi/b/schemas/*',
    ])
  })

  test('readFacts reads the root, the sub-path and an entry of the multi-entry component by spec', async () => {
    const { repo, agg } = await sample()
    await buildFacts({ cwd: agg, writeExports: true })
    const hub = join(repo, 'consumer')
    writeTree(hub, { 'package.json': { name: 'hub', private: true } })
    linkPackage(hub, 'demo-facts', agg)
    expect(readFacts('demo-facts', { root: hub }).get('core.one').id).toBe('core.one')
    expect(readFacts('demo-facts/tool', { root: hub }).get('tool.one').id).toBe('tool.one')
    const b = readFacts('demo-facts/multi/multi/b', { root: hub })
    expect(b.entry).toBe('multi/multi/b')
    expect(b.package).toBe('demo-facts')
  })

  test('copies schemas/ next to the index and exports it', async () => {
    const repo = makeTmp('aggregate-schemas')
    writeTree(repo, {
      ...Object.fromEntries(
        Object.entries(
          componentTree('@npm/c', { c: [{ id: 'c.one' }] }, { 'facts/c/schemas/s.schema.json': { type: 'object' } }),
        ).map(([k, v]) => [`c/${k}`, v]),
      ),
      'agg/package.json': { name: 'agg-facts', version: '1.0.0', type: 'module' },
      'agg/fact-kit.config.json': { aggregate: { '.': '@npm/c' } },
    })
    await buildFacts({ cwd: join(repo, 'c') })
    linkPackage(join(repo, 'agg'), '@npm/c', join(repo, 'c'))
    const result = await buildFacts({ cwd: join(repo, 'agg') })
    expect(result.problems).toEqual([])
    expect(readJson(join(repo, 'agg/dist/schemas/s.schema.json'))).toEqual({ type: 'object' })
    expect(result.missingExports).toEqual(['./index.json', './schemas/*'])
  })

  test('a root entry with the name of a sub-path fails the build and names the conflict', async () => {
    const repo = makeTmp('aggregate-clash')
    const root = { tool: [{ id: 'core.a' }], other: [{ id: 'core.b' }] }
    writeTree(repo, {
      ...Object.fromEntries(Object.entries(componentTree('@npm/core', root)).map(([k, v]) => [`core/${k}`, v])),
      ...Object.fromEntries(
        Object.entries(componentTree('@npm/tool', { tool: [{ id: 'tool.one' }] })).map(([k, v]) => [`tool/${k}`, v]),
      ),
      'agg/package.json': { name: 'demo-facts', version: '1.0.0', type: 'module' },
      'agg/fact-kit.config.json': { aggregate: { '.': '@npm/core', tool: '@npm/tool' } },
    })
    await buildFacts({ cwd: join(repo, 'core') })
    await buildFacts({ cwd: join(repo, 'tool') })
    linkPackage(join(repo, 'agg'), '@npm/core', join(repo, 'core'))
    linkPackage(join(repo, 'agg'), '@npm/tool', join(repo, 'tool'))
    const result = await buildFacts({ cwd: join(repo, 'agg') })
    expect(result.problems.map((p) => p.message)).toEqual([
      'aggregate: the name "tool" is taken by both "@npm/core" (sub-path ".", entry "tool") and "@npm/tool" (sub-path "tool", entry "tool")',
    ])
    expect(existsSync(join(repo, 'agg/dist'))).toBe(false)
    const run = await cli(['build', '--cwd', join(repo, 'agg')])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('the name "tool" is taken by both')
  })

  test('a component that was not built is reported', async () => {
    const repo = makeTmp('aggregate-unbuilt')
    writeTree(repo, {
      ...Object.fromEntries(
        Object.entries(componentTree('@npm/c', { c: [{ id: 'c.one' }] })).map(([k, v]) => [`c/${k}`, v]),
      ),
      'agg/package.json': { name: 'agg-facts', version: '1.0.0', type: 'module' },
      'agg/fact-kit.config.json': { aggregate: { '.': '@npm/c' } },
    })
    linkPackage(join(repo, 'agg'), '@npm/c', join(repo, 'c'))
    const result = await buildFacts({ cwd: join(repo, 'agg') })
    expect(result.problems[0]?.message).toContain('"@npm/c" has no built index under dist/. Build it first.')
  })
})
