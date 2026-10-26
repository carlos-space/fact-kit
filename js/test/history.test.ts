import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { HistoryError, buildFacts, history, keyed } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const edge = (from: string, to: string, extra: object = {}) => ({ from, to, ...extra })
const valueOf = (variants: ReturnType<typeof history>, i: number): any =>
  (variants[i]?.content as { value: unknown }).value
const failure = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(HistoryError)
    return (error as Error).message
  }
  throw new Error('expected history to throw')
}

describe('c001 history: add', () => {
  const base = { transitions: keyed([edge('draft', 'active')], ['from', 'to']) }

  test('appends items to a keyed array', () => {
    const v = history(
      { since: '0.1.0', value: base },
      { since: '0.2.0', add: { '/transitions': [edge('active', 'done')] } },
    )
    expect(v.map((r) => r.since)).toEqual(['0.1.0', '0.2.0'])
    expect(valueOf(v, 0).transitions).toEqual([edge('draft', 'active')])
    expect(valueOf(v, 1).transitions).toEqual([edge('draft', 'active'), edge('active', 'done')])
  })

  test('works on a keyed array at the root, written as an empty pointer', () => {
    const v = history({ since: '1.0.0', value: keyed(['a', 'b']) }, { since: '1.1.0', add: { '': ['c'] } })
    expect(valueOf(v, 1)).toEqual(['a', 'b', 'c'])
  })

  test('fails and prints the key when an item with that key is already there', () => {
    const message = failure(() =>
      history({ since: '0.1.0', value: base }, { since: '0.2.0', add: { '/transitions': [edge('draft', 'active')] } }),
    )
    expect(message).toContain('["draft","active"]')
    expect(message).toContain('already there')
  })

  test('fails on an array that was not declared with keyed', () => {
    const message = failure(() =>
      history({ since: '0.1.0', value: { list: ['a'] } }, { since: '0.2.0', add: { '/list': ['b'] } }),
    )
    expect(message).toContain('not keyed')
    expect(message).toContain('"/list"')
  })
})

describe('c001 history: replace', () => {
  const base = {
    transitions: keyed([edge('draft', 'active', { guard: 'a' }), edge('active', 'done')], ['from', 'to']),
    limits: { max: 10 },
    names: ['x'],
  }

  test('swaps items of a keyed array by key, and a plain value or array whole', () => {
    const v = history(
      { since: '1.0.0', value: base },
      {
        since: '1.1.0',
        replace: { '/transitions': [edge('draft', 'active', { guard: 'b' })], '/limits/max': 20, '/names': ['y', 'z'] },
      },
    )
    expect(valueOf(v, 1).transitions).toEqual([edge('draft', 'active', { guard: 'b' }), edge('active', 'done')])
    expect(valueOf(v, 1).limits).toEqual({ max: 20 })
    expect(valueOf(v, 1).names).toEqual(['y', 'z'])
    // The earlier row is not touched.
    expect(valueOf(v, 0).transitions[0].guard).toBe('a')
    expect(valueOf(v, 0).names).toEqual(['x'])
  })

  test('fails and prints the key that matches no item', () => {
    const message = failure(() =>
      history(
        { since: '1.0.0', value: base },
        { since: '1.1.0', replace: { '/transitions': [edge('draft', 'done')] } },
      ),
    )
    expect(message).toContain('no item has the key ["draft","done"]')
    expect(message).toContain('["draft","active"]')
  })

  test('fails when there is nothing at the pointer', () => {
    const message = failure(() =>
      history({ since: '1.0.0', value: base }, { since: '1.1.0', replace: { '/limits/min': 1 } }),
    )
    expect(message).toContain('replace "/limits/min": nothing is there to replace')
  })
})

describe('c001 history: remove', () => {
  const base = {
    transitions: keyed([edge('draft', 'active'), edge('active', 'done')], ['from', 'to']),
    flags: keyed([{ name: 'a' }, { name: 'b' }], ['name']),
  }

  test('drops items by key: an array of values for several fields, the value itself for one', () => {
    const v = history(
      { since: '1.0.0', value: base },
      { since: '1.1.0', remove: { '/transitions': [['draft', 'active']], '/flags': ['b'] } },
    )
    expect(valueOf(v, 1).transitions).toEqual([edge('active', 'done')])
    expect(valueOf(v, 1).flags).toEqual([{ name: 'a' }])
  })

  test('fails and prints the key that matches no item', () => {
    const message = failure(() =>
      history({ since: '1.0.0', value: base }, { since: '1.1.0', remove: { '/transitions': [['done', 'draft']] } }),
    )
    expect(message).toContain('no item has the key ["done","draft"]')
  })

  test('fails when a key does not have one value per key field', () => {
    const message = failure(() =>
      history({ since: '1.0.0', value: base }, { since: '1.1.0', remove: { '/transitions': ['draft'] } }),
    )
    expect(message).toContain('array of 2 values')
  })

  test('fails on an array that was not declared with keyed', () => {
    const message = failure(() =>
      history({ since: '1.0.0', value: { list: ['a'] } }, { since: '1.1.0', remove: { '/list': ['a'] } }),
    )
    expect(message).toContain('not keyed')
  })
})

describe('c001 history: set', () => {
  test('puts a value at a pointer, new members included, and escapes ~0 and ~1', () => {
    const v = history(
      { since: '1.0.0', value: { limits: { max: 1 }, 'a/b': 1, 'c~d': 1 } },
      { since: '1.1.0', set: { '/limits/max': 40, '/limits/min': 2, '/a~1b': 2, '/c~0d': 3 } },
    )
    expect(valueOf(v, 1)).toEqual({ limits: { max: 40, min: 2 }, 'a/b': 2, 'c~d': 3 })
  })

  test('fails when the parent is not there', () => {
    const message = failure(() =>
      history({ since: '1.0.0', value: { a: 1 } }, { since: '1.1.0', set: { '/missing/x': 1 } }),
    )
    expect(message).toContain('set "/missing/x": "/missing/x" has no parent')
  })

  test('fails on a pointer that is not one', () => {
    expect(failure(() => history({ since: '1', value: {} }, { since: '2', set: { 'a/b': 1 } }))).toContain(
      'is not a JSON Pointer',
    )
  })
})

describe('c001 history: order and rows', () => {
  const base = {
    list: keyed(
      [
        { id: 'a', n: 1 },
        { id: 'b', n: 1 },
      ],
      ['id'],
    ),
    note: 'old',
  }

  test('applies remove, replace, add and set in that order', () => {
    // remove runs before add: the same key can leave and come back in one row.
    const back = history(
      { since: '1.0.0', value: base },
      { since: '1.1.0', add: { '/list': [{ id: 'a', n: 2 }] }, remove: { '/list': ['a'] } },
    )
    expect(valueOf(back, 1).list).toEqual([
      { id: 'b', n: 1 },
      { id: 'a', n: 2 },
    ])
    // replace runs before add: it can not see the item that add brings in.
    expect(
      failure(() =>
        history(
          { since: '1.0.0', value: base },
          { since: '1.1.0', add: { '/list': [{ id: 'c', n: 1 }] }, replace: { '/list': [{ id: 'c', n: 2 }] } },
        ),
      ),
    ).toContain('no item has the key "c"')
    // set runs last: it can reach into the item that add appended.
    const last = history(
      { since: '1.0.0', value: base },
      { since: '1.1.0', set: { '/list/2/n': 9 }, add: { '/list': [{ id: 'c', n: 1 }] } },
    )
    expect(valueOf(last, 1).list[2]).toEqual({ id: 'c', n: 9 })
    // All four in one row.
    const all = history(
      { since: '1.0.0', value: base },
      {
        since: '1.1.0',
        set: { '/note': 'new' },
        add: { '/list': [{ id: 'c', n: 3 }] },
        replace: { '/list': [{ id: 'b', n: 5 }] },
        remove: { '/list': ['a'] },
      },
    )
    expect(valueOf(all, 1)).toEqual({
      list: [
        { id: 'b', n: 5 },
        { id: 'c', n: 3 },
      ],
      note: 'new',
    })
  })

  test('takes schema and statement content, a full rewrite, and the conditions of a row', () => {
    const v = history(
      { since: '1.0.0', schema: { type: 'object', properties: { a: { type: 'string' } } } },
      { since: '1.1.0', set: { '/properties/b': { type: 'number' } }, stability: 'experimental', os: ['macos'] },
      { since: '1.2.0', pending: 'x', statement: { en: 'rewritten' } },
      { since: '1.3.0', set: { '/en': 'fixed' }, platforms: ['codex'] },
    )
    expect(v[0]?.content).toEqual({ schema: { type: 'object', properties: { a: { type: 'string' } } } })
    expect(v[1]).toMatchObject({ stability: 'experimental', os: ['macos'] })
    expect((v[1]?.content as any).schema.properties).toEqual({ a: { type: 'string' }, b: { type: 'number' } })
    expect(v[2]).toEqual({ since: '1.2.0', content: { statement: { en: 'rewritten' } }, pending: 'x' })
    expect(v[3]).toMatchObject({ platforms: ['codex'], content: { statement: { en: 'fixed' } } })
  })

  test('rejects rows that do not make sense', () => {
    expect(failure(() => history())).toContain('at least one row')
    expect(failure(() => history({ since: '1', add: { '': [] } }))).toContain('the first row gives the content')
    expect(failure(() => history({ since: '1', value: 1 }, { since: '2', value: 2, set: { '': 3 } }))).toContain(
      'rewrites the content has no set',
    )
    expect(failure(() => history({ since: '1', value: 1, schema: {} }))).toContain('not value and schema')
    expect(failure(() => history({ since: '1', value: 1 }, { since: '2', nope: 1 } as never))).toContain(
      'unknown field "nope"',
    )
    expect(failure(() => history({ value: 1 } as never))).toContain('missing "since"')
  })

  test('keyed rejects two items with one key', () => {
    expect(failure(() => keyed([edge('a', 'b'), edge('a', 'b')], ['from', 'to']))).toContain('["a","b"]')
    expect(failure(() => keyed([{ from: 'a' }], ['from', 'to']))).toContain('has no field "to"')
  })
})

describe('c001 history in a built package', () => {
  const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
  const module = (rows: string) =>
    [
      `import { history, keyed } from '${src}'`,
      'export default {',
      "  describes: { demo: '1.2.0' },",
      '  facts: [{',
      "    id: 'demo.flow', tool: 'demo', topics: ['flow'], title: 'Flow', source: { kind: 'published' },",
      `    variants: history(${rows}),`,
      '  }],',
      '}',
      '',
    ].join('\n')
  const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }

  test('expands into variants, and the index keeps the latest published row as content', async () => {
    const dir = makeTmp('history-build')
    writeTree(dir, {
      'package.json': pkg,
      'facts/flow/index.ts': module(
        [
          "{ since: '1.0.0', value: { edges: keyed([{ from: 'a', to: 'b' }], ['from', 'to']) } }",
          "{ since: '1.1.0', add: { '/edges': [{ from: 'b', to: 'c' }] } }",
          "{ since: 'next', remove: { '/edges': [['a', 'b']] } }",
        ].join(',\n'),
      ),
    })
    const result = await buildFacts({ cwd: dir, writeExports: true })
    expect(result.problems).toEqual([])
    const fact = JSON.parse(readFileSync(join(dir, 'dist/flow/index.json'), 'utf8')).facts[0]
    expect(fact.variants.map((v: any) => [v.since, v.content.value.edges.length])).toEqual([
      ['1.0.0', 1],
      ['1.1.0', 2],
      ['next', 1],
    ])
    expect(fact.content.value.edges).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])
  })

  test('a row that does not fit stops the build and the CLI prints the key', async () => {
    const dir = makeTmp('history-build-bad')
    writeTree(dir, {
      'package.json': pkg,
      'facts/flow/index.ts': module(
        [
          "{ since: '1.0.0', value: { edges: keyed([{ from: 'a', to: 'b' }], ['from', 'to']) } }",
          "{ since: '1.1.0', remove: { '/edges': [['x', 'y']] } }",
        ].join(',\n'),
      ),
    })
    const build = await cli(['build', '--cwd', dir])
    expect(build.code).toBe(1)
    expect(build.stderr).toContain('["x","y"]')
    const check = await cli(['check', '--cwd', dir, '--json'])
    expect(check.code).toBe(1)
    expect(JSON.parse(check.stdout).problems[0]).toMatchObject({ code: 'history' })
    expect(JSON.parse(check.stdout).problems[0].message).toContain('["x","y"]')
  })
})
