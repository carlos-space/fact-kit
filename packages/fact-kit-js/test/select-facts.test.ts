import { afterEach, describe, expect, test } from 'vitest'
import { FactReadError, readFacts, selectFacts } from '../src/index.ts'
import type { FactIndex, FactVariant, Since } from '../src/index.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const published = { kind: 'published' } as const
const base = (id: string) => ({ id, tool: 'demo', topics: ['t'], title: id, source: published })
const value = (v: unknown) => ({ value: v })

/** A fact with rows. The top-level content is what a reader of format 1.0 sees. */
const rows = (id: string, variants: FactVariant[]) => ({
  ...base(id),
  content: variants[0]?.content ?? value(0),
  variants,
})
const plain = (id: string, v: unknown, since?: Since) => ({
  ...base(id),
  content: value(v),
  ...(since !== undefined ? { when: { since } } : {}),
})
const index = (facts: unknown[], extra: Record<string, unknown> = {}): FactIndex =>
  ({
    indexFormat: '1.1',
    package: 'demo-facts',
    entry: 'sdk',
    describes: { demo: '0.50.0' },
    facts,
    ...extra,
  }) as FactIndex

const ids = (facts: { id: string }[]) => facts.map((f) => f.id)
const contentOf = (facts: { id: string; content: unknown }[], id: string) =>
  (facts.find((f) => f.id === id)?.content as { value?: unknown } | undefined)?.value

describe('c003 selectFacts: version', () => {
  const idx = index([
    plain('demo.old', 'old', '0.40.0'),
    plain('demo.new', 'new', '0.49.0'),
    plain('demo.always', 'always'),
    plain('demo.next', 'next', 'next'),
    rows('demo.limit', [
      { since: '0.40.0', content: value(10) },
      { since: '0.49.0', content: value(20) },
    ]),
  ])

  test('a version below since does not read the row, a version at or above does', () => {
    expect(ids(selectFacts(idx, { version: '0.48.0' }))).toEqual(['demo.old', 'demo.always', 'demo.limit'])
    expect(contentOf(selectFacts(idx, { version: '0.48.0' }), 'demo.limit')).toBe(10)
    expect(ids(selectFacts(idx, { version: '0.49.0' }))).toEqual(['demo.old', 'demo.new', 'demo.always', 'demo.limit'])
    expect(contentOf(selectFacts(idx, { version: '0.49.0' }), 'demo.limit')).toBe(20)
    expect(contentOf(selectFacts(idx, { version: '0.49.0-alpha.1' }), 'demo.limit')).toBe(10)
  })

  test('head reads next, a released version does not, and the default reads the latest published', () => {
    expect(ids(selectFacts(idx, { version: 'head' }))).toContain('demo.next')
    expect(ids(selectFacts(idx, { version: '9.9.9' }))).not.toContain('demo.next')
    const latest = selectFacts(idx)
    expect(ids(latest)).toEqual(['demo.old', 'demo.new', 'demo.always', 'demo.limit'])
    expect(contentOf(latest, 'demo.limit')).toBe(20)
  })

  test('the chosen row reports its since, and a row without one reports 0.0.0', () => {
    const got = selectFacts(idx, { version: '0.48.0' })
    expect(got.find((f) => f.id === 'demo.limit')?.since).toBe('0.40.0')
    expect(got.find((f) => f.id === 'demo.always')?.since).toBe('0.0.0')
  })

  test('removeIn hides the fact from a reader that has reached it', () => {
    const gone = index([{ ...plain('demo.gone', 1, '0.1.0'), when: { since: '0.1.0', removeIn: '0.30.0' } }])
    expect(ids(selectFacts(gone, { version: '0.29.9' }))).toEqual(['demo.gone'])
    expect(ids(selectFacts(gone, { version: '0.30.0' }))).toEqual([])
    expect(ids(selectFacts(gone, { version: 'head' }))).toEqual([])
    // The latest published row is 0.1.0, below removeIn, so the default still reads it.
    expect(ids(selectFacts(gone))).toEqual(['demo.gone'])
  })

  test('a version that is not semver throws invalid-version, in the query and in the index', () => {
    for (const version of ['', '1.0', 'v1.0.0', 'latest', '01.0.0']) {
      expect(() => selectFacts(idx, { version }), version).toThrow(FactReadError)
    }
    try {
      selectFacts(idx, { version: '1.0' })
    } catch (error) {
      expect((error as FactReadError).code).toBe('invalid-version')
    }
    expect(() => selectFacts(index([plain('demo.bad', 1, 'soon')]))).toThrow(/invalid-version/)
  })
})

describe('c003 selectFacts: include', () => {
  const idx = index([
    rows('demo.plan', [
      { since: '0.40.0', content: value('released') },
      { since: 'next', content: value('planned x'), pending: 'x' },
      { since: 'next', content: value('planned y'), pending: 'y' },
    ]),
    rows('demo.only-pending', [{ since: 'next', content: value('p'), pending: 'x' }]),
  ])

  test('head with the label reads the pending row, without it or on a version it does not', () => {
    expect(contentOf(selectFacts(idx, { version: 'head', include: ['x'] }), 'demo.plan')).toBe('planned x')
    expect(contentOf(selectFacts(idx, { version: 'head', include: ['y'] }), 'demo.plan')).toBe('planned y')
    expect(contentOf(selectFacts(idx, { version: 'head' }), 'demo.plan')).toBe('released')
    expect(contentOf(selectFacts(idx, { version: 'head', include: ['z'] }), 'demo.plan')).toBe('released')
    expect(contentOf(selectFacts(idx, { include: ['x'] }), 'demo.plan')).toBe('released')
    expect(contentOf(selectFacts(idx, { version: '9.0.0', include: ['x'] }), 'demo.plan')).toBe('released')
  })

  test('a fact with only a pending row appears only for that label', () => {
    expect(ids(selectFacts(idx, { version: 'head', include: ['x'] }))).toContain('demo.only-pending')
    expect(ids(selectFacts(idx, { version: 'head' }))).not.toContain('demo.only-pending')
    expect(ids(selectFacts(idx, { include: ['x'] }))).not.toContain('demo.only-pending')
  })
})

describe('c003 selectFacts: platform and os', () => {
  const idx = index([
    rows('demo.hook', [
      { since: '0.40.0', content: value('any') },
      { since: '0.40.0', content: value('claude'), platforms: ['claude-code'] },
      { since: '0.40.0', content: value('claude mac'), platforms: ['claude-code'], os: ['macos'] },
    ]),
    rows('demo.claude-only', [{ since: '0.40.0', content: value('c'), platforms: ['claude-code'] }]),
    rows('demo.linux-only', [{ since: '0.40.0', content: value('l'), os: ['linux'] }]),
  ])

  test('a row for claude-code is not read on codex and not read without a platform', () => {
    const codex = selectFacts(idx, { platform: 'codex' })
    expect(ids(codex)).toEqual(['demo.hook'])
    expect(contentOf(codex, 'demo.hook')).toBe('any')
    expect(ids(selectFacts(idx, { platform: 'claude-code' }))).toEqual(['demo.hook', 'demo.claude-only'])
    expect(ids(selectFacts(idx))).toEqual(['demo.hook'])
  })

  test('the more specific condition wins on the same bound', () => {
    expect(contentOf(selectFacts(idx, {}), 'demo.hook')).toBe('any')
    expect(contentOf(selectFacts(idx, { platform: 'claude-code' }), 'demo.hook')).toBe('claude')
    expect(contentOf(selectFacts(idx, { platform: 'claude-code', os: 'macos' }), 'demo.hook')).toBe('claude mac')
    expect(contentOf(selectFacts(idx, { platform: 'claude-code', os: 'linux' }), 'demo.hook')).toBe('claude')
    expect(contentOf(selectFacts(idx, { platform: 'codex', os: 'macos' }), 'demo.hook')).toBe('any')
  })

  test('os conditions are read the same way', () => {
    expect(ids(selectFacts(idx, { os: 'linux' }))).toEqual(['demo.hook', 'demo.linux-only'])
    expect(ids(selectFacts(idx, { os: 'windows' }))).toEqual(['demo.hook'])
  })

  test('a later bound beats a more specific condition, whatever the order of the rows', () => {
    const a: FactVariant = { since: '0.40.0', content: value('old, specific'), platforms: ['codex'] }
    const b: FactVariant = { since: '0.45.0', content: value('new, generic') }
    for (const list of [
      [a, b],
      [b, a],
    ]) {
      expect(contentOf(selectFacts(index([rows('demo.x', list)]), { platform: 'codex' }), 'demo.x')).toBe(
        'new, generic',
      )
    }
  })
})

describe('c003 selectFacts: stability and unknown fields', () => {
  test('experimental rows are read by default and carry the mark', () => {
    const idx = index([
      rows('demo.exp', [{ since: '0.40.0', content: value(1), stability: 'experimental' }]),
      plain('demo.ok', 2),
    ])
    const got = selectFacts(idx)
    expect(got.find((f) => f.id === 'demo.exp')?.stability).toBe('experimental')
    expect('stability' in (got.find((f) => f.id === 'demo.ok') ?? {})).toBe(false)
  })

  test('a flattened fact has no variants, and fields the reader does not know pass through', () => {
    const idx = index([{ ...rows('demo.f', [{ since: '0.1.0', content: value(1) }]), future: { a: 1 } }], {
      added: true,
    })
    const [fact] = selectFacts(idx)
    expect(fact && 'variants' in fact).toBe(false)
    expect((fact as unknown as { future: unknown }).future).toEqual({ a: 1 })
  })
})

describe('c003 selectFacts: index format', () => {
  test('a missing indexFormat reads as 1.0, any 1.x is read, another major throws', () => {
    const { indexFormat: _drop, ...v10 } = index([plain('demo.a', 1)])
    expect(ids(selectFacts(v10 as FactIndex))).toEqual(['demo.a'])
    expect(ids(selectFacts(index([plain('demo.a', 1)], { indexFormat: '1.7' })))).toEqual(['demo.a'])
    for (const format of ['2.0', '0.9', 'x', 1]) {
      expect(() => selectFacts(index([], { indexFormat: format })), String(format)).toThrow(/unsupported-index-format/)
    }
  })

  test('something that is not an index throws not-an-index', () => {
    for (const bad of [null, 3, 'x', [], {}, { facts: [] }, { package: 'p', facts: 'no' }]) {
      expect(() => selectFacts(bad as never), JSON.stringify(bad)).toThrow(/not-an-index/)
    }
  })
})

describe('c003 readFacts: version default and onRead', () => {
  const fixture = (root: string, describes: Record<string, string>, installed?: string) => {
    writeTree(root, {
      'package.json': { name: 'hub', private: true },
      'node_modules/demo-facts/package.json': {
        name: 'demo-facts',
        version: '3.0.0',
        exports: { './sdk/index.json': './index.json', '.': './top.json' },
      },
      'node_modules/demo-facts/index.json': index(
        [
          plain('demo.old', 'old', '0.40.0'),
          plain('demo.new', 'new', '0.49.0'),
          plain('demo.next', 'next', 'next'),
          rows('demo.plan', [
            { since: '0.40.0', content: value('released') },
            { since: 'next', content: value('planned x'), pending: 'x' },
          ]),
          rows('demo.hook', [{ since: '0.40.0', content: value('c'), platforms: ['claude-code'] }]),
        ],
        { describes },
      ),
      ...(installed ? { 'node_modules/demo/package.json': { name: 'demo', version: installed } } : {}),
    })
  }
  const read = (root: string, options = {}) => readFacts('demo-facts/sdk', { root, ...options })

  test('version: an old version does not read a newer row, head and include read pending rows', () => {
    const root = makeTmp('read-version')
    fixture(root, { demo: '0.50.0' })
    expect(ids(read(root, { version: '0.48.0' }).facts)).toEqual(['demo.old', 'demo.plan'])
    expect(ids(read(root, { version: '0.49.0' }).facts)).toEqual(['demo.old', 'demo.new', 'demo.plan'])
    expect(read(root, { version: 'head', include: ['x'] }).value('demo.plan')).toBe('planned x')
    expect(read(root, { version: 'head' }).value('demo.plan')).toBe('released')
    expect(() => read(root, { version: 'nope' })).toThrow(/invalid-version/)
  })

  test('platform and os are passed on', () => {
    const root = makeTmp('read-platform')
    fixture(root, { demo: '0.50.0' })
    expect(read(root).has('demo.hook')).toBe(false)
    expect(read(root, { platform: 'codex' }).has('demo.hook')).toBe(false)
    expect(read(root, { platform: 'claude-code' }).has('demo.hook')).toBe(true)
  })

  test('without version, an installed product older than describes reads the older rows', () => {
    const root = makeTmp('read-default-older')
    fixture(root, { demo: '0.50.0' }, '0.48.0')
    expect(ids(read(root).facts)).toEqual(['demo.old', 'demo.plan'])
    // An explicit version wins over the installed one.
    expect(ids(read(root, { version: '0.49.0' }).facts)).toEqual(['demo.old', 'demo.new', 'demo.plan'])
  })

  test('without version, an installed product equal to describes reads its rows', () => {
    const root = makeTmp('read-default-equal')
    fixture(root, { demo: '0.50.0' }, '0.50.0')
    expect(ids(read(root).facts)).toEqual(['demo.old', 'demo.new', 'demo.plan'])
  })

  test('without version, an installed product newer than describes throws, and an explicit version does not', () => {
    const root = makeTmp('read-default-newer')
    fixture(root, { demo: '0.50.0' }, '0.51.0')
    expect(() => read(root)).toThrow('describes demo 0.50.0, but')
    expect(() => read(root)).toThrow('has demo 0.51.0')
    expect(ids(read(root, { version: '0.51.0' }).facts)).toEqual(['demo.old', 'demo.new', 'demo.plan'])
  })

  test('without version and without the product installed, the latest published rows are read', () => {
    const root = makeTmp('read-default-none')
    fixture(root, {})
    expect(ids(read(root).facts)).toEqual(['demo.old', 'demo.new', 'demo.plan'])
  })

  test('onRead is called once per get, once per found has, not for an id filter, once per field read', () => {
    const root = makeTmp('read-onread')
    fixture(root, { demo: '0.50.0' })
    const calls: unknown[] = []
    const reader = read(root, { onRead: (r: unknown) => calls.push(r) })

    reader.get('demo.old')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ package: 'demo-facts', version: '3.0.0', entry: 'sdk', id: 'demo.old', since: '0.40.0' })

    reader.has('demo.new')
    expect(calls).toHaveLength(2)
    expect(reader.has('demo.missing')).toBe(false)
    expect(calls).toHaveLength(2)

    const picked = reader.facts.filter((f) => f.id.startsWith('demo.p')).map((f) => f.id)
    expect(picked).toEqual(['demo.plan'])
    expect(calls).toHaveLength(2)

    const first = reader.facts[0]
    expect(first?.title).toBe('demo.old')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ id: 'demo.old', entry: 'sdk' })

    reader.value('demo.plan')
    expect(calls).toHaveLength(4)
  })

  test('the since reported to onRead is the chosen row, and an array is passed as written', () => {
    const root = makeTmp('read-onread-since')
    writeTree(root, {
      'package.json': { name: 'hub', private: true },
      'node_modules/demo-facts/package.json': {
        name: 'demo-facts',
        version: '1.0.0',
        exports: { './index.json': './index.json' },
      },
      'node_modules/demo-facts/index.json': index([plain('demo.a', 1, ['0.48.1', '0.49.1'])], { describes: {} }),
    })
    const calls: { since: Since }[] = []
    readFacts('demo-facts', { root, onRead: (r) => calls.push(r) }).get('demo.a')
    expect(calls.map((c) => c.since)).toEqual([['0.48.1', '0.49.1']])
  })

  test('readFacts without onRead returns plain elements, and the reader has the documented members', () => {
    const root = makeTmp('read-members')
    fixture(root, { demo: '0.50.0' })
    const reader = read(root)
    expect(Object.keys(reader).sort()).toEqual([
      'describes',
      'entry',
      'facts',
      'get',
      'has',
      'package',
      'publish',
      'value',
      'version',
    ])
  })

  test('a spec with only the package reads <package>/index.json', () => {
    const install = (root: string, exports: Record<string, string>) =>
      writeTree(root, {
        'package.json': { name: 'hub', private: true },
        'node_modules/demo-facts/package.json': { name: 'demo-facts', version: '1.0.0', exports },
        'node_modules/demo-facts/top.json': index([plain('demo.a', 1)], { describes: {} }),
      })
    const withIndex = makeTmp('read-package-only')
    install(withIndex, { './index.json': './top.json' })
    expect(readFacts('demo-facts', { root: withIndex }).value('demo.a')).toBe(1)
    const without = makeTmp('read-package-only-missing')
    install(without, { './sdk/index.json': './top.json' })
    expect(() => readFacts('demo-facts', { root: without })).toThrow(/not-found/)
  })
})
