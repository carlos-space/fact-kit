import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BuilderError,
  buildFacts,
  contentOf,
  factsOf,
  history,
  keyed,
  observedDoc,
  observedSpike,
  statementFrom,
  subsetOf,
} from '../src/index.ts'
import { BUILDER, registerBuilderCheck, setMark } from '../src/markers.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const doc = observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' })
const mf = factsOf({ tool: 'demo', source: doc, topics: ['t0'] })
const failure = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BuilderError)
    return (error as Error).message
  }
  throw new Error('expected a BuilderError')
}

describe('c002 observedDoc and observedSpike', () => {
  test('write the source in the key order of the index', () => {
    expect(Object.entries(doc)).toEqual([
      ['kind', 'observed'],
      ['basis', 'doc'],
      ['url', 'https://example.com/doc'],
      ['fetched', '2026-10-01'],
    ])
    expect(Object.keys(observedSpike({ fetched: '2026-10-02' }))).toEqual(['kind', 'basis', 'fetched'])
    expect(Object.keys(observedSpike({ fetched: '2026-10-02', url: 'https://example.com/x' }))).toEqual([
      'kind',
      'basis',
      'url',
      'fetched',
    ])
    expect(observedSpike({ fetched: '2026-10-02' })).toMatchObject({ basis: 'spike' })
  })

  test('refuse an empty url or date', () => {
    expect(failure(() => observedDoc({ url: '', fetched: '2026-10-01' }))).toContain('url')
    expect(failure(() => observedSpike({ fetched: '' }))).toContain('fetched')
  })
})

describe('c002 factsOf', () => {
  test('makes the id, the title and the topics', () => {
    const a = mf.statement('hook.blocking', 'text', { topics: ['t1', 't0'], description: 'd' })
    expect(a).toMatchObject({ id: 'demo.hook.blocking', tool: 'demo', title: 'hook.blocking', topics: ['t0', 't1'] })
    expect(Object.keys(a)).toEqual(['id', 'tool', 'topics', 'title', 'description', 'content', 'source'])
    const prefixed = factsOf({ tool: 'demo', prefix: 'p', source: doc })
    expect(prefixed.value('x', [1]).id).toBe('demo.p.x')
    expect(prefixed.value('x', [1], { title: { en: 'X' } }).title).toEqual({ en: 'X' })
  })

  test('puts verify, when and a note into the fact and keeps the order of an observed source', () => {
    const verify = {
      probe: { kind: 'manual' as const, reason: 'r' },
      verifiedOn: '2.1.1',
    }
    const f = mf.statement('s', 'text', { verify, note: 'seen once', when: { since: '1.0.0' } })
    expect(Object.keys(f)).toEqual(['id', 'tool', 'topics', 'title', 'content', 'when', 'source', 'verify'])
    expect(Object.keys(f.source)).toEqual(['kind', 'basis', 'url', 'fetched', 'note'])
    expect(f.verify).toEqual(verify)
    const other = mf.value('o', [1], { source: observedSpike({ fetched: '2026-10-05' }) })
    expect(other.source).toMatchObject({ basis: 'spike' })
  })

  test('refuses a name that is empty or starts or ends with a dot, and a note on a source that is not observed', () => {
    for (const name of ['', '.a', 'a.']) expect(failure(() => mf.value(name, [1]))).toContain('dot')
    const published = factsOf({ tool: 'demo', source: { kind: 'published' } })
    expect(failure(() => published.value('a', [1], { note: 'n' }))).toContain('note')
    expect(failure(() => factsOf({ tool: '', source: doc }))).toContain('tool')
    expect(failure(() => factsOf({ tool: 'demo', source: {} as never }))).toContain('source')
  })

  test('takes a schema and a value, and the function form gives the same fact', () => {
    expect(mf.schema('s', { type: 'string' }).content).toEqual({ schema: { type: 'string' } })
    expect(mf.value('v', () => [1, 2]).content).toEqual({ value: [1, 2] })
    expect(mf.statement('t', () => 'from a function').content).toEqual({ statement: 'from a function' })
  })

  test('checks the kind of the first row of history against the method', () => {
    const rows = history({ since: '1.0.0', schema: { type: 'string' } }, { since: '1.1.0', set: { '/type': 'number' } })
    expect(failure(() => mf.value('wrong', rows))).toContain('first row is a schema')
    const versioned = mf.schema('right', rows)
    expect(versioned.variants).toHaveLength(2)
    expect('content' in versioned).toBe(false)
  })
})

describe('c002 fields of a value as getters', () => {
  const status = mf.value('status', { states: ['a', 'b'], initial: 'a', title: 'kept in the value' })

  test('are read-only, not listed, and not written to the index', () => {
    expect((status as any).states).toEqual(['a', 'b'])
    expect((status as any).initial).toBe('a')
    expect(Object.keys(status)).not.toContain('states')
    expect(Object.keys(JSON.parse(JSON.stringify(status)))).not.toContain('initial')
    expect(() => {
      'use strict'
      ;(status as any).states = []
    }).toThrow()
  })

  test('leave the fields that a fact has to the fact', () => {
    expect(status.title).toBe('status')
    expect(contentOf(status).title).toBe('kept in the value')
  })

  test('give a copy: changing it does not change the fact', () => {
    const states = (status as any).states as string[]
    states.push('c')
    expect((status as any).states).toEqual(['a', 'b'])
    expect(status.content).toEqual({ value: { states: ['a', 'b'], initial: 'a', title: 'kept in the value' } })
  })

  test('a fact written with history has none', () => {
    const f = mf.value('hist', history({ since: '1.0.0', value: { states: ['a'] } }))
    expect((f as any).states).toBeUndefined()
  })
})

describe('c002 contentOf and statementFrom', () => {
  const rows = mf.value(
    'rows',
    history({ since: '1.0.0', value: keyed(['a']) }, { since: ['1.1.0', '2.0.0'], add: { '': ['b'] } }),
  )

  test('read one row by since, and ask for since when there are several', () => {
    expect(contentOf(rows, '1.0.0')).toEqual(['a'])
    expect(contentOf(rows, '2.0.0')).toEqual(['a', 'b'])
    expect(failure(() => contentOf(rows))).toContain('2 rows')
    expect(failure(() => contentOf(rows, '9.9.9'))).toContain('no row has since "9.9.9"')
  })

  test('refuse what has no content', () => {
    expect(failure(() => contentOf({} as never))).toContain('no content')
    expect(failure(() => contentOf(undefined as never))).toContain('fact object')
  })

  test('statementFrom keeps the fact it was written from', () => {
    const list = mf.value('list', ['x', 'y'])
    const s = mf.statement(
      'said',
      statementFrom(list, (v) => `there are ${(v as string[]).length}`),
    )
    expect(s.content).toEqual({ statement: 'there are 2' })
    expect((s as any).relates).toEqual([list])
    expect(failure(() => statementFrom(list, (() => 3) as never))).toContain('text')
  })

  test('a built statement in history relates the fact of every row, once', () => {
    const list = mf.value('list2', ['x'])
    const other = mf.value('other2', ['y'])
    const v = mf.statement(
      'hist-said',
      history(
        { since: '1.0.0', statement: statementFrom(list, () => 'one') },
        { since: '1.1.0', statement: statementFrom(other, () => 'two') },
        { since: '1.2.0', statement: statementFrom(list, () => 'three') },
      ),
    )
    expect(v.variants?.map((r) => (r.content as any).statement)).toEqual(['one', 'two', 'three'])
    expect((v as any).relates).toEqual([list, other])
  })
})

describe('c002 history keeps the tags of builders', () => {
  test('through every row, in objects and in arrays', () => {
    const list = mf.value('tag-list', ['x'])
    const copy = contentOf(list)
    const v = history(
      { since: '1.0.0', value: { items: keyed(copy), plain: { a: 1 } } },
      { since: '1.1.0', add: { '/items': ['y'] } },
    )
    const second = (v[1]?.content as any).value
    expect(Object.getOwnPropertySymbols(second.items).map(String)).toContain('Symbol(fact-kit.keys)')
    expect(Object.getOwnPropertySymbols(second.items).map(String)).toContain('Symbol(fact-kit.from)')
    expect(second.items).toEqual(['x', 'y'])
  })

  test('check the output of a builder at every row and name the row and the key', () => {
    registerBuilderCheck('test-builder', (root) => {
      const r = root as { states: string[]; initial: string }
      return r.states.includes(r.initial) ? undefined : `initial "${r.initial}" is not one of the states`
    })
    const tagged = (value: object) => {
      setMark(value, BUILDER, 'test-builder')
      return value
    }
    expect(() =>
      history(
        { since: '1.0.0', value: tagged({ states: keyed(['a', 'b']), initial: 'a' }) },
        { since: '1.1.0', remove: { '/states': ['a'] } },
      ),
    ).toThrow(/history row 1 \(since "1\.1\.0"\): initial "a" is not one of the states/)
    try {
      history(
        { since: '1.0.0', value: tagged({ states: keyed(['a', 'b']), initial: 'a' }) },
        { since: '1.1.0', remove: { '/states': ['a'] } },
      )
    } catch (error) {
      expect(error).toBeInstanceOf(BuilderError)
    }
    // A row that keeps the output valid passes.
    const ok = history(
      { since: '1.0.0', value: tagged({ states: keyed(['a', 'b']), initial: 'a' }) },
      { since: '1.1.0', set: { '/initial': 'b' }, remove: { '/states': ['a'] } },
    )
    expect(ok).toHaveLength(2)
  })

  test('returns variants that are an array of rows', () => {
    const v = history({ since: '1.0.0', value: 1 })
    expect(Array.isArray(v)).toBe(true)
    expect(v).toEqual([{ since: '1.0.0', content: { value: 1 } }])
  })
})

describe('c002 subsetOf at run time', () => {
  const parent = mf.value('events', ['A', 'B', 'C'])

  test('returns a keyed copy and refuses a parent that is not a fact', () => {
    const subset = subsetOf(parent, ['A', 'B'])
    expect(subset).toEqual(['A', 'B'])
    expect(Object.getOwnPropertySymbols(subset).map(String)).toContain('Symbol(fact-kit.subset-of)')
    expect(failure(() => subsetOf(undefined as never, ['A']))).toContain('not a fact object')
    expect(failure(() => subsetOf(parent, 'A' as never))).toContain('list')
  })

  test('puts the parent into relates', () => {
    expect((mf.value('sub', subsetOf(parent, ['A'])) as any).relates).toEqual([parent])
  })
})

// --- built packages --------------------------------------------------------------------------------------
const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }
const entry = (body: string, describes = "{ demo: '1.2.0' }") =>
  [
    `import { factsOf, observedDoc, history, keyed, contentOf, statementFrom, subsetOf } from '${src}'`,
    "const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
    body,
    `export default { describes: ${describes}, facts },`,
  ]
    .join('\n')
    .replace(/,$/, '')
const built = async (name: string, files: Record<string, string>) => {
  const dir = makeTmp(name)
  writeTree(dir, { 'package.json': pkg, ...files })
  const result = await buildFacts({ cwd: dir, writeExports: true })
  const facts = result.problems.length
    ? []
    : (JSON.parse(readFileSync(join(dir, 'dist/flow/index.json'), 'utf8')).facts as any[])
  return { dir, result, facts }
}

describe('c002 derivedFrom of a built package', () => {
  const body = `
const status = mf.value('status', { states: ['a', 'b'], initial: 'a' })
const criterion = mf.schema('criterion', { type: 'object', properties: { id: { type: 'string' } } })
const mainline = mf.schema('mainline', {
  type: 'object',
  properties: { status: { enum: status.states }, criterion: { type: 'string', description: 'see ' + 'x' } },
})
const lone = mf.value('lone', { first: status.initial })
const viaFunction = mf.value('via-function', () => ({ first: status.initial }))
const nested = mf.value('nested', () => {
  mf.value('inner', () => ({ s: status.initial }))
  return { c: contentOf(criterion) }
})
const said = mf.statement('said', statementFrom(criterion, () => 'a criterion'))
const linked = mf.statement('linked', 'plain', { relates: [status] })
const facts = [status, criterion, mainline, lone, viaFunction, nested, said, linked]`
  test('follows the objects that were read, and the function form catches the scalars', async () => {
    const { result, facts } = await built('derived', { 'facts/flow/index.ts': entry(body) })
    expect(result.problems).toEqual([])
    const of = (name: string) => facts.find((f) => f.id === `demo.${name}`)?.derivedFrom
    expect(of('status')).toBeUndefined()
    expect(of('mainline')).toEqual(['demo.status'])
    // A scalar read outside the function form leaves no mark, as documented.
    expect(of('lone')).toBeUndefined()
    expect(of('via-function')).toEqual(['demo.status'])
    // The inner function form keeps its own read. The outer one gets only what it read itself.
    expect(of('nested')).toEqual(['demo.criterion'])
    expect(of('nested')).not.toContain('demo.status')
    expect(of('said')).toEqual(['demo.criterion'])
    expect(of('linked')).toEqual(['demo.status'])
  })

  test('orders relates before the reads of the document, each once', async () => {
    const { facts } = await built('derived-order', {
      'facts/flow/index.ts': entry(`
const a = mf.value('a', { list: ['x'] })
const b = mf.value('b', { list: ['y'] })
const c = mf.value('c', { list: ['z'] })
const out = mf.value('out', () => ({ one: b.list, again: b.list, two: a.list }), { relates: [c] })
const facts = [a, b, c, out]`),
    })
    expect(facts.find((f) => f.id === 'demo.out').derivedFrom).toEqual(['demo.c', 'demo.b', 'demo.a'])
  })

  test('keeps the tags in the rows of history, in row order', async () => {
    const { facts } = await built('derived-history', {
      'facts/flow/index.ts': entry(`
const a = mf.value('a', { list: ['x'] })
const b = mf.value('b', { list: ['y'] })
const out = mf.value('out', history(
  { since: '1.0.0', value: { items: keyed(a.list) } },
  { since: '1.1.0', set: { '/extra': b.list } },
))
const facts = [a, b, out]`),
    })
    const out = facts.find((f) => f.id === 'demo.out')
    expect(out.derivedFrom).toEqual(['demo.a', 'demo.b'])
    expect(out.variants.map((v: any) => v.content.value.extra)).toEqual([undefined, ['y']])
    expect(JSON.stringify(out)).not.toContain('fact-kit')
  })

  test('reports a value read from a fact that is not in this package as relates-foreign', async () => {
    const dir = makeTmp('derived-foreign')
    writeTree(dir, {
      'package.json': pkg,
      'facts/flow/index.ts': entry(`
const stranger = mf.value('stranger', { list: ['x'] })
const mine = mf.value('mine', { copy: stranger.list })
const facts = [mine]`),
    })
    const check = await cli(['check', '--cwd', dir, '--json'])
    expect(check.code).toBe(1)
    const problems = JSON.parse(check.stdout).problems.filter((p: any) => p.code !== 'unregistered-domain')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ code: 'relates-foreign' })
    expect(problems[0].message).toContain('demo.stranger')
  })
})

describe('c002 BuilderError in a built package', () => {
  test('stops the build and the CLI reports it as builder', async () => {
    const dir = makeTmp('builder-error')
    writeTree(dir, {
      'package.json': pkg,
      'facts/flow/index.ts': entry(`
const wrong = mf.value('wrong', history({ since: '1.0.0', schema: { type: 'string' } }))
const facts = [wrong]`),
    })
    const build = await cli(['build', '--cwd', dir])
    expect(build.code).toBe(1)
    expect(build.stderr).toContain('first row is a schema')
    const check = await cli(['check', '--cwd', dir, '--json'])
    expect(JSON.parse(check.stdout).problems[0]).toMatchObject({ code: 'builder' })
  })
})
