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
      'describes',
      'facts',
      'formatVersion',
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

  it('names functions fact-kit exports', () => {
    const missing = api.exports
      .map((e: { name: string }) => e.name)
      .filter((name: string) => typeof (kitModule as Record<string, unknown>)[name] !== 'function')
    expect(missing).toEqual([])
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
    const old = namesAt('0.7.0')
    expect(old.filter((name) => added.includes(name))).toEqual([])
    expect(head.filter((name: string) => !added.includes(name))).toEqual(old)
    // A reader that names no version gets the latest published rows, which are those of 0.8.0.
    expect(namesAt()).toEqual(head)
  })

  it('names each export once and writes the new history signature', () => {
    const head: string[] = api.exports.map((e: { name: string }) => e.name)
    expect(new Set(head).size).toBe(head.length)
    expect(api.exports.find((e: { name: string }) => e.name === 'history').signature).toContain('HistoryVariants')
  })

  it('keeps one 0.8.0 row for each fact that changed, and next rows only for the publish change', () => {
    for (const fact of specIndex.facts) {
      const rows = (fact.variants ?? []).filter((v) => v.since === '0.8.0')
      expect(rows.length, fact.id).toBeLessThanOrEqual(1)
      // Only the `publish` change (index 1.2) is not released yet.
      expect((fact.variants ?? []).filter((v) => v.since === 'next').length, fact.id).toBe(
        ['fact-kit.index', 'fact-kit.entry-module', 'fact-kit.read-facts'].includes(fact.id) ? 1 : 0,
      )
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
