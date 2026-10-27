import { execFile } from 'node:child_process'
import { cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BuilderError,
  HistoryError,
  aggregate,
  buildFacts,
  domainEvent,
  entity,
  factLink,
  factsOf,
  history,
  invariant,
  keyed,
  observedDoc,
  ref,
  sequenceToMermaid,
  useCase,
  valueObject,
} from '../src/index.ts'
import { BUILDER } from '../src/markers.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const mf = factsOf({
  tool: 'ddd',
  prefix: 'domain',
  source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }),
})

const errorOf = (fn: () => unknown): Error => {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}
const builderFailure = (fn: () => unknown): string => {
  const error = errorOf(fn)
  expect(error).toBeInstanceOf(BuilderError)
  return error.message
}
const historyFailure = (fn: () => unknown): string => {
  const error = errorOf(fn)
  expect(error).toBeInstanceOf(HistoryError)
  return error.message
}
const at = (variants: ReturnType<typeof history>, i: number): any => {
  const content = variants[i]?.content as any
  return content.value ?? content.schema ?? content.statement
}

const kindsOf = (fact: { content?: object }): string[] => Object.keys(fact.content ?? {})

// --- sample objects -----------------------------------------------------------------------------------
const fields = () => ({
  id: { type: 'string' },
  title: { type: 'string' },
  status: { enum: ['open', 'closed'] },
})
const person = mf.schema('person', entity({ identity: 'id', fields: fields(), required: ['id', 'status'] }))
const team = mf.schema('team', entity({ identity: 'id', fields: fields() }))
const note = mf.schema('note', valueObject({ text: { type: 'string' } }))

describe('c003 the six builders', () => {
  test('each builder gives one kind of content and its own ddd: topic', () => {
    const vo = mf.schema('vo', valueObject({ a: { type: 'string' } }))
    const en = mf.schema('en', entity({ identity: 'a', fields: { a: { type: 'string' } } }))
    const ev = mf.schema('ev', domainEvent({ a: { type: 'string' } }))
    const ag = mf.value('ag', aggregate({ root: en, members: [{ entity: vo }] }))
    const inv = mf.statement('inv', invariant(en, 'A is never empty.'))
    const uc = mf.value('uc', useCase({ steps: [{ layer: 'domain', action: 'go' }] }))
    const cases: [string, { topics: string[]; content?: object }, string, string][] = [
      ['valueObject', vo, 'ddd:value-object', 'schema'],
      ['entity', en, 'ddd:entity', 'schema'],
      ['domainEvent', ev, 'ddd:domain-event', 'schema'],
      ['aggregate', ag, 'ddd:aggregate', 'value'],
      ['invariant', inv, 'ddd:invariant', 'statement'],
      ['useCase', uc, 'ddd:use-case', 'value'],
    ]
    for (const [name, fact, topic, kind] of cases) {
      expect(fact.topics, name).toContain(topic)
      expect(kindsOf(fact), name).toEqual([kind])
    }
  })

  test('the topics run builder first, then the factory, then the call', () => {
    const tagged = factsOf({
      tool: 'ddd',
      source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }),
      topics: ['domain', 'ddd:entity'],
    })
    const fact = tagged.schema('x', valueObject({ a: { type: 'string' } }), { topics: ['extra', 'domain'] })
    expect(fact.topics).toEqual(['ddd:value-object', 'domain', 'ddd:entity', 'extra'])
  })

  test('a builder given to the wrong method fails, and so do rows whose first row is another kind', () => {
    expect(builderFailure(() => mf.value('x', entity({ identity: 'a', fields: { a: {} } }) as any))).toContain('schema')
    expect(builderFailure(() => mf.schema('x', aggregate({ root: person, members: [] }) as any))).toContain('value')
    expect(builderFailure(() => mf.statement('x', valueObject({ a: {} }) as any))).toBeTruthy()
  })

  test('valueObject and domainEvent give { type, properties, required? } in that order', () => {
    const v = valueObject({ a: { type: 'string' }, b: { type: 'integer' } }, { required: ['a'] })
    expect(Object.keys(v)).toEqual(['type', 'properties', 'required'])
    expect(JSON.parse(JSON.stringify(v))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
      required: ['a'],
    })
    expect(Object.keys(domainEvent({ a: {} }))).toEqual(['type', 'properties'])
    expect((v as any)[BUILDER]).toBe('valueObject')
    expect((domainEvent({ a: {} }) as any)[BUILDER]).toBe('domainEvent')
  })

  test('entity writes the identity as x-identity: a name, or at least two names', () => {
    const one = entity({ identity: 'id', fields: { id: {}, b: {} } })
    expect(Object.keys(one)).toEqual(['type', 'x-identity', 'properties'])
    expect(one['x-identity']).toBe('id')
    expect(entity({ identity: ['id'], fields: { id: {} } })['x-identity']).toBe('id')
    expect(entity({ identity: ['a', 'b'], fields: { a: {}, b: {} }, required: ['a'] })['x-identity']).toEqual([
      'a',
      'b',
    ])
    expect((one as any)[BUILDER]).toBe('entity')
  })

  test('entity and the objects reject an identity or a required name that is not a field', () => {
    expect(builderFailure(() => entity({ identity: 'nope' as any, fields: { id: {} } }))).toContain('"nope"')
    expect(builderFailure(() => entity({ identity: ['id', 'id'], fields: { id: {} } }))).toContain('twice')
    expect(builderFailure(() => entity({ identity: [] as any, fields: { id: {} } }))).toContain('identity')
    expect(builderFailure(() => entity({ identity: 'id', fields: { id: {} }, required: ['gone'] as any }))).toContain(
      '"gone"',
    )
    expect(builderFailure(() => valueObject({ a: {} }, { required: ['b'] as any }))).toContain('"b"')
    expect(builderFailure(() => domainEvent({ a: {} }, { required: ['b'] as any }))).toContain('"b"')
    expect(builderFailure(() => valueObject({ a: 3 } as any))).toContain('"a"')
  })

  test('aggregate writes fact positions and keeps the members keyed by entity', () => {
    const value = aggregate({ root: person, members: [{ entity: team, cardinality: 'many' }, { entity: note }] })
    expect(Object.keys(value)).toEqual(['root', 'members'])
    expect(value.root).toBe(factLink(person))
    expect(value.members).toEqual([
      { entity: factLink(team), cardinality: 'many' },
      { entity: factLink(note), cardinality: 'one' },
    ])
    expect(Object.getOwnPropertySymbols(value.members).map(String)).toContain('Symbol(fact-kit.keys)')
    expect(builderFailure(() => aggregate({ root: 'x' as any, members: [] }))).toContain('root')
    expect(
      builderFailure(() => aggregate({ root: person, members: [{ entity: team, cardinality: 'few' as any }] })),
    ).toContain('cardinality')
  })

  test('invariant is a built statement that relates to its subject', () => {
    const fact = mf.statement('inv2', invariant(person, { 'zh-TW': '名稱不可空白' }))
    expect(fact.content).toEqual({ statement: { 'zh-TW': '名稱不可空白' } })
    expect((fact as any).relates).toEqual([person])
    expect(builderFailure(() => invariant(person, '' as any))).toContain('text')
    expect(builderFailure(() => invariant('x' as any, 'text'))).toContain('subject')
  })

  test('useCase keeps steps keyed by action and errors as a keyed list', () => {
    const value = useCase({
      input: ref(person, 'id'),
      steps: [
        { layer: 'application', action: 'read' },
        { layer: 'domain', action: 'check', rule: mf.statement('r', 'x'), emits: note, calls: team },
      ],
      errors: ['not-found'],
    })
    expect(Object.keys(value)).toEqual(['input', 'steps', 'errors'])
    expect(Object.keys(value.steps[1] as object)).toEqual(['layer', 'action', 'rule', 'emits', 'calls'])
    expect((value.steps[1] as any).emits).toBe(factLink(note))
    expect(useCase({ steps: [] }).errors).toEqual([])
    expect(Object.getOwnPropertySymbols(value.steps).map(String)).toContain('Symbol(fact-kit.keys)')
    expect(Object.getOwnPropertySymbols(value.errors).map(String)).toContain('Symbol(fact-kit.keys)')
    expect(builderFailure(() => useCase({ steps: [{ layer: 'ui' as any, action: 'x' }] }))).toContain('layer')
    expect(builderFailure(() => useCase({ steps: [{ layer: 'domain', action: '' }] }))).toContain('action')
  })

  test('a repeated key in a collection fails when the builder keys it', () => {
    const steps = [
      { layer: 'domain', action: 'same' },
      { layer: 'application', action: 'same' },
    ] as const
    expect(historyFailure(() => useCase({ steps }))).toContain('"same"')
    expect(historyFailure(() => useCase({ steps: [], errors: ['a', 'a'] }))).toContain('"a"')
    expect(historyFailure(() => aggregate({ root: person, members: [{ entity: team }, { entity: team }] }))).toContain(
      'two items have the key',
    )
    expect(historyFailure(() => valueObject({ a: {} }, { required: ['a', 'a'] }))).toContain('"a"')
  })
})

// --- d004 / d011: history on the collections -----------------------------------------------------------------
describe('c002 history removes and adds the properties of an object by name', () => {
  const base = () => ({ since: '1.0.0', schema: entity({ identity: 'id', fields: fields(), required: ['id'] }) })

  test('remove drops a property, add puts a new one at the end, replace swaps one', () => {
    const v = history(
      { since: '1.0.0', schema: valueObject(fields(), { required: ['id'] }) },
      {
        since: '1.1.0',
        remove: { '/properties': ['title'] },
        add: { '/properties': { note: { type: 'string' } } },
        replace: { '/properties/status': { enum: ['open', 'closed', 'dropped'] } },
      },
    )
    expect(Object.keys(at(v, 1).properties)).toEqual(['id', 'status', 'note'])
    expect(at(v, 1).properties.status.enum).toEqual(['open', 'closed', 'dropped'])
    expect(Object.keys(at(v, 0).properties)).toEqual(['id', 'title', 'status'])
  })

  test('a name that is not there, a name that is already there, and a list that is not names fail', () => {
    const row = (r: object) => () => history({ since: '1', schema: valueObject(fields()) }, { since: '2', ...r })
    expect(historyFailure(row({ remove: { '/properties': ['ghost'] } }))).toContain('"ghost"')
    expect(historyFailure(row({ add: { '/properties': { id: { type: 'string' } } } }))).toContain('"id"')
    expect(historyFailure(row({ replace: { '/properties/ghost': {} } }))).toContain('nothing is there')
    expect(historyFailure(row({ add: { '/properties': ['x'] } }))).toContain('properties')
    expect(historyFailure(row({ remove: { '/properties': [1] } }))).toContain('name')
  })

  test('dropping a field that required still lists fails as builder, and succeeds with required dropped too', () => {
    const miss = builderFailure(() => history(base(), { since: '1.1.0', remove: { '/properties': ['id'] } }))
    expect(miss).toContain('history row')
    expect(miss).toContain('"id"')
    const v = history(
      { since: '1.0.0', schema: valueObject(fields(), { required: ['id', 'status'] }) },
      { since: '1.1.0', remove: { '/properties': ['status'], '/required': ['status'] } },
    )
    expect(at(v, 1).required).toEqual(['id'])
  })

  test('an entity that loses its identity field fails until x-identity moves', () => {
    const row = { since: '2', remove: { '/properties': ['id'] } }
    const first = { since: '1', schema: entity({ identity: 'id', fields: fields() }) }
    expect(builderFailure(() => history(first, row))).toContain('x-identity')
    const v = history(first, {
      ...row,
      add: { '/properties': { code: { type: 'string' } } },
      set: { '/x-identity': 'code' },
    })
    expect(at(v, 1)['x-identity']).toBe('code')
  })

  test('required is keyed: add and remove by name, and a first required comes from set', () => {
    const v = history(
      { since: '1', schema: valueObject(fields(), { required: ['id'] }) },
      { since: '2', add: { '/required': ['title'] } },
      { since: '3', remove: { '/required': ['id'] } },
    )
    expect(at(v, 1).required).toEqual(['id', 'title'])
    expect(at(v, 2).required).toEqual(['title'])
    expect(
      builderFailure(() =>
        history(
          { since: '1', schema: valueObject(fields(), { required: ['id'] }) },
          { since: '2', add: { '/required': ['ghost'] } },
        ),
      ),
    ).toContain('"ghost"')
    expect(
      historyFailure(() =>
        history(
          { since: '1', schema: valueObject(fields(), { required: ['id'] }) },
          { since: '2', add: { '/required': ['id'] } },
        ),
      ),
    ).toContain('already there')
    const fresh = history(
      { since: '1', schema: valueObject(fields()) },
      { since: '2', set: { '/required': keyed(['id']) } },
    )
    expect(at(fresh, 1).required).toEqual(['id'])
  })

  test('domainEvent properties work the same way', () => {
    const first = {
      since: '1',
      schema: domainEvent({ a: { type: 'string' }, b: { type: 'integer' } }, { required: ['a'] }),
    }
    const v = history(first, { since: '2', remove: { '/properties': ['b'] }, add: { '/properties': { c: {} } } })
    expect(Object.keys(at(v, 1).properties)).toEqual(['a', 'c'])
    expect(historyFailure(() => history(first, { since: '2', remove: { '/properties': ['z'] } }))).toContain('"z"')
    expect(builderFailure(() => history(first, { since: '2', remove: { '/properties': ['a'] } }))).toContain('"a"')
  })
})

describe('c003 d011 keys of the other DDD collections', () => {
  test('aggregate members: replace, remove and add by the entity position', () => {
    const first = {
      since: '1',
      value: aggregate({ root: person, members: [{ entity: team, cardinality: 'many' }] }),
    }
    const v = history(
      first,
      { since: '2', replace: { '/members': [{ entity: factLink(team), cardinality: 'one' }] } },
      { since: '3', add: { '/members': [{ entity: factLink(note), cardinality: 'many' }] } },
      { since: '4', remove: { '/members': [factLink(team)] } },
    )
    expect(at(v, 1).members).toEqual([{ entity: factLink(team), cardinality: 'one' }])
    expect(at(v, 2).members.map((m: any) => m.entity)).toEqual([factLink(team), factLink(note)])
    expect(at(v, 3).members).toEqual([{ entity: factLink(note), cardinality: 'many' }])
    // against
    expect(historyFailure(() => history(first, { since: '2', remove: { '/members': [factLink(note)] } }))).toContain(
      'no item has the key',
    )
    expect(
      historyFailure(() =>
        history(first, { since: '2', replace: { '/members': [{ entity: factLink(note), cardinality: 'one' }] } }),
      ),
    ).toContain('no item has the key')
    expect(
      historyFailure(() => history(first, { since: '2', add: { '/members': [{ entity: factLink(team) }] } })),
    ).toContain('already there')
    expect(
      builderFailure(() =>
        history(first, { since: '2', add: { '/members': [{ entity: factLink(note), cardinality: 'some' }] } }),
      ),
    ).toContain('cardinality')
  })

  const useCaseFirst = () => ({
    since: '1',
    value: useCase({
      steps: [
        { layer: 'application', action: 'read' },
        { layer: 'domain', action: 'check' },
      ],
      errors: ['not-found', 'locked'],
    }),
  })

  test('useCase steps: replace, remove and add by action, and add only goes last', () => {
    const v = history(
      useCaseFirst(),
      { since: '2', replace: { '/steps': [{ layer: 'infrastructure', action: 'read' }] } },
      { since: '3', remove: { '/steps': ['check'] } },
      { since: '4', add: { '/steps': [{ layer: 'domain', action: 'emit', emits: factLink(note) }] } },
    )
    expect(at(v, 1).steps.map((s: any) => s.layer)).toEqual(['infrastructure', 'domain'])
    expect(at(v, 2).steps.map((s: any) => s.action)).toEqual(['read'])
    expect(at(v, 3).steps.map((s: any) => s.action)).toEqual(['read', 'emit'])
    // against
    expect(historyFailure(() => history(useCaseFirst(), { since: '2', remove: { '/steps': ['ghost'] } }))).toContain(
      '"ghost"',
    )
    expect(
      historyFailure(() =>
        history(useCaseFirst(), { since: '2', replace: { '/steps': [{ layer: 'domain', action: 'ghost' }] } }),
      ),
    ).toContain('no item has the key')
    expect(
      historyFailure(() =>
        history(useCaseFirst(), { since: '2', add: { '/steps': [{ layer: 'domain', action: 'read' }] } }),
      ),
    ).toContain('already there')
    expect(
      builderFailure(() =>
        history(useCaseFirst(), { since: '2', add: { '/steps': [{ layer: 'ui', action: 'new' }] } }),
      ),
    ).toContain('layer')
    expect(
      historyFailure(() => history(useCaseFirst(), { since: '2', replace: { '/steps/1/action': 'x' } })),
    ).toContain('index')
  })

  test('useCase errors: add and remove by code', () => {
    const v = history(
      useCaseFirst(),
      { since: '2', add: { '/errors': ['expired'] } },
      { since: '3', remove: { '/errors': ['locked'] } },
      { since: '4', replace: { '/errors': keyed(['expired']) } },
    )
    expect(at(v, 1).errors).toEqual(['not-found', 'locked', 'expired'])
    expect(at(v, 2).errors).toEqual(['not-found', 'expired'])
    expect(at(v, 3).errors).toEqual(['expired'])
    expect(historyFailure(() => history(useCaseFirst(), { since: '2', remove: { '/errors': ['ghost'] } }))).toContain(
      '"ghost"',
    )
    expect(historyFailure(() => history(useCaseFirst(), { since: '2', add: { '/errors': ['locked'] } }))).toContain(
      'already there',
    )
    expect(builderFailure(() => history(useCaseFirst(), { since: '2', add: { '/errors': [3] } }))).toContain('errors')
  })

  test('invariant: a later row rewrites the sentence whole, or set replaces it, and carries relates', () => {
    const v = history(
      { since: '1', statement: invariant(person, { 'zh-TW': '甲' }) },
      { since: '2', statement: invariant(team, { 'zh-TW': '乙' }) },
      { since: '3', set: { '': { 'zh-TW': '丙' } } },
    )
    expect(at(v, 1)).toEqual({ 'zh-TW': '乙' })
    expect(at(v, 2)).toEqual({ 'zh-TW': '丙' })
    const fact = mf.statement('inv-history', v)
    expect((fact as any).relates).toEqual([person, team])
    expect(fact.topics).toContain('ddd:invariant')
    // against
    expect(
      historyFailure(() => history({ since: '1', statement: 'a' }, { since: '2', set: { '/zh-TW': 'b' } })),
    ).toContain('parent')
    expect(
      historyFailure(() => history({ since: '1', statement: 'a' }, { since: '2', replace: { '/zh-TW': 'b' } })),
    ).toContain('nothing is there')
    expect(builderFailure(() => history({ since: '1', statement: 'a' }, { since: '2', set: { '': 5 } }))).toContain(
      'text',
    )
    expect(
      historyFailure(() => history({ since: '1', statement: 'a' }, { since: '2', set: { '': invariant(team, 'b') } })),
    ).toContain('statement')
  })

  test('rows of a DDD fact keep the ddd: topic when written with history', () => {
    const e = mf.schema('hist-entity', history({ since: '1', schema: entity({ identity: 'id', fields: { id: {} } }) }))
    expect(e.topics).toContain('ddd:entity')
    const u = mf.value('hist-case', history(useCaseFirst()))
    expect(u.topics).toContain('ddd:use-case')
  })
})

describe('c006 sequenceToMermaid draws a use case', () => {
  const draw = () =>
    useCase({
      input: ref(person, 'id'),
      steps: [
        { layer: 'application', action: 'read the person' },
        { layer: 'domain', action: 'check; the rule' },
        { layer: 'domain', action: 'emit', emits: note },
        { layer: 'infrastructure', action: 'save' },
      ],
    })

  test('the participants are caller and each layer by first use, a step goes from the layer before it', () => {
    expect(sequenceToMermaid(draw())).toBe(
      [
        'sequenceDiagram',
        '    participant p0 as caller',
        '    participant p1 as application',
        '    participant p2 as domain',
        '    participant p3 as infrastructure',
        '    p0->>p1: read the person',
        '    p1->>p2: check#59; the rule',
        '    p2->>p2: emit',
        '    p2->>p3: save',
      ].join('\n'),
    )
  })

  test('a fact whose value is a use case draws the same, and a value with neither shape is refused', () => {
    expect(sequenceToMermaid(mf.value('draw', draw()))).toBe(sequenceToMermaid(draw()))
    expect(sequenceToMermaid({ content: { value: JSON.parse(JSON.stringify(draw())) } } as any)).toBe(
      sequenceToMermaid(draw()),
    )
    expect(builderFailure(() => sequenceToMermaid({ steps: 3 } as any))).toContain('sequenceToMermaid')
    expect(sequenceToMermaid(useCase({ steps: [] }))).toBe('sequenceDiagram\n    participant p0 as caller')
  })
})

// --- the DDD example and an aggregate sample, built as projects -----------------------------------------
const fixtureRoot = join(import.meta.dirname, 'fixtures/ddd-example')

/** Copies the fixture, changing nothing but the `fact-kit` import path to the source of this checkout. */
function copyFixture(name: string, rewrite = true): string {
  const dir = makeTmp(name)
  writeTree(dir, { 'package.json': { name: 'ddd-facts', version: '1.0.0', type: 'module', exports: {} } })
  cpSync(join(fixtureRoot, 'facts'), join(dir, 'facts'), { recursive: true })
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name)
      if (statSync(file).isDirectory()) walk(file)
      else if (name.endsWith('.ts')) {
        writeFileSync(file, readFileSync(file, 'utf8').replaceAll("from 'fact-kit'", `from '${src}'`))
      }
    }
  }
  if (rewrite) walk(join(dir, 'facts'))
  return dir
}
const built = (dir: string, entry: string): any[] =>
  JSON.parse(readFileSync(join(dir, `dist/${entry}/index.json`), 'utf8')).facts

describe('c004 the DDD example builds to what the example lists', () => {
  test('mainline and close-mainline match the id, title, topics, content and derivedFrom of the example', async () => {
    const dir = copyFixture('ddd-example')
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const facts = built(dir, 'domain')
    const pick = (id: string) => {
      const { id: i, title, topics, content, derivedFrom } = facts.find((f) => f.id === id)
      return { id: i, title, topics, content, derivedFrom }
    }
    expect(pick('mainflow.domain.mainline')).toEqual({
      id: 'mainflow.domain.mainline',
      title: 'mainline',
      topics: ['ddd:entity'],
      content: {
        schema: {
          type: 'object',
          'x-identity': 'id',
          properties: {
            id: { type: 'string', pattern: '^m\\d{3}$' },
            status: { enum: ['planning', 'active', 'blocked', 'done', 'dropped'] },
            criteria: { type: 'array', items: { $ref: '#/$defs/mainflow.domain.criterion' } },
          },
          $defs: {
            'mainflow.domain.criterion': {
              type: 'object',
              properties: {
                id: { type: 'string', pattern: '^r\\d{3}$' },
                text: { type: 'string' },
                done: { type: 'boolean' },
              },
            },
          },
        },
      },
      derivedFrom: ['mainflow.domain.mainline.status', 'mainflow.domain.criterion'],
    })
    expect(pick('mainflow.domain.close-mainline')).toEqual({
      id: 'mainflow.domain.close-mainline',
      title: 'close-mainline',
      topics: ['ddd:use-case'],
      content: {
        value: {
          input: 'mainflow.domain.mainline#id',
          steps: [
            { layer: 'application', action: '讀取主脈絡' },
            {
              layer: 'domain',
              action: '檢查不變條件',
              rule: 'mainflow.domain.mainline.close-requires-criteria',
            },
            { layer: 'domain', action: '發出事件', emits: 'mainflow.domain.mainline-closed' },
          ],
          errors: ['criteria-not-done', 'mainline-not-found'],
        },
      },
      derivedFrom: [
        'mainflow.domain.mainline',
        'mainflow.domain.mainline.close-requires-criteria',
        'mainflow.domain.mainline-closed',
      ],
    })
  })

  test('the example passes check', async () => {
    const dir = copyFixture('ddd-example-check')
    const r = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(JSON.parse(r.stdout).problems).toEqual([])
  })

  test('an aggregate sample builds with its members, topics and derivedFrom', async () => {
    const dir = copyFixture('ddd-shop')
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const facts = built(dir, 'shop')
    const byId = (id: string) => facts.find((f) => f.id === id)
    expect(byId('mainflow.shop.order-boundary')).toMatchObject({
      topics: ['ddd:aggregate'],
      content: {
        value: { root: 'mainflow.shop.order', members: [{ entity: 'mainflow.shop.order-line', cardinality: 'many' }] },
      },
      derivedFrom: ['mainflow.shop.order', 'mainflow.shop.order-line'],
    })
    expect(byId('mainflow.shop.order-line').content.schema['x-identity']).toEqual(['order', 'no'])
    expect(byId('mainflow.shop.order-not-empty')).toMatchObject({
      topics: ['ddd:invariant'],
      derivedFrom: ['mainflow.shop.order'],
    })
    expect(byId('mainflow.shop.order-placed').content.schema.properties.order).toEqual({
      $ref: '#/$defs/mainflow.shop.order/properties/id',
    })
    expect(byId('mainflow.shop.place-order').content.value.steps).toEqual([
      { layer: 'domain', action: 'check lines', rule: 'mainflow.shop.order-not-empty' },
      { layer: 'domain', action: 'place', emits: 'mainflow.shop.order-placed' },
      { layer: 'infrastructure', action: 'save', calls: 'mainflow.shop.order' },
    ])
    for (const f of facts)
      expect(
        f.topics.some((t: string) => t.startsWith('ddd:')),
        f.id,
      ).toBe(true)
  })
})

describe('build failures', () => {
  const project = (body: string) => {
    const dir = makeTmp('ddd-fail')
    writeTree(dir, {
      'package.json': { name: 'ddd-facts', version: '1.0.0', type: 'module', exports: {} },
      'facts/d/index.ts': [
        `import { factsOf, observedDoc, entity, useCase, history } from '${src}'`,
        "const mf = factsOf({ tool: 'd', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        body,
        "export default { describes: { d: '1.0.0' }, facts: [e] }",
      ].join('\n'),
    })
    return dir
  }

  test('a row that drops a field but not its required entry stops the build, and check says builder', async () => {
    const dir = project(
      "const e = mf.schema('e', history({ since: '1.0.0', schema: entity({ identity: 'id', fields: { id: {}, a: {} }, required: ['id', 'a'] }) }, { since: '1.1.0', remove: { '/properties': ['a'] } }))",
    )
    const build = await cli(['build', '--cwd', dir])
    expect(build.code).toBe(1)
    expect(build.stderr).toContain('"a"')
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    const problem = JSON.parse(check.stdout).problems.find((p: any) => p.code === 'builder')
    expect(problem.message).toContain('required')
  })

  test('the same row with required dropped builds', async () => {
    const dir = project(
      "const e = mf.schema('e', history({ since: '1.0.0', schema: entity({ identity: 'id', fields: { id: {}, a: {} }, required: ['id', 'a'] }) }, { since: '1.1.0', remove: { '/properties': ['a'], '/required': ['a'] } }))",
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const fact = built(dir, 'd')[0]
    expect(fact.variants[1].content.schema.required).toEqual(['id'])
    expect(Object.keys(fact.variants[1].content.schema.properties)).toEqual(['id'])
  })

  test('two steps with one action stop the build', async () => {
    const dir = project(
      "const e = mf.value('e', useCase({ steps: [{ layer: 'domain', action: 'x' }, { layer: 'domain', action: 'x' }] }))",
    )
    const build = await cli(['build', '--cwd', dir])
    expect(build.code).toBe(1)
    expect(build.stderr).toContain('two items have the key')
    const check = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
    expect(JSON.parse(check.stdout).problems.map((p: any) => p.code)).toContain('history')
  })
})

// --- the types ----------------------------------------------------------------------------------------------
const run = promisify(execFile)
const kitIndex = join(import.meta.dirname, '../src/index.ts')
const tsc = join(import.meta.dirname, '../node_modules/.bin/tsc')

/** Compiles `files` (path -> text) with `fact-kit` pointed at the source. */
async function compile(name: string, files: string[], extra: Record<string, string> = {}) {
  const dir = copyFixture(name, false)
  writeTree(dir, {
    ...extra,
    'tsconfig.json': {
      compilerOptions: {
        strict: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2022',
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ['node'],
        paths: { 'fact-kit': [kitIndex] },
      },
      files,
    },
  })
  // The copy points at the source by path, and the compile points `fact-kit` at it, so both agree.
  try {
    const { stdout } = await run(tsc, ['-p', join(dir, 'tsconfig.json')])
    return { code: 0, out: stdout }
  } catch (error) {
    const e = error as { code?: number; stdout?: string }
    return { code: e.code ?? 1, out: e.stdout ?? '' }
  }
}

describe('c003 the types of the builders', () => {
  test('the DDD example and the aggregate sample compile', async () => {
    const r = await compile('ddd-types', ['facts/domain/index.ts', 'facts/shop/index.ts'])
    expect(r).toEqual({ code: 0, out: '' })
  })

  test('an identity or a required name that is not a field fails the compile and names it', async () => {
    const r = await compile('ddd-types-bad', ['bad.ts'], {
      'bad.ts': [
        "import { entity, valueObject } from 'fact-kit'",
        "export const a = entity({ identity: 'idd', fields: { id: { type: 'string' } } })",
        "export const b = valueObject({ id: { type: 'string' } }, { required: ['nope'] })",
      ].join('\n'),
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('\'"idd"\'')
    expect(r.out).toContain('\'"nope"\'')
  })
})
