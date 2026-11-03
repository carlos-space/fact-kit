import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, checkProject, loadInstalledIndex, readFacts, validateIndex } from '../src/index.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const fact = (id: string) =>
  `{ id: '${id}', tool: 'demo', topics: ['t'], title: '${id}', content: { value: 1 }, source: { kind: 'published' } }`
const entry = (extra: string) => `export default { ${extra}describes: { demo: '1.2.0' }, facts: [${fact('demo.a')}] }\n`
const pkg = { name: '@demo/tool-facts', version: '1.0.0', type: 'module' }
const readIndex = (dir: string): any => JSON.parse(readFileSync(join(dir, 'dist', 'cli', 'index.json'), 'utf8'))

describe('entry layer', () => {
  test('a declared layer is written to the top level of the index, and the format minor is 2.1', async () => {
    const dir = makeTmp('layer-ok')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry("layer: 'org', ") })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const index = readIndex(dir)
    expect(index.layer).toBe('org')
    expect(index.indexFormat).toBe('2.1')
    expect(index.formatVersion).toBe('2.1')
    expect(Object.keys(index)).toEqual([
      'indexFormat',
      'formatVersion',
      'package',
      'entry',
      'describes',
      'layer',
      'facts',
    ])
    expect(validateIndex(index)).toEqual([])
  })

  test.each(['org', 'product', 'implementation', 'tool'])('layer %s is accepted', async (layer) => {
    const dir = makeTmp(`layer-${layer}`)
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry(`layer: '${layer}', `) })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    expect(readIndex(dir).layer).toBe(layer)
  })

  test('a layer outside the four values fails build and check, and the message names layer', async () => {
    const dir = makeTmp('layer-bad')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry("layer: 'team', ") })
    const built = await buildFacts({ cwd: dir })
    expect(built.problems.length).toBeGreaterThan(0)
    expect(built.problems.some((p) => p.message.includes('layer') && p.location?.includes('/layer'))).toBe(true)
    expect(built.files).toEqual([])
    const checked = await checkProject({ cwd: dir })
    expect(checked.problems.some((p) => p.code === 'format' && p.message.includes('layer'))).toBe(true)
  })

  test('a layer that is not a string fails too', async () => {
    const dir = makeTmp('layer-number')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry('layer: 3, ') })
    const built = await buildFacts({ cwd: dir })
    expect(built.problems.some((p) => p.message.includes('layer'))).toBe(true)
  })

  test('an entry without layer builds as before: no layer key in the index', async () => {
    const dir = makeTmp('layer-none')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry('') })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const index = readIndex(dir)
    expect('layer' in index).toBe(false)
    expect(index.indexFormat).toBe('2.1')
  })

  const hub = (name: string, index: object) => {
    const root = makeTmp(name)
    writeTree(root, {
      'package.json': { name: 'hub', private: true },
      'node_modules/pkg-facts/package.json': {
        name: 'pkg-facts',
        version: '1.0.0',
        exports: { './cli/index.json': './dist/cli/index.json' },
      },
      'node_modules/pkg-facts/dist/cli/index.json': index,
    })
    return root
  }
  const base = { package: 'pkg-facts', entry: 'cli', describes: {}, facts: [] }

  test('loadInstalledIndex and readFacts return layer, undefined when the index has none', () => {
    const withLayer = hub('read-layer', { indexFormat: '2.1', formatVersion: '2.1', ...base, layer: 'tool' })
    expect(loadInstalledIndex('pkg-facts/cli', withLayer).index.layer).toBe('tool')
    expect(readFacts('pkg-facts/cli', { root: withLayer }).layer).toBe('tool')
    const old = hub('read-no-layer', { indexFormat: '2.0', formatVersion: '2.0', ...base })
    expect(readFacts('pkg-facts/cli', { root: old }).layer).toBeUndefined()
    const older = hub('read-1-0', { ...base })
    expect(readFacts('pkg-facts/cli', { root: older }).layer).toBeUndefined()
  })
})
