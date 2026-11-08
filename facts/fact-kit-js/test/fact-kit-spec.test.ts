// Compares the facts in facts/fact-kit-js with the fact-kit implementation. The facts are the spec, so a change to
// one side without the other fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterAll, describe, expect, it } from 'vitest'
import { cli, cleanTmp, makeTmp, writeTree } from '../../../packages/fact-kit-js/test/helpers.ts'
import * as kitModule from '../../../packages/fact-kit-js/src/index.ts'
import {
  aggregateExports,
  X_KEYWORDS,
  buildIndex,
  exampleGroupSchema as implExampleGroupSchema,
  factSchema as implFactSchema,
  flattenSchema,
  history,
  INDEX_FORMAT,
  indexSchema as implIndexSchema,
  readFacts,
  selectFacts,
  validateExampleGroup,
  validateFact,
} from '../../../packages/fact-kit-js/src/index.ts'
import { loadEntries } from '../../../packages/fact-kit-js/src/load.ts'
import type { Fact } from '../../../packages/fact-kit-js/src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const kitSrc = join(fileURLToPath(new URL('../../../packages/fact-kit-js', import.meta.url)), 'src')

const entries = await loadEntries(join(root, 'facts'))
const spec = entries.find((e) => e.entry === 'fact-kit-js')
if (!spec) throw new Error('facts/fact-kit-js is missing')
// The facts are the spec of the unreleased code, so they are read as `head` of the built index. A fact with
// several rows has no content of its own before the build.
const specIndex = buildIndex('fact-kit-facts', spec)
const byId = new Map(selectFacts(specIndex, { version: 'head' }).map((f) => [f.id, f]))
const content = (id: string): any => {
  const f = byId.get(id)
  if (!f) throw new Error(`no fact ${id}`)
  return 'schema' in f.content ? f.content.schema : (f.content as { value: unknown }).value
}
const allFacts: Fact[] = entries.flatMap((e) => buildIndex('fact-kit-facts', e).facts)

afterAll(() => cleanTmp())

describe('fact-kit.fact and fact-kit.index', () => {
  const ajv = new Ajv2020({ strict: false })
  const validate = ajv.compile(content('fact-kit.fact'))

  it('accepts every fact in this package', () => {
    const bad = allFacts.filter((f) => !(validate(f) as boolean)).map((f) => f.id)
    expect(bad).toEqual([])
  })

  it('names the same fields as the implementation meta-schema', () => {
    const spec = content('fact-kit.fact')
    expect(Object.keys(spec.properties).sort()).toEqual(Object.keys(implFactSchema.properties).sort())
    expect([...spec.required].sort()).toEqual([...implFactSchema.required].sort())
    expect(Object.keys(spec.properties.content.properties).sort()).toEqual(
      Object.keys(implFactSchema.properties.content.properties).sort(),
    )
    expect(Object.keys(spec.properties.when.properties).sort()).toEqual(
      Object.keys(implFactSchema.properties.when.properties).sort(),
    )
    expect(spec.properties.id.pattern).toBe(implFactSchema.properties.id.pattern)
    expect(spec.properties.tool.pattern).toBe(implFactSchema.properties.tool.pattern)
  })

  it('agrees with validateFact on good and bad facts', () => {
    const good: Fact = {
      id: 'demo.thing',
      tool: 'demo',
      topics: ['t'],
      title: 'Thing',
      content: { value: [1] },
      source: { kind: 'published' },
    }
    const samples: unknown[] = [
      good,
      { ...good, extra: 1 },
      { ...good, id: 'Demo.thing' },
      { ...good, title: undefined },
      { ...good, content: { value: 1, statement: 'x' } },
      { ...good, source: { kind: 'converted', from: 'a' } },
      { ...good, source: { kind: 'observed', basis: 'guess' } },
      { ...good, when: { os: ['beos'] } },
      { ...good, verify: { probe: { kind: 'manual' }, verifiedOn: '2026-01-01' } },
      { ...good, title: { fr: 'chose' } },
      { ...good, source: { kind: 'derived', from: '@up/x-facts/cli', version: '1.0.0' } },
      { ...good, source: { kind: 'derived', from: '@up/x-facts/cli' } },
      { ...good, source: { kind: 'derived', from: 'a', version: '1', extra: true } },
    ]
    for (const sample of samples) {
      expect(validate(sample), JSON.stringify(sample)).toBe(validateFact(sample).length === 0)
    }
  })

  it('describes the built index and the entry module like the implementation does', () => {
    const index = ajv.compile(content('fact-kit.index'))
    for (const e of entries) expect(index(buildIndex('platform-facts', e)), e.entry).toBe(true)
    expect(index({ package: 'p', entry: 'e', facts: [] })).toBe(false)
    expect(Object.keys(content('fact-kit.index').properties).sort()).toEqual(
      Object.keys(implIndexSchema.properties).sort(),
    )
    expect(Object.keys(content('fact-kit.entry-module').properties).sort()).toEqual([
      'dataFormatVersion',
      'describes',
      'facts',
      'layer',
      'publish',
    ])
  })
})

describe('fact-kit.x-keywords', () => {
  it('lists the registered keywords with their value shapes', () => {
    expect(content('fact-kit.x-keywords')).toEqual(X_KEYWORDS)
  })

  it('has x-identity on head and not for a reader of 0.7.0', () => {
    const read = (version?: string) =>
      (
        selectFacts(specIndex, version === undefined ? {} : { version }).find(
          (fact) => fact.id === 'fact-kit.x-keywords',
        )?.content as { value: Record<string, unknown> }
      ).value
    expect(Object.keys(read('head'))).toContain('x-identity')
    expect(Object.keys(read('0.7.0'))).not.toContain('x-identity')
    expect(Object.keys(read('head')).filter((k) => k !== 'x-identity')).toEqual(Object.keys(read('0.7.0')))
  })
})

const commands2 = content('fact-kit.cli')

describe('fact-kit.cli', () => {
  const commands = content('fact-kit.cli')

  /** Flags per command, read from the sections of the help text. */
  async function helpFlags(): Promise<{ text: string; sections: Record<string, string[]> }> {
    const { stdout } = await cli(['--help'])
    const sections: Record<string, string[]> = {}
    let current: string | undefined
    for (const line of stdout.split('\n')) {
      const header = /^Options for ([\w-]+)/.exec(line)
      if (header) current = header[1]
      else if (/^\S/.test(line) || line.trim() === '') current = line.trim() === '' ? undefined : current
      else if (current) {
        const flag = /^\s+(--[a-z-]+)/.exec(line)
        if (flag) (sections[current] ??= []).push(flag[1] as string)
      }
    }
    return { text: stdout, sections }
  }

  it('has the commands and flags of the help text', async () => {
    const { text, sections } = await helpFlags()
    for (const name of ['check', 'build', 'diff', 'pin', 'merge-since']) {
      expect(text, name).toMatch(new RegExp(`^  ${name}\\b`, 'm'))
      const flags = (commands[name].options as { flag: string }[]).map((o) => o.flag).sort()
      expect(flags, name).toEqual([...(sections[name] ?? [])].sort())
    }
    expect(Object.keys(commands).sort()).toEqual(['build', 'check', 'diff', 'global', 'merge-since', 'pin'])
    for (const o of commands.global.options) {
      expect(text).toContain(o.flag)
      expect(text).toContain(o.alias)
    }
  })

  it('marks the repeatable flags and the defaults the help text gives', async () => {
    const { text } = await helpFlags()
    const repeatable = (commands.check.options as { flag: string; repeatable?: boolean }[]).filter((o) => o.repeatable)
    expect(repeatable.map((o) => o.flag).sort()).toEqual(['--allow-domain', '--index', '--train'])
    for (const o of repeatable) expect(text).toMatch(new RegExp(`${o.flag} .*`))
    expect(text).toMatch(/--facts-dir <dir>\s+Fact sources.*\(default: facts\)/)
    expect(text).toMatch(/--out-dir <dir>\s+Output directory \(default: dist\)/)
    expect(text).toMatch(/--examples-dir <dir>.*\(default: examples\)/)
  })

  it('exits with the documented codes', async () => {
    expect(commands.global.exitCodes).toEqual({
      '0': expect.any(String),
      '1': expect.any(String),
      '2': expect.any(String),
    })
    const dir = makeTmp('cli-codes')
    expect((await cli(['check', '--cwd', dir])).code).toBe(0)
    expect((await cli([])).code).toBe(2)
    expect((await cli(['nope'])).code).toBe(2)
    expect((await cli(['diff', 'only-one'])).code).toBe(2)
    expect((await cli(['pin', '--cwd', dir])).code).toBe(2)
    expect((await cli(['pin', '--version', '1', '--cwd', dir])).code).toBe(2)
    expect((await cli(['pin', '--version', '1.0.0', '--version', '1.0.1', '--cwd', dir])).code).toBe(2)
    expect((await cli(['pin', '--version', '1.0.0', '--cwd', dir])).code).toBe(0)
    expect((await cli(['merge-since', '--cwd', dir])).code).toBe(2)
    expect((await cli(['--help'])).code).toBe(0)
    writeTree(dir, {
      'facts/bad/index.ts': 'export default { facts: [{}] }\n',
      'package.json': { name: 'x', type: 'module' },
    })
    expect((await cli(['check', '--cwd', dir])).code).toBe(1)
  })

  it('takes the diff arguments and prints the --json shape', async () => {
    expect(commands.diff.arguments).toEqual(['<old>', '<new>'])
    const dir = makeTmp('cli-diff')
    const index = (ids: string[]) => ({ facts: ids.map((id) => ({ id })) })
    writeTree(dir, { 'a.json': index(['x.a', 'x.b']), 'b.json': index(['x.b', 'x.c']) })
    const { stdout } = await cli(['diff', join(dir, 'a.json'), join(dir, 'b.json'), '--json'])
    expect(Object.keys(JSON.parse(stdout)).sort()).toEqual(['added', 'changed', 'removed'])
  })

  it('prints the version of package.json', async () => {
    const pkg = JSON.parse(readFileSync(join(kitSrc, '..', 'package.json'), 'utf8')) as { version: string }
    expect((await cli(['--version'])).stdout.trim()).toBe(pkg.version)
    expect(spec.module.describes['fact-kit-js']).toBe(pkg.version)
  })
})

describe('fact-kit.problem-codes and fact-kit.config-file', () => {
  it('lists the problem codes of the Problem type', () => {
    const source = readFileSync(join(kitSrc, 'types.ts'), 'utf8')
    const block = /code:\s*([\s\S]*?)\n\s*message:/.exec(source)?.[1] ?? ''
    const codes = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    expect(codes.length).toBeGreaterThan(0)
    expect(content('fact-kit.problem-codes')).toEqual(codes)
  })

  it('lists the settings of ProjectConfig', () => {
    const source = readFileSync(join(kitSrc, 'project.ts'), 'utf8')
    const block = /export interface ProjectConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const keys = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
    expect(Object.keys(content('fact-kit.config-file').properties).sort()).toEqual([...keys].sort())
  })
})

describe('fact-kit.check-rules', () => {
  it('has one entry for each problem code, in no particular order', () => {
    const rules = content('fact-kit.check-rules') as { code: string; rule: string; reads: string }[]
    expect(rules.map((r) => r.code).sort()).toEqual([...content('fact-kit.problem-codes')].sort())
    for (const r of rules) expect(r.rule.length, r.code).toBeGreaterThan(10)
  })

  it('exits with 2 for a --train that is not <component>=<version>, as the cli fact says', async () => {
    expect(commands2.global.exitCodes['2']).toContain('--train')
    const dir = makeTmp('rules-exit')
    expect((await cli(['check', '--cwd', dir, '--train', 'demo'])).code).toBe(2)
    expect((await cli(['check', '--cwd', dir, '--train', 'demo=1.0.0', '--json'])).stdout).toBe(
      '{\n  "problems": []\n}\n',
    )
  })
})

describe('fact-kit.history-row', () => {
  const row = content('fact-kit.history-row')
  const validate = new Ajv2020({ strict: false }).compile(row)

  it('names the fields of HistoryRow', () => {
    const source = readFileSync(join(kitSrc, 'history.ts'), 'utf8')
    const block = /export interface HistoryRow \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const keys = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? '')
    expect(keys.length).toBeGreaterThan(0)
    expect(Object.keys(row.properties).sort()).toEqual([...keys].sort())
  })

  it('agrees with history() on rows that are and are not rows', () => {
    const good = [
      { since: '1.0.0', value: { a: 1 } },
      { since: '1.1.0', add: { '/a': [1] }, remove: { '/a': [2] }, replace: { '/b': 1 }, set: { '/c': 1 } },
      { since: '1.2.0', add: { '/properties': { note: { type: 'string' } } }, remove: { '/properties': ['status'] } },
      { since: ['1.0.1', 'next'], pending: 'x', stability: 'experimental', platforms: ['codex'], os: ['macos'] },
    ]
    for (const r of good) expect(validate(r), JSON.stringify(r)).toBe(true)
    const bad = [
      { value: 1 },
      { since: '1', nope: 1 },
      { since: '1', add: [1] },
      { since: '1', add: { '/a': 'x' } },
      { since: '1', remove: { '/a': { b: 1 } } },
      { since: '1', os: ['beos'] },
    ]
    for (const r of bad) {
      expect(validate(r), JSON.stringify(r)).toBe(false)
      expect(() => history(r as never, ...[])).toThrow()
    }
    expect(() => history(...(good.slice(0, 1) as never[]))).not.toThrow()
  })
})

describe('fact-kit.read-facts', () => {
  const sample = content('fact-kit.read-facts')

  it('reads a package and returns the documented members', () => {
    const hub = makeTmp('read-facts')
    writeTree(hub, {
      'package.json': { name: 'hub', private: true },
      'node_modules/@demo/x-facts/package.json': {
        name: '@demo/x-facts',
        version: '1.0.0',
        exports: { './sdk/index.json': './dist/sdk/index.json' },
      },
      'node_modules/@demo/x-facts/dist/sdk/index.json': {
        package: '@demo/x-facts',
        entry: 'sdk',
        describes: { demo: '1.0.0' },
        facts: [
          {
            id: 'demo.list',
            tool: 'demo',
            topics: [],
            title: 't',
            content: { value: [1, 2] },
            source: { kind: 'published' },
          },
          {
            id: 'demo.said',
            tool: 'demo',
            topics: [],
            title: 't',
            content: { statement: 's' },
            source: { kind: 'published' },
          },
        ],
      },
    })
    const reader = readFacts('@demo/x-facts/sdk', { root: hub })
    expect(Object.keys(reader).sort()).toEqual(sample.returns.members.map((m: { name: string }) => m.name).sort())
    expect(reader.value('demo.list')).toEqual([1, 2])
    expect(reader.has('demo.nope')).toBe(false)
    expect(() => reader.get('demo.nope')).toThrow()
    expect(() => reader.value('demo.said')).toThrow()
  })

  it('throws in the documented cases', () => {
    expect(sample.throws).toHaveLength(5)
    const hub = makeTmp('read-facts-throws')
    writeTree(hub, {
      'package.json': { name: 'hub', private: true },
      'node_modules/@demo/bad-facts/package.json': {
        name: '@demo/bad-facts',
        version: '1.0.0',
        exports: { './sdk/index.json': './dist/sdk/index.json' },
      },
      'node_modules/@demo/bad-facts/dist/sdk/index.json': { nothing: true },
      'node_modules/@demo/old-facts/package.json': {
        name: '@demo/old-facts',
        version: '1.0.0',
        exports: { './sdk/index.json': './dist/sdk/index.json' },
      },
      'node_modules/@demo/old-facts/dist/sdk/index.json': {
        package: '@demo/old-facts',
        entry: 'sdk',
        describes: { demo: '1.0.0' },
        facts: [],
      },
      'node_modules/demo/package.json': { name: 'demo', version: '2.0.0' },
    })
    expect(() => readFacts('', { root: hub })).toThrow(/not of the form/)
    expect(() => readFacts('@demo/old-facts/sdk', { root: hub, version: 'latest' })).toThrow(/invalid-version/)
    expect(() => readFacts('@demo/missing-facts/sdk', { root: hub })).toThrow(/cannot resolve/)
    expect(() => readFacts('@demo/bad-facts/sdk', { root: hub })).toThrow(/not a fact index/)
    expect(() => readFacts('@demo/old-facts/sdk', { root: hub })).toThrow(
      /describes demo 1\.0\.0, but .* has demo 2\.0\.0/,
    )
  })

  it('defaults root to process.cwd(), as the fact says', () => {
    expect(sample.parameters.find((p: { name: string }) => p.name === 'options.root').default).toBe('process.cwd()')
    const source = readFileSync(join(kitSrc, 'read.ts'), 'utf8')
    expect(source).toMatch(/options\.root \?\? process\.cwd\(\)/)
  })
})

describe('fact-kit.module-api', () => {
  const api = content('fact-kit.module-api')

  // Names that are not functions when the entry gives no `kind`: a type has no runtime value, and `DRAFT_2020_12` is
  // a string constant. An entry that gives a `kind` (`function`, `symbol`, `constant` or `type`) is read by it.
  const typeNames = ['NormalizeOptions', 'PinnedSource']
  const constantNames = ['DRAFT_2020_12']
  const kindOf = (e: { name: string; kind?: string }): string =>
    e.kind ?? (typeNames.includes(e.name) ? 'type' : constantNames.includes(e.name) ? 'constant' : 'function')
  const runtimeType: Record<string, string | undefined> = {
    function: 'function',
    symbol: 'symbol',
    constant: 'string',
    type: undefined,
  }

  it('names functions, symbols and constants fact-kit exports, and no runtime value for a type', () => {
    const exported = kitModule as Record<string, unknown>
    for (const e of api.exports as { name: string; kind?: string }[]) {
      expect(typeof exported[e.name], e.name).toBe(runtimeType[kindOf(e)] ?? 'undefined')
    }
  })

  // What the unreleased code adds to the exports. Each stays out of the list a reader of 0.7.0 gets.
  const added = [
    'factsOf',
    'observedDoc',
    'observedSpike',
    'contentOf',
    'statementFrom',
    'subsetOf',
    'stateMachine',
    'relations',
    'sequence',
    'stateMachineToMermaid',
    'relationsToMermaid',
    'sequenceToMermaid',
    'ref',
    'entity',
    'valueObject',
    'aggregate',
    'invariant',
    'domainEvent',
    'useCase',
  ]
  // What the 0.10.0-alpha.1 row adds: the helpers a converter script shares.
  const converterLib = [
    'writeFormatted',
    'stableJson',
    'DRAFT_2020_12',
    'NormalizeOptions',
    'normalizeSchema',
    'PinnedSource',
    'sourceUrl',
    'readPinned',
  ]
  // The names the extension-exports row adds, at the end of the list. They start at 0.12.0-alpha.1.
  const entryExportCount = 22
  const namesAt = (version?: string): string[] => {
    const f = selectFacts(specIndex, version === undefined ? {} : { version }).find(
      (fact) => fact.id === 'fact-kit.module-api',
    )
    return ((f?.content as { value: { exports: { name: string }[] } }).value.exports ?? []).map((e) => e.name)
  }

  it('lists every function of the builders on head and none of them for a reader of 0.7.0', () => {
    const head = api.exports.map((e: { name: string }) => e.name)
    for (const name of added) {
      expect(head, name).toContain(name)
      expect(typeof (kitModule as Record<string, unknown>)[name], name).toBe('function')
    }
    for (const name of converterLib) expect(head, name).toContain(name)
    const entryNames = (api.exports as { name: string }[]).slice(-entryExportCount).map((e) => e.name)
    const old = namesAt('0.7.0')
    const later = (name: string) => added.includes(name) || converterLib.includes(name) || entryNames.includes(name)
    expect(old.filter(later)).toEqual([])
    expect(head.filter((name: string) => !later(name))).toEqual(old)
    // A reader that names no version gets the latest published rows, which now include the 0.12.0-alpha.1 row.
    expect(namesAt()).toEqual(head)
    expect(namesAt('0.11.1')).toEqual(head.filter((name: string) => !entryNames.includes(name)))
    expect(namesAt('0.9.0')).toEqual(
      head.filter((name: string) => !converterLib.includes(name) && !entryNames.includes(name)),
    )
    expect(namesAt('head')).toEqual(head)
  })

  it('names each export once and writes the new history signature', () => {
    const head: string[] = api.exports.map((e: { name: string }) => e.name)
    expect(new Set(head).size).toBe(head.length)
    expect(api.exports.find((e: { name: string }) => e.name === 'history').signature).toContain('HistoryVariants')
  })

  it('keeps one 0.8.0 row for each fact that changed, one row each for the 0.9, 0.10, 0.11, 0.11.1 and 0.12 changes, one 0.12.1 row for pin and train-next, one 0.13.0 row for the entry layer, and next rows only for validatedBy', () => {
    // Released in 0.9.0-alpha.1: the `publish` field (index 1.2) and the component package names of the aggregate layout.
    const in09 = ['fact-kit.index', 'fact-kit.entry-module', 'fact-kit.read-facts', 'fact-kit.aggregate-layout']
    // Released in 0.10.0-alpha.1: the converter helpers with the `prettier` peer dependency.
    const in010 = ['fact-kit.module-api', 'fact-kit.converters']
    // The package name rules (fact-kit.facts-package-naming has one row and no variants).
    const in011 = [
      'fact-kit.problem-codes',
      'fact-kit.check-rules',
      'fact-kit.aggregate-layout',
      'fact-kit.impl-rules-basis',
    ]
    // Released in 0.11.1-alpha.1: the recursion and function member rules of interfaceToJsonSchema.
    const in0111 = ['fact-kit.converters']
    for (const fact of specIndex.facts) {
      const rows = (fact.variants ?? []).filter((v) => v.since === '0.8.0')
      expect(rows.length, fact.id).toBeLessThanOrEqual(1)
      expect((fact.variants ?? []).filter((v) => v.since === '0.9.0-alpha.1').length, fact.id).toBe(
        in09.includes(fact.id) ? 1 : 0,
      )
      expect((fact.variants ?? []).filter((v) => v.since === '0.10.0-alpha.1').length, fact.id).toBe(
        in010.includes(fact.id) ? 1 : 0,
      )
      expect((fact.variants ?? []).filter((v) => v.since === '0.11.0').length, fact.id).toBe(
        in011.includes(fact.id) ? 1 : 0,
      )
      expect((fact.variants ?? []).filter((v) => v.since === '0.11.1-alpha.1').length, fact.id).toBe(
        in0111.includes(fact.id) ? 1 : 0,
      )
      // Released in 0.12.0-alpha.1: index format 2.0 in the readers and the build, the sources and checks rules, and
      // the extension exports.
      const in012 = [
        'fact-kit.index-format-detection',
        'fact-kit.read-facts',
        'fact-kit.index',
        'fact-kit.entry-module',
        'fact-kit.index-format-boundaries',
        'fact-kit.impl-rules-basis',
        'fact-kit.cli',
        'fact-kit.config-file',
        'fact-kit.problem-codes',
        'fact-kit.check-rules',
        'fact-kit.facts-file-collection',
        'fact-kit.split-rules',
        'fact-kit.module-api',
        'fact-kit.row-data-keys',
        'fact-kit.impact-extractors',
      ]
      expect((fact.variants ?? []).filter((v) => v.since === '0.12.0-alpha.1').length, fact.id).toBe(
        in012.includes(fact.id) ? 1 : 0,
      )
      // Released in 0.12.1-alpha.1: `pin` and `train-next` also read `when.deprecatedIn` and `when.removeIn`.
      expect((fact.variants ?? []).filter((v) => v.since === '0.12.1-alpha.1').length, fact.id).toBe(
        ['fact-kit.cli', 'fact-kit.check-rules'].includes(fact.id) ? 1 : 0,
      )
      // Released in 0.13.0-alpha.1: the optional `layer` of an entry (index format 2.1).
      const in013 = [
        'fact-kit.index',
        'fact-kit.entry-module',
        'fact-kit.read-facts',
        'fact-kit.entry-layer',
        'fact-kit.index-format-2-1',
      ]
      expect((fact.variants ?? []).filter((v) => v.since === '0.13.0-alpha.1').length, fact.id).toBe(
        in013.includes(fact.id) ? 1 : 0,
      )
      // Planned for the next release: `validatedBy` and the `validated-by` problem code.
      const inNext = [
        'fact-kit.fact',
        'fact-kit.validated-by',
        'fact-kit.problem-codes',
        'fact-kit.check-rules',
        'fact-kit.check-index-input',
      ]
      expect((fact.variants ?? []).filter((v) => v.since === 'next').length, fact.id).toBe(
        inNext.includes(fact.id) ? 1 : 0,
      )
      expect(fact.when?.since, fact.id).not.toBe('next')
    }
    const changed = specIndex.facts.filter((f) => f.variants?.some((v) => v.since === '0.8.0')).map((f) => f.id)
    expect(changed.sort()).toEqual([
      'fact-kit.aggregate-layout',
      'fact-kit.check-rules',
      'fact-kit.cli',
      'fact-kit.config-file',
      'fact-kit.example-group',
      'fact-kit.history-row',
      'fact-kit.module-api',
      'fact-kit.problem-codes',
      'fact-kit.x-keywords',
    ])
    for (const id of changed) expect(specIndex.facts.find((f) => f.id === id)?.variants?.[0]?.since).toBe('0.7.0')
  })

  it('writes the outcome references into defineExamples and exampleFactRefs, and the signature of 0.7.0 for an older reader', () => {
    const find = (exports: { name: string }[], name: string) => exports.find((e) => e.name === name) as any
    expect(find(api.exports, 'exampleFactRefs').signature).toContain("in: 'facts' | 'outcome'")
    expect(find(api.exports, 'defineExamples').summary).toContain('statementFrom')
    const old = selectFacts(specIndex, { version: '0.7.0' }).find((f) => f.id === 'fact-kit.module-api')
    const oldExports = (old?.content as { value: { exports: { name: string; signature: string }[] } }).value.exports
    expect(find(oldExports, 'exampleFactRefs').signature).toBe(
      'exampleFactRefs(group: ExampleGroup) => { id: string; location: string }[]',
    )
    // The functions of the head list are exported, and the example helpers are among them.
    for (const name of ['defineExamples', 'exampleFactRefs'])
      expect(typeof (kitModule as any)[name], name).toBe('function')
  })

  it('lists the fields of SchemaRow', () => {
    const source = readFileSync(join(kitSrc, 'table.ts'), 'utf8')
    const block = /export interface SchemaRow \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const keys = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] ?? '')
    expect(keys.length).toBeGreaterThan(0)
    expect(api.schemaRow.map((r: { name: string }) => r.name).sort()).toEqual([...keys].sort())
    const [row] = flattenSchema({ type: 'object', properties: { a: { enum: ['x'] } } })
    expect(row).toBeDefined()
    expect(Object.keys(row ?? {}).every((k) => keys.includes(k))).toBe(true)
  })
})

describe('fact-kit.converters', () => {
  const converters = content('fact-kit.converters')

  it('names functions fact-kit exports', () => {
    const missing = converters.exports
      .map((e: { name: string }) => e.name)
      .filter((name: string) => typeof (kitModule as Record<string, unknown>)[name] !== 'function')
    expect(missing).toEqual([])
  })

  it('states the optional peer dependency that package.json declares', () => {
    const pkg = JSON.parse(readFileSync(join(kitSrc, '..', 'package.json'), 'utf8'))
    const { peerDependency, range, optional } = converters.requires
    expect(pkg.peerDependencies[peerDependency]).toBe(range)
    expect(pkg.peerDependenciesMeta[peerDependency].optional).toBe(optional)
    expect(pkg.dependencies?.[peerDependency]).toBeUndefined()
  })

  it('states the prettier optional peer dependency that package.json declares, and writeFormatted names it', () => {
    const pkg = JSON.parse(readFileSync(join(kitSrc, '..', 'package.json'), 'utf8'))
    const [prettier] = converters.optionalPeers
    expect(prettier.usedBy).toEqual(['writeFormatted'])
    expect(pkg.peerDependencies[prettier.peerDependency]).toBe(prettier.range)
    expect(pkg.peerDependenciesMeta[prettier.peerDependency].optional).toBe(true)
    expect(pkg.dependencies?.[prettier.peerDependency]).toBeUndefined()
    expect(prettier.install).toBe('pnpm add -D prettier@3')
    expect(readFileSync(join(kitSrc, 'peer.ts'), 'utf8')).toContain("prettier: 'prettier@3'")
  })

  it('describes the recursion and function member rules of interfaceToJsonSchema from the next release only', () => {
    const summaryAt = (version: string): string => {
      const fact = selectFacts(specIndex, { version }).find((f) => f.id === 'fact-kit.converters')
      const value = (fact?.content as { value: { exports: { name: string; summary: string }[] } }).value
      return value.exports.find((e) => e.name === 'interfaceToJsonSchema')!.summary
    }
    expect(summaryAt('0.11.0')).toBe(
      'An interface or type alias as a JSON Schema 2020-12 document. Referenced types become `$defs`. Union members and enum values keep the order of the source, `0 | number` keeps both members, and a tuple becomes `prefixItems`. JSDoc becomes `description`, and `descriptions: false` removes every `description`. Type errors in the input are not reported.',
    )
    expect(summaryAt('head')).toBe(
      'An interface or type alias as a JSON Schema 2020-12 document. A named interface or alias becomes a `$defs` entry, and a generic instantiation such as `Record<string, unknown>` is written in place. A type that refers to itself is a `$defs` entry that every place it appears references with `$ref`, an instantiation such as `Tree<string>` included. An instantiation is named as TypeScript prints it, such as `Tree<string>`, and a root type that refers to itself is also written out at the top. A generic type that makes a new instantiation at each level, such as `next?: Nest<Box<T>>` inside `Nest<T>`, throws an error that names it. A method is left out, and a property whose type is a function becomes `{ "$comment": "<signature>" }` with the signature as TypeScript prints it, such as `(n: number) => string`. Union members and enum values keep the order of the source, `0 | number` keeps both members, and a tuple becomes `prefixItems`. JSDoc becomes `description`, and `descriptions: false` removes every `description`. Type errors in the input are not reported. An error thrown while converting is not replaced by an error from closing the compiler process.',
    )
  })
})

describe('fact-kit.example-group', () => {
  const spec = content('fact-kit.example-group')
  const scenario = (s: any) => s.properties.scenarios.items
  const code = (s: any) => scenario(s).properties.code.items

  it('names the same fields as the implementation schema', () => {
    for (const pick of [(s: any) => s, scenario, code]) {
      expect(Object.keys(pick(spec).properties).sort()).toEqual(
        Object.keys(pick(implExampleGroupSchema).properties).sort(),
      )
      expect([...pick(spec).required].sort()).toEqual([...pick(implExampleGroupSchema).required].sort())
    }
    expect(spec.properties.id.pattern).toBe(implExampleGroupSchema.properties.id.pattern)
  })

  it('agrees with validateExampleGroup on good and bad groups', () => {
    const validate = new Ajv2020({ strict: false }).compile(spec)
    const good = {
      id: 'demo',
      name: 'Demo',
      situation: 's',
      claim: 'c',
      scenarios: [
        {
          title: 't',
          situation: 's',
          code: [{ caption: 'a.ts', lang: 'ts', source: '' }],
          outcome: [],
          points: [],
          facts: ['demo.x'],
        },
      ],
    }
    const samples: unknown[] = [
      good,
      { ...good, extra: 1 },
      { ...good, id: 'Demo' },
      { ...good, scenarios: [] },
      { ...good, scenarios: [{ ...good.scenarios[0], facts: [] }] },
      { ...good, scenarios: [{ ...good.scenarios[0], code: [{ caption: 'a.ts', lang: 'ts' }] }] },
      ...[
        ['text', { fact: 'demo.x', field: 'a.b', text: { en: 'x', 'zh-TW': 'y' } }],
        ['fact only', { fact: 'demo.x' }],
        ['no fact', { field: 'a' }],
        ['empty fact', { fact: '' }],
        ['extra key', { fact: 'demo.x', extra: 1 }],
        ['text as number', { fact: 'demo.x', text: 1 }],
        ['number', 1],
      ].map(([, item]) => ({ ...good, scenarios: [{ ...good.scenarios[0], outcome: ['plain', item] }] })),
    ]
    for (const sample of samples) {
      expect(validate(sample) as boolean, JSON.stringify(sample)).toBe(validateExampleGroup(sample).length === 0)
    }
  })

  it('lets a reader of 0.7.0 see only string outcomes', () => {
    const old = selectFacts(specIndex, { version: '0.7.0' }).find((f) => f.id === 'fact-kit.example-group')
    const outcome = (old?.content as any).schema.properties.scenarios.items.properties.outcome
    expect(outcome.items).toEqual({ type: 'string', minLength: 1 })
    expect(scenario(spec).properties.outcome.items.oneOf).toHaveLength(2)
  })
})

describe('fact-kit.aggregate-layout', () => {
  it('names the exports and the placements that aggregateExports writes', () => {
    const layout = content('fact-kit.aggregate-layout')
    const place = (component: string, subpath: string, dir: string) =>
      ({ component, subpath, dir }) as unknown as Parameters<typeof aggregateExports>[0][number]
    const exports = aggregateExports([place('@npm/a', '.', ''), place('@npm/b', 'sub', 'sub')], 'dist')
    expect(Object.keys(exports)).toEqual(['./index.json', './schemas/*', './sub/index.json', './sub/schemas/*'])
    expect(layout.exports.slice(0, 2)).toEqual(['./<dir>/index.json', './<dir>/schemas/*'])
    expect(layout.exports[2]).toContain('examples.json')
    const withExamples = aggregateExports([place('@npm/a', '.', ''), place('@npm/b', 'sub', 'sub')], 'dist', [
      { dir: '' },
      { dir: 'sub' },
    ])
    expect(Object.keys(withExamples).filter((k) => k.endsWith('examples.json'))).toEqual([
      './examples.json',
      './sub/examples.json',
    ])
    expect(layout.examples.file).toBe('examples.json')
    const old = selectFacts(specIndex, { version: '0.7.0' }).find((f) => f.id === 'fact-kit.aggregate-layout')
    expect((old?.content as any).value.exports).toEqual(['./<dir>/index.json', './<dir>/schemas/*'])
    expect((old?.content as any).value.examples).toBeUndefined()
    expect(layout.placement.map((p: { dir: string }) => p.dir)).toEqual([
      '.',
      '<entry>',
      '<sub-path>',
      '<sub-path>/<entry>',
    ])
  })
})

describe('fact-kit.facts-package-naming', () => {
  const naming = content('fact-kit.facts-package-naming')
  const rules = content('fact-kit.check-rules') as { code: string; rule: string }[]

  it('is read from 0.11.0 on, and the codes it names have a rule that points back at it', () => {
    const fact = specIndex.facts.find((f) => f.id === 'fact-kit.facts-package-naming')
    expect(fact?.when?.since).toBe('0.11.0')
    expect(selectFacts(specIndex, { version: '0.10.0' }).map((f) => f.id)).not.toContain(
      'fact-kit.facts-package-naming',
    )
    expect(selectFacts(specIndex, {}).map((f) => f.id)).toContain('fact-kit.facts-package-naming')
    expect(content('fact-kit.problem-codes')).toEqual(expect.arrayContaining(['policy-scope', 'facts-name']))
    for (const code of ['policy-scope', 'facts-name']) {
      expect(rules.find((r) => r.code === code)?.rule, code).toContain('fact-kit.facts-package-naming')
    }
    expect(Object.keys(naming).sort()).toEqual(
      ['aggregateUnit', 'base', 'checkedIn', 'examples', 'policy', 'prefix', 'suffix'].sort(),
    )
  })

  it('says the prefix follows the aggregate unit in aggregate-layout from the next release, and keeps the old sentence for 0.9.0', () => {
    const name = content('fact-kit.aggregate-layout').componentPackage.name as string
    expect(name).toContain('the unit that publishes the aggregate package')
    expect(name).not.toContain('A unit with restricted access')
    const old = selectFacts(specIndex, { version: '0.10.0' }).find((f) => f.id === 'fact-kit.aggregate-layout')
    expect((old?.content as any).value.componentPackage.name).toContain('A unit with restricted access adds')
  })

  it('reports policy-scope for a restricted policy with no scope, and nothing without the file', async () => {
    const dir = makeTmp('naming-spec')
    writeTree(dir, {
      'fact-kit.config.json': { repoRoot: '.' },
      'release-policy.json': { product: { name: 'x', members: [] }, access: 'restricted' },
    })
    const r = await cli(['check', '--cwd', dir, '--json'])
    expect([r.code, JSON.parse(r.stdout).problems.map((p: { code: string }) => p.code)]).toEqual([1, ['policy-scope']])
    expect(naming.policy.scope).toContain('policy-scope')
    const none = makeTmp('naming-spec')
    writeTree(none, { 'fact-kit.config.json': { repoRoot: '.' } })
    expect((await cli(['check', '--cwd', none, '--json'])).code).toBe(0)
  })
})

describe('index format 2.0', () => {
  const pendingContent = content

  it('writes the top-level keys of the index in the order of the build', () => {
    const schema = pendingContent('fact-kit.index')
    expect(Object.keys(schema.properties)).toEqual([
      'indexFormat',
      'formatVersion',
      'package',
      'entry',
      'component',
      'dataFormatVersion',
      'describes',
      'publish',
      'layer',
      'facts',
    ])
    expect(schema.required).toEqual(['indexFormat', 'formatVersion', 'package', 'entry', 'describes', 'facts'])
    expect(schema.required).not.toContain('dataFormatVersion')
    expect(schema.properties.dataFormatVersion.description).toContain('index.json')
    const entry = pendingContent('fact-kit.entry-module')
    expect(Object.keys(entry.properties)).toEqual(['layer', 'describes', 'dataFormatVersion', 'publish', 'facts'])
  })

  it('shows the reader rules and the build rows to a reader on head', () => {
    expect(Object.keys(content('fact-kit.index').properties)).toContain('dataFormatVersion')
    expect(byId.has('fact-kit.index-format-detection')).toBe(true)
    expect(byId.has('fact-kit.index-format-boundaries')).toBe(true)
    expect(JSON.stringify(content('fact-kit.read-facts'))).not.toContain('index format other than 1.x')
    expect(JSON.stringify(content('fact-kit.read-facts'))).toContain('another major version than 1 and 2')
  })

  it('gives the result of the seven kinds of index', () => {
    const d = content('fact-kit.index-format-detection')
    const cell = (n: number) => d.cases.find((c: { case: number }) => c.case === n)
    expect(d.cases).toHaveLength(7)
    const expected: [number, object, string, string][] = [
      [1, { indexFormat: '1.x' }, '1.x', '1.x'],
      [2, { indexFormat: '2.0', formatVersion: '2.0', dataFormatVersion: '<any>' }, '2.0', 'unsupported-index-format'],
      [3, { formatVersion: '2.0' }, '1.0', '1.0'],
      [4, { formatVersion: '3.0' }, '1.0', '1.0'],
      [5, { formatVersion: '4', note: 'a data format version, not an index format' }, '1.0', '1.0'],
      [6, { indexFormat: '2.0', formatVersion: '3.0' }, '2.0', 'unsupported-index-format'],
      [7, { indexFormat: '3.0' }, 'unsupported-index-format', 'unsupported-index-format'],
    ]
    for (const [n, top, nu, old] of expected) {
      expect(cell(n).top, `case ${n}`).toEqual(top)
      expect(cell(n).new, `case ${n}`).toBe(nu)
      expect(cell(n).old, `case ${n}`).toBe(old)
    }
    expect(d.rule.join(' ')).toContain('`indexFormat` only')
    expect(d.rule.join(' ')).toContain(
      'When `indexFormat` and the top-level `formatVersion` differ, only `indexFormat` counts.',
    )
  })

  it('writes the edge cases of the build, and the error code of an old source key is a known one', () => {
    const b = pendingContent('fact-kit.index-format-boundaries')
    expect(Object.keys(b)).toEqual(['aggregate', 'oldSourceKey'])
    expect(b.aggregate).toContain('copies a component index of format 1.x as it is')
    expect(content('fact-kit.problem-codes')).toContain(b.oldSourceKey.code)
    expect(b.oldSourceKey.rule).toContain('formatVersion')
  })

  it('changes the unsupported-index-format line of readFacts', () => {
    const throws: string[] = content('fact-kit.read-facts').throws
    expect(throws[2]).toContain('another major version than 1 and 2')
    expect(throws).toHaveLength(5)
  })
})

describe('entry layer and index format 2.1', () => {
  it('shows the new facts to a reader on head and to a reader without a version', () => {
    for (const id of ['fact-kit.entry-layer', 'fact-kit.index-format-2-1']) {
      expect(byId.has(id), id).toBe(true)
      expect(
        selectFacts(specIndex, {}).some((f) => f.id === id),
        id,
      ).toBe(true)
    }
  })

  it('names the four values like the implementation and says the field is optional', () => {
    const layer = content('fact-kit.entry-layer')
    expect(layer.values).toEqual(implIndexSchema.properties.layer.enum)
    expect(layer.required).toBe(false)
    expect(layer.invalid).toContain('`layer`')
    expect(content('fact-kit.index').properties.layer.enum).toEqual(layer.values)
    expect(content('fact-kit.entry-module').properties.layer.enum).toEqual(layer.values)
    expect(content('fact-kit.entry-module').required).not.toContain('layer')
    expect(content('fact-kit.index').required).not.toContain('layer')
  })

  it('writes the format minor the build writes', () => {
    expect(content('fact-kit.index-format-2-1').indexFormat).toBe(INDEX_FORMAT)
    expect(content('fact-kit.index').properties.indexFormat.description).toContain(`\`${INDEX_FORMAT}\``)
    // The 2.0 row stays for a reader of the released version.
    const released = selectFacts(specIndex, { version: '0.12.1' }).find((f) => f.id === 'fact-kit.index')
    expect(JSON.stringify(released?.content)).not.toContain('"layer"')
  })

  it('has the layer in a built index and in the reader result of the head spec', () => {
    const specAjv = new Ajv2020({ strict: false })
    specAjv.compile(content('fact-kit.fact'))
    const index = specAjv.compile(content('fact-kit.index'))
    const built = buildIndex('demo-facts', { ...spec, module: { ...spec.module, layer: 'tool' } })
    expect(built.layer).toBe('tool')
    expect(index(built)).toBe(true)
    expect(index({ ...built, layer: 'team' })).toBe(false)
    expect(content('fact-kit.read-facts').returns.members.map((m: { name: string }) => m.name)).toContain('layer')
  })
})

const demoIndex = {
  package: 'demo-facts',
  entry: 'demo',
  describes: {},
  facts: [
    {
      id: 'demo.a',
      tool: 'demo',
      topics: ['t'],
      title: 'A',
      content: { statement: 'A statement.' },
      source: { kind: 'published' },
    },
  ],
}

// The rows planned for the sources-checks work. They carry `pending: 'sources-checks'`, so a reader gets them only on
// `head` with that label in `include`. The facts of the next describe are how the code works today and have no label.
describe('pending sources-checks', () => {
  const label = 'sources-checks'
  const planned = selectFacts(specIndex, { version: 'head', include: ['sources-checks'] })
  const plannedById = new Map(planned.map((f) => [f.id, f]))
  const read = (id: string): any => {
    const f = plannedById.get(id)
    if (!f) throw new Error(`no fact ${id}`)
    return 'schema' in f.content ? f.content.schema : (f.content as { value: unknown }).value
  }
  const pendingRows = (id: string) =>
    (specIndex.facts.find((f) => f.id === id)?.variants ?? []).filter((v) => v.pending === label)

  // Behavior -> fact ids. A fact with `pending` is new work, one without is how the code works today.
  const table: Record<string, { ids: string[]; pending: boolean; task?: string }> = {
    'check --index reads <dir>/index.json, and may repeat': { ids: ['fact-kit.check-index-input'], pending: false },
    'one id table for sources and every --index (duplicate-id)': { ids: ['fact-kit.check-id-table'], pending: false },
    'pin reads the code under factsDir except _lib': { ids: ['fact-kit.input-files'], pending: false },
    'merge-since reads unmerged files and changed code files': { ids: ['fact-kit.input-files'], pending: false },
    'impl-imports-facts and impl-reads-facts-dist basis': { ids: ['fact-kit.impl-rules-basis'], pending: false },
    // Applied by the code, so the rows have no label any more. The tests below read them as part of `head`.
    'build reads factsDir of the config': { ids: ['fact-kit.cli', 'fact-kit.config-file'], pending: false },
    '*.facts.ts collection': { ids: ['fact-kit.facts-file-collection', 'fact-kit.problem-codes'], pending: false },
    'split rules': {
      ids: ['fact-kit.split-rules', 'fact-kit.check-rules', 'fact-kit.config-file'],
      pending: false,
    },
    'impl-imports-facts file rules': { ids: ['fact-kit.impl-rules-basis'], pending: false },
    // Applied by the extension-exports work: these rows have no pending label any more.
    'package entry exports': { ids: ['fact-kit.module-api'], pending: false },
    'pin data keys': { ids: ['fact-kit.row-data-keys'], pending: false },
    'impactOf extractors': { ids: ['fact-kit.impact-extractors', 'fact-kit.module-api'], pending: false },
  }

  it('has every fact id of the table in the built index, with pending rows only where the table says', () => {
    const missing = Object.values(table).flatMap((t) => t.ids.filter((id) => !specIndex.facts.some((f) => f.id === id)))
    expect(missing).toEqual([])
    for (const [name, t] of Object.entries(table)) {
      if (t.pending) for (const id of t.ids) expect(pendingRows(id).length > 0, `${name}: ${id}`).toBe(true)
    }
  })

  it('leaves no sources-checks row once every task has applied its rows', () => {
    expect(specIndex.facts.filter((f) => pendingRows(f.id).length > 0).map((f) => f.id)).toEqual([])
    expect(Object.values(table).filter((t) => t.pending || t.task)).toEqual([])
  })

  it('starts every new row in the next release, with one pending row for each fact', () => {
    for (const f of specIndex.facts) {
      const rows = pendingRows(f.id)
      expect(rows.length, f.id).toBeLessThanOrEqual(1)
      for (const row of rows) expect(row.since, f.id).toBe('next')
    }
  })

  it('collects *.facts.ts into the entry of its index.ts (six points)', () => {
    const c = read('fact-kit.facts-file-collection')
    expect(c.entryFile).toContain('index.ts')
    expect(c.entryFile).toContain('`facts` is optional')
    expect(c.entryName).toContain('relative to the facts directory')
    expect(c.exportPath).toContain('<entry>/index.json')
    expect(c.collectedFiles).toContain('subdirectory')
    expect(c.collectedFiles).toContain('another entry')
    expect(c.fileExport).toContain('default export')
    expect(c.fileExport).toContain('array of facts')
    expect(c.order).toEqual([expect.stringContaining('`facts` of `index.ts`'), expect.stringContaining('sorted by')])
    expect(c.reported.code).toBe('facts-file-orphan')
    expect(c.reported.when).toHaveLength(2)
    expect(c.reported.when[0]).toContain('no entry')
    expect(c.reported.when[1]).toContain('starts with `_`')
    expect(c.duplicates).toContain('duplicate-id')
    expect(content('fact-kit.problem-codes')).toContain('facts-file-orphan')
    expect(read('fact-kit.problem-codes')).toContain('facts-file-orphan')
    expect(pendingRows('fact-kit.facts-file-collection')).toHaveLength(0)
    expect(content('fact-kit.facts-file-collection').order).toEqual(c.order)
    // `facts` of `index.ts` is optional from the same release, in the 2.0 row of `fact-kit.entry-module`.
    expect(content('fact-kit.entry-module').required).toEqual(['describes'])
  })

  it('adds the split rules off by default, switched on by splitRules, and a rule for each code', () => {
    const s = read('fact-kit.split-rules')
    expect(s.enabledBy).toMatchObject({ setting: 'splitRules', default: false })
    expect(s.limit).toMatchObject({ setting: 'maxFactsPerFile', default: 40 })
    expect(s.scope).toContain('*.facts.ts')
    const codes = ['split-topic', 'split-size', 'split-index', 'split-tool']
    expect(s.rules.map((r: { code: string }) => r.code)).toEqual(codes)
    expect(s.rules[0].rule).toContain('`topics[0]`')
    expect(s.rules[1].rule).toContain('maxFactsPerFile')
    expect(s.rules[2].rule).toContain('`index.ts`')
    expect(s.rules[3].rule).toContain('`factsOf(`')
    const config = read('fact-kit.config-file').properties
    expect(config.splitRules).toMatchObject({ type: 'boolean', default: false })
    expect(config.maxFactsPerFile).toMatchObject({ type: 'integer', default: 40 })
    expect(content('fact-kit.config-file').properties.splitRules).toBeDefined()
    expect(content('fact-kit.split-rules')).toEqual(s)
    const rules = read('fact-kit.check-rules') as { code: string; rule: string }[]
    const problems = read('fact-kit.problem-codes') as string[]
    for (const code of [...codes, 'facts-file-orphan']) {
      expect(problems, code).toContain(code)
      expect(rules.find((r) => r.code === code)?.rule, code).toBeDefined()
    }
    for (const code of codes) expect(rules.find((r) => r.code === code)?.rule, code).toContain('splitRules')
    expect(rules.map((r) => r.code).sort()).toEqual([...problems].sort())
    expect(content('fact-kit.check-rules').map((r: { code: string }) => r.code)).toContain('split-tool')
  })

  it('lists five violations of impl-imports-facts, and keeps the code', () => {
    const rule = read('fact-kit.impl-rules-basis')['impl-imports-facts']
    expect(rule.violations.map((v: { kind: string }) => v.kind)).toEqual([
      'facts-file',
      'doc-file',
      'no-extension',
      'relative-facts-dir',
      'absolute-facts-dir',
    ])
    expect(rule.violations[0].rule).toContain('.facts.ts')
    expect(rule.violations[1].rule).toContain('.doc.ts')
    expect(rule.violations[2].rule).toContain('extension')
    expect(rule.violations[3].rule).toContain('relative')
    expect(rule.violations[4].rule).toContain('absolute')
    // A reader of 0.11.0 does not get the rows of the next release.
    const released = selectFacts(specIndex, { version: '0.11.0' }).find((f) => f.id === 'fact-kit.impl-rules-basis')
    expect((released?.content as any).value['impl-imports-facts'].violations).toBeUndefined()
    const check = (read('fact-kit.check-rules') as any[]).find((r) => r.code === 'impl-imports-facts')
    expect(check.violations).toBeUndefined()
  })

  it('lists the exports of the package entry in four kinds, with BUILDER a symbol', () => {
    const exports = read('fact-kit.module-api').exports as { name: string; kind?: string; summary: string }[]
    const named = new Map(exports.map((e) => [e.name, e.kind]))
    expect(new Set(exports.map((e) => e.name)).size).toBe(exports.length)
    const functions = [
      'registerBuilderCheck',
      'setMark',
      'makeBuilt',
      'isText',
      'isObject',
      'parseVersion',
      'mustParse',
      'compareSemver',
      'sinceIssue',
      'findRows',
      'applyEdits',
      'splitSpec',
      'loadInstalledIndex',
      'installedVersion',
      'loadInstalledJson',
      'assertIndex',
      'factRows',
    ]
    for (const name of functions) expect(named.get(name), name).toBe('function')
    expect(named.get('BUILDER')).toBe('symbol')
    expect(named.get('Row')).toBe('type')
    expect(named.get('InstalledJson')).toBe('type')
    const json = exports.find((e) => e.name === 'loadInstalledJson')?.summary ?? ''
    expect(json).toContain('not-found')
    expect(json).toContain('not-an-index')
    expect(json).toContain('does not check what is in it')
    expect(named.has('assertIndexFormat')).toBe(false)
    expect(Object.keys(read('fact-kit.module-api').kinds)).toEqual(['function', 'symbol', 'constant', 'type'])
    expect(content('fact-kit.module-api').kinds).toEqual(read('fact-kit.module-api').kinds)
    // The kinds follow the source: BUILDER is a symbol, Row is an interface, the rest are functions.
    expect(readFileSync(join(kitSrc, 'markers.ts'), 'utf8')).toMatch(/export const BUILDER = Symbol\./)
    expect(readFileSync(join(kitSrc, 'select.ts'), 'utf8')).toMatch(/export interface Row\b/)
  })

  it('sets the keys pin skips with dataKeys, and takes the default from rows.ts', () => {
    const d = read('fact-kit.row-data-keys')
    const source = readFileSync(join(kitSrc, 'rows.ts'), 'utf8')
    const keys = [...(/const DATA_KEYS = new Set\(\[([^\]]*)\]/.exec(source)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(
      (m) => m[1],
    )
    expect(keys.length).toBeGreaterThan(0)
    expect(d.defaultKeys).toEqual(keys)
    expect(d.setting).toBe('dataKeys')
    expect(d.readBy).toEqual(['pin', 'merge-since'])
    // The setting is a property of the config file, in the row that `fact-kit.config-file` plans for this release.
    expect(read('fact-kit.config-file').properties.dataKeys).toMatchObject({ type: 'array' })
  })

  it('registers a reference extractor for impactOf, in a package with or without aggregate', () => {
    const e = read('fact-kit.impact-extractors')
    expect(e.register.signature).toContain('registerImpactExtractor(extractor: ImpactExtractor)')
    expect(Object.keys(e.extractor.fields)).toEqual(['name', 'extensions', 'extract'])
    expect(e.scope).toContain('aggregate or not')
    expect(e.options.extractors).toBeDefined()
    const exports = (read('fact-kit.module-api').exports as { name: string; kind?: string }[]).map((x) => x.name)
    expect(exports).toEqual(expect.arrayContaining(['registerImpactExtractor', 'ImpactExtractor']))
  })

  it('says build reads factsDir of the config file, and --facts-dir wins', () => {
    expect(read('fact-kit.cli').build.factsDir).toContain('--facts-dir')
    expect(read('fact-kit.cli').build.factsDir).toContain('`factsDir`')
    expect(content('fact-kit.cli').build.factsDir).toContain('--facts-dir')
    expect(read('fact-kit.config-file').properties.factsDir.description).toContain('`build`')
  })
})

// How the code works today, written as facts that start at the version where the behavior was already there (0.7.0,
// the first stable release; the same code is in 0.7.0-alpha.1). They have no pending label.
describe('current behavior of check, pin and merge-since', () => {
  const input = content('fact-kit.input-files')
  const sinceOf = (id: string) => {
    const f = specIndex.facts.find((x) => x.id === id)
    return f?.when?.since ?? f?.variants?.[0]?.since
  }

  it('starts at 0.7.0 and has no pending row', () => {
    for (const id of [
      'fact-kit.input-files',
      'fact-kit.check-index-input',
      'fact-kit.check-id-table',
      'fact-kit.impl-rules-basis',
    ]) {
      expect(sinceOf(id), id).toBe('0.7.0')
      const f = specIndex.facts.find((x) => x.id === id)
      expect(
        (f?.variants ?? []).filter((v) => v.pending !== undefined),
        id,
      ).toHaveLength(0)
      expect(
        selectFacts(specIndex, { version: '0.7.0' }).map((x) => x.id),
        id,
      ).toContain(id)
    }
  })

  it('reads <dir>/index.json for check --index, and takes the option more than once', async () => {
    const index = content('fact-kit.check-index-input')
    expect(index.reads).toContain('<dir>/index.json')
    expect(index.repeatable).toContain('any number of times')
    expect(index.unreadable).toContain('exits with 2')
    const dir = makeTmp('input-index')
    writeTree(dir, { 'built/index.json': { nothing: true }, 'elsewhere/other.json': { nothing: true } })
    const bad = await cli(['check', '--cwd', dir, '--index', 'built', '--json'])
    expect(bad.code).toBe(1)
    const missing = await cli(['check', '--cwd', dir, '--index', 'elsewhere', '--json'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain(join('elsewhere', 'index.json'))
    // Both paths are read: the one that fails to parse decides the exit code.
    writeTree(dir, { 'good/index.json': demoIndex })
    expect((await cli(['check', '--cwd', dir, '--index', 'good', '--index', 'elsewhere'])).code).toBe(2)
    expect((await cli(['check', '--cwd', dir, '--index', 'good', '--json'])).code).toBe(0)
  })

  it('keeps one id table for the sources and every --index, and reports the later copy as duplicate-id', async () => {
    const table = content('fact-kit.check-id-table')
    expect(table.duplicate).toContain('`duplicate-id`')
    expect(table.sourceAndBuild).toContain('reports every fact')
    expect(table.twoIndexes).toContain('same id')
    const dir = makeTmp('input-ids')
    writeTree(dir, { 'good/index.json': demoIndex })
    const twice = await cli(['check', '--cwd', dir, '--index', 'good', '--index', 'good', '--json'])
    expect(twice.code).toBe(1)
    expect(JSON.parse(twice.stdout).problems.map((p: { code: string }) => p.code)).toEqual(['duplicate-id'])
    const own = makeTmp('input-ids-source')
    writeTree(own, {
      'package.json': { name: 'demo-facts', type: 'module' },
      'facts/demo/index.ts': `export default { describes: {}, facts: [${JSON.stringify(demoIndex.facts[0])}] }\n`,
    })
    expect((await cli(['build', '--cwd', own, '--write-exports'])).code).toBe(0)
    expect((await cli(['check', '--cwd', own, '--json'])).code).toBe(0)
    const both = await cli(['check', '--cwd', own, '--index', 'dist/demo', '--json'])
    expect(both.code).toBe(1)
    expect(JSON.parse(both.stdout).problems.map((p: { code: string }) => p.code)).toEqual(['duplicate-id'])
  })

  it('pins the code under factsDir except _lib', async () => {
    expect(input.pin.reads).toContain('except `<facts-dir>/_lib`')
    const dir = makeTmp('input-pin')
    const code = "export default [{ id: 'x.a', since: 'next' }]\n"
    writeTree(dir, { 'facts/e/index.ts': code, 'facts/_lib/rows.ts': code })
    expect((await cli(['pin', '--version', '1.0.0', '--cwd', dir])).code).toBe(0)
    expect(readFileSync(join(dir, 'facts/e/index.ts'), 'utf8')).toContain("since: '1.0.0'")
    expect(readFileSync(join(dir, 'facts/_lib/rows.ts'), 'utf8')).toBe(code)
  })

  it('says merge-since settles the unmerged files and the changed code files without .d.ts', () => {
    const m = input['merge-since']
    expect(m.unmerged).toContain('git diff --name-only --diff-filter=U')
    expect(m.unmerged).toContain('under `--cwd`')
    expect(m.changed).toContain('.d.ts')
    expect(m.changed).toContain('differ from our side')
    expect(m.not).toContain('every code file')
  })

  it('names the basis of the two impl rules, and the target suffix only from 0.11.0', () => {
    const basis = content('fact-kit.impl-rules-basis')
    expect(basis['impl-imports-facts'].basis).toContain('ends in `-facts`')
    expect(basis['impl-imports-facts'].basis).toContain('publish target suffix')
    expect(basis['impl-reads-facts-dist'].basis).toContain('facts/dist')
    const old = selectFacts(specIndex, { version: '0.10.0' }).find((f) => f.id === 'fact-kit.impl-rules-basis')
    const before = (old?.content as any).value['impl-imports-facts'].basis
    expect(before).toContain('ends in `-facts`')
    expect(before).not.toContain('publish target suffix')
  })
})
