import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
// Every name comes from the package entry only, as a package that extends fact-kit would import it.
import {
  BUILDER,
  BuilderError,
  FactReadError,
  applyEdits,
  assertIndex,
  buildFacts,
  compareSemver,
  factRows,
  findRows,
  history,
  impactOf,
  installedVersion,
  isObject,
  isText,
  loadInstalledIndex,
  loadInstalledJson,
  makeBuilt,
  mergeSince,
  mustParse,
  parseVersion,
  pinVersion,
  registerBuilderCheck,
  registerImpactExtractor,
  setMark,
  sinceIssue,
  splitSpec,
} from '../src/index.ts'
import type { ImpactExtractor, InstalledJson, Row } from '../src/index.ts'
import { cleanTmp, componentTree, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

describe('c001 builder extension points', () => {
  test('a custom builder registers a check that history enforces', () => {
    registerBuilderCheck('demoPair', (root) => {
      if (!isObject(root) || !isText(root.label)) return '/label: needs a text'
      return undefined
    })
    const make = (value: Record<string, unknown>) => {
      const built = { ...value }
      setMark(built, BUILDER, 'demoPair')
      return built
    }
    expect(Object.keys(make({ label: 'a' }))).toEqual(['label'])
    expect(() => history({ since: '0.1.0', value: make({ label: 'a' }) })).not.toThrow()
    expect(() =>
      history({ since: '0.1.0', value: make({ label: 'a' }) }, { since: '0.2.0', set: { '/label': '' } }),
    ).toThrow(BuilderError)
    const built = makeBuilt('text', [], 'demoPair')
    expect((built as unknown as Record<symbol, unknown>)[BUILDER]).toBe('demoPair')
  })
})

describe('c002 version and read helpers', () => {
  test('are callable from the entry', () => {
    const v = mustParse('1.2.3', 'x')
    expect(parseVersion('1.2.3')).toEqual(v)
    expect(compareSemver(v, mustParse('1.2.4', 'x'))).toBe(-1)
    expect(sinceIssue('next')).toBeUndefined()
    expect(splitSpec('@a/b/c')).toEqual({ packageName: '@a/b', entry: 'c' })
    expect(applyEdits('abc', [{ start: 1, end: 2, text: 'X' }])).toBe('aXc')
    expect(findRows({ type: 'Program' })).toEqual([])
    expect(typeof installedVersion).toBe('function')
    expect(typeof assertIndex).toBe('function')
    expect(typeof loadInstalledIndex).toBe('function')
    const rows: Row[] = factRows({ id: 'a.b', content: { value: 1 } } as never)
    expect(rows).toHaveLength(1)
  })
})

/** Parses a source string with oxc the way pin does. */
async function programOf(source: string): Promise<unknown> {
  const { loadOxc } = await import('../src/oxc.ts')
  return (await loadOxc()).parseSync('x.ts', source).program
}

describe('c003 data keys of pin', () => {
  const source = `export default { facts: [{ id: 'a.b', variants: [{ since: '0.1.0', content: { value: 1 } }], wrap: { rows: { since: 'next' } } }] }\n`
  const nested = `export default { facts: [{ id: 'a.b', content: { since: 'next' } }] }\n`

  test('findRows skips the default keys and takes a replacement list', async () => {
    expect(findRows(await programOf(nested))).toHaveLength(0)
    expect(findRows(await programOf(nested), { dataKeys: [] })).toHaveLength(1)
    expect(findRows(await programOf(source), { dataKeys: ['wrap'] })).toHaveLength(1)
  })

  async function sample(config?: unknown): Promise<string> {
    const dir = makeTmp('datakeys')
    writeTree(dir, {
      'package.json': { name: 'demo', type: 'module' },
      'facts/demo/index.ts': nested,
      ...(config ? { 'fact-kit.config.json': config } : {}),
    })
    return dir
  }

  test('pinVersion pins a since under content when dataKeys is set, by option or by config', async () => {
    const byOption = await sample()
    expect((await pinVersion({ version: '1.0.0', cwd: byOption, dataKeys: [] })).changed).toEqual([
      { file: 'facts/demo/index.ts', pinned: 1 },
    ])
    expect(readFileSync(join(byOption, 'facts/demo/index.ts'), 'utf8')).toContain("since: '1.0.0'")
    const byConfig = await sample({ dataKeys: [] })
    expect((await pinVersion({ version: '1.0.0', cwd: byConfig })).changed).toHaveLength(1)
  })

  test('pinVersion without the setting leaves it alone', async () => {
    const dir = await sample()
    expect((await pinVersion({ version: '1.0.0', cwd: dir })).changed).toEqual([])
    expect(readFileSync(join(dir, 'facts/demo/index.ts'), 'utf8')).toBe(nested)
  })

  test('a dataKeys that is not a list of strings is a config error', async () => {
    const dir = await sample({ dataKeys: 'content' })
    await expect(pinVersion({ version: '1.0.0', cwd: dir })).rejects.toThrow(/"dataKeys" must be a list of strings/)
  })

  test('mergeSince takes the option too', () => {
    expect(typeof mergeSince).toBe('function')
    const options: Parameters<typeof mergeSince>[0] = { dataKeys: ['wrap'] }
    expect(options?.dataKeys).toEqual(['wrap'])
  })
})

describe('c004 impact extractors', () => {
  async function plain() {
    const dir = makeTmp('impact-plain')
    writeTree(dir, {
      ...componentTree('@npm/solo', { solo: [{ id: 'demo.base' }, { id: 'demo.other' }] }),
      'fact-kit.config.json': { docsDirs: ['docs'] },
      'docs/page.mdx': 'line one\nuses {{demo.base}} here\n',
      'docs/page.md': 'a fact:demo.other\n',
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    return dir
  }

  const mdx: ImpactExtractor = {
    name: 'curly',
    extensions: ['.mdx'],
    extract: ({ text, lookup }) =>
      text.split('\n').flatMap((line, i) =>
        [...line.matchAll(/\{\{([^}]+)\}\}/g)].flatMap((m) => {
          const id = lookup(m[1] as string)
          return id === undefined ? [] : [{ line: i + 1, id }]
        }),
      ),
  }

  test('a registered extractor reports references in a package without aggregate', async () => {
    const dir = await plain()
    const remove = registerImpactExtractor(mdx)
    try {
      const impact = await impactOf('demo.base', { cwd: dir })
      expect(impact.docs).toEqual([{ file: 'docs/page.mdx', line: 2, id: 'demo.base' }])
    } finally {
      remove()
    }
    expect((await impactOf('demo.base', { cwd: dir })).docs).toEqual([])
  })

  test('the extractors option applies to one call', async () => {
    const dir = await plain()
    const impact = await impactOf('demo.base', { cwd: dir, extractors: [mdx] })
    expect(impact.docs).toHaveLength(1)
    expect((await impactOf('demo.base', { cwd: dir })).docs).toEqual([])
  })

  test('the markdown built-in still reads .md in a package without aggregate', async () => {
    const dir = await plain()
    expect((await impactOf('demo.other', { cwd: dir })).docs).toEqual([
      { file: 'docs/page.md', line: 1, id: 'demo.other' },
    ])
  })

  test('a name given twice keeps the last', async () => {
    const dir = await plain()
    const silent: ImpactExtractor = { ...mdx, extract: () => [] }
    const remove = registerImpactExtractor(mdx)
    try {
      expect((await impactOf('demo.base', { cwd: dir, extractors: [silent] })).docs).toEqual([])
    } finally {
      remove()
    }
  })
})

describe('c006 loadInstalledJson', () => {
  function docsSample(): string {
    const root = makeTmp('installed-json')
    writeTree(root, {
      'package.json': { name: 'host', type: 'module' },
      'node_modules/doc-pack/package.json': {
        name: 'doc-pack',
        version: '3.4.5',
        exports: { './index.json': './index.json' },
      },
      'node_modules/doc-pack/index.json': { docs: [{ id: 'd1' }], formatVersion: '9.0' },
    })
    return root
  }

  test('reads content that is not an index, with the package version', () => {
    const root = docsSample()
    const got: InstalledJson = loadInstalledJson('doc-pack', root)
    expect(got.data).toEqual({ docs: [{ id: 'd1' }], formatVersion: '9.0' })
    expect(got.packageVersion).toBe('3.4.5')
    expect(got.packageName).toBe('doc-pack')
    expect(got.entry).toBe('')
    expect(got.file).toMatch(/doc-pack\/index\.json$/)
  })

  test('loadInstalledIndex on the same file throws not-an-index', () => {
    const root = docsSample()
    expect(() => loadInstalledIndex('doc-pack', root)).toThrowError(FactReadError)
    try {
      loadInstalledIndex('doc-pack', root)
    } catch (error) {
      expect((error as FactReadError).code).toBe('not-an-index')
    }
  })

  test('not-found and non-JSON keep their codes', () => {
    const root = docsSample()
    try {
      loadInstalledJson('missing-pack', root)
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FactReadError).code).toBe('not-found')
    }
    writeTree(root, { 'node_modules/doc-pack/index.json': 'not json' })
    try {
      loadInstalledJson('doc-pack', root)
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as FactReadError).code).toBe('not-an-index')
    }
  })
})
