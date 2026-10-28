import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, exportsCover, validateIndex } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

/** A fact package source: two entries (one nested), a shared helper, a schema file. */
const fixture = {
  'package.json': { name: '@demo/tool-facts', version: '1.0.0', type: 'module' },
  // Helpers live in a `_` directory, so they are not entries. Relative imports carry the .ts extension.
  'facts/_shared/statuses.ts': "export const STATUSES = ['todo', 'doing', 'done'] as const\n",
  'facts/cli/index.ts': [
    "import type { FactsModule } from 'fact-kit'",
    "import { STATUSES } from '../_shared/statuses.ts'",
    '',
    'const module: FactsModule = {',
    "  describes: { demo: '1.2.0' },",
    "  formatVersion: '2',",
    '  facts: [',
    "    { id: 'demo.status', tool: 'demo', topics: ['status'], title: 'Statuses', content: { value: [...STATUSES] }, source: { kind: 'published' } },",
    "    { id: 'demo.config', tool: 'demo', topics: ['config'], title: 'Config', content: { schema: { $ref: 'schemas/config.schema.json' } }, source: { kind: 'published' } },",
    '  ],',
    '}',
    'export default module',
    '',
  ].join('\n'),
  'facts/cli/schemas/config.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { model: { type: 'string', 'x-since': '1.0.0' } },
  },
  'facts/hooks/events/index.ts':
    "export default { describes: { demo: '1.2.0' }, facts: [{ id: 'demo.events', tool: 'demo', topics: ['hook'], title: 'Events', content: { statement: 'Events fire.' }, source: { kind: 'observed', basis: 'doc' } }] }\n",
}

describe('c003 build', () => {
  test('writes dist/<entry>/index.json, readable with JSON.parse and valid against the meta-schema', async () => {
    const dir = makeTmp('build')
    writeTree(dir, fixture)
    const result = await buildFacts({ cwd: dir })
    expect(result.problems).toEqual([])
    expect(result.entries).toEqual(['cli', 'hooks/events'])
    expect(result.files).toEqual([
      'dist/cli/index.json',
      'dist/cli/schemas/config.schema.json',
      'dist/hooks/events/index.json',
    ])

    // Read without fact-kit's own reader, as any other language would.
    const cliIndex = JSON.parse(readFileSync(join(dir, 'dist/cli/index.json'), 'utf8'))
    expect(Object.keys(cliIndex)).toEqual(['indexFormat', 'package', 'entry', 'formatVersion', 'describes', 'facts'])
    expect(cliIndex).toMatchObject({
      indexFormat: '1.2',
      package: '@demo/tool-facts',
      entry: 'cli',
      formatVersion: '2',
      describes: { demo: '1.2.0' },
    })
    expect(cliIndex.facts.map((f: { id: string }) => f.id)).toEqual(['demo.status', 'demo.config'])
    expect(cliIndex.facts[0].content.value).toEqual(['todo', 'doing', 'done'])
    expect(validateIndex(cliIndex)).toEqual([])

    const nested = JSON.parse(readFileSync(join(dir, 'dist/hooks/events/index.json'), 'utf8'))
    expect(nested).toMatchObject({ entry: 'hooks/events' })
    expect(Object.keys(nested)).toEqual(['indexFormat', 'package', 'entry', 'describes', 'facts'])
    expect(validateIndex(nested)).toEqual([])

    expect(readJson(join(dir, 'dist/cli/schemas/config.schema.json')).properties.model['x-since']).toBe('1.0.0')
    // `_shared` is not an entry.
    expect(existsSync(join(dir, 'dist/_shared'))).toBe(false)
  })

  test('reports the package.json exports that are missing, and adds them with writeExports', async () => {
    const dir = makeTmp('exports')
    writeTree(dir, fixture)
    const first = await buildFacts({ cwd: dir })
    expect(first.missingExports).toEqual(['./cli/index.json', './cli/schemas/*', './hooks/events/index.json'])
    expect(first.exportsUpdated).toBe(false)

    const second = await buildFacts({ cwd: dir, writeExports: true })
    expect(second.exportsUpdated).toBe(true)
    expect(readJson(join(dir, 'package.json')).exports).toEqual({
      './cli/index.json': './dist/cli/index.json',
      './cli/schemas/*': './dist/cli/schemas/*',
      './hooks/events/index.json': './dist/hooks/events/index.json',
    })

    const third = await buildFacts({ cwd: dir })
    expect(third.missingExports).toEqual([])
  })

  test('a wildcard export covers the entries it maps', () => {
    const exports = { './*/index.json': './dist/*/index.json' }
    expect(exportsCover(exports, './cli/index.json', './dist/cli/index.json')).toBe(true)
    expect(exportsCover(exports, './cli/index.json', './out/cli/index.json')).toBe(false)
    expect(exportsCover(undefined, './cli/index.json', './dist/cli/index.json')).toBe(false)
  })

  test('nothing is written when a fact is invalid or an id repeats', async () => {
    const dir = makeTmp('invalid')
    writeTree(dir, {
      ...fixture,
      'facts/hooks/events/index.ts':
        "export default { describes: {}, facts: [{ id: 'demo.status', tool: 'demo', topics: [], title: 'dup', content: { value: 1 }, source: { kind: 'bogus' } }] }\n",
    })
    const result = await buildFacts({ cwd: dir })
    expect(result.problems.map((p) => p.code).sort()).toEqual(['duplicate-id', 'format'])
    expect(result.files).toEqual([])
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  test('the CLI builds, fails on missing exports, and succeeds with --write-exports', async () => {
    const dir = makeTmp('cli-build')
    writeTree(dir, fixture)
    const missing = await cli(['build', '--cwd', dir])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain('wrote dist/cli/index.json')
    expect(missing.stderr).toContain('./cli/index.json')
    const ok = await cli(['build', '--cwd', dir, '--write-exports'])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('updated package.json exports')
    expect((await cli(['build', '--cwd', dir])).code).toBe(0)
  })
})
