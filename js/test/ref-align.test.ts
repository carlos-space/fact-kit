import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import AjvModule from 'ajv/dist/2020.js'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts } from '../src/index.ts'
import { refProblems } from '../src/refs.ts'
import { selectFacts } from '../src/select.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }
const Ajv2020 = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as unknown as typeof AjvModule.default

const head = `import { factsOf, history, observedDoc, ref } from '${src}'
const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })
`
const entry = (body: string) => `${head}${body}\nexport default { describes: { demo: '1.9.0' }, facts }\n`
const project = (name: string, body: string) => {
  const dir = makeTmp(name)
  writeTree(dir, { 'package.json': pkg, 'facts/flow/index.ts': entry(body) })
  return dir
}
type P = { code: string; message: string }
const problems = async (dir: string): Promise<{ code: number; list: P[] }> => {
  const r = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
  return { code: r.code, list: JSON.parse(r.stdout).problems }
}
const indexOf = (dir: string): any => JSON.parse(readFileSync(join(dir, 'dist/flow/index.json'), 'utf8'))
const read = (dir: string, id: string, version: string): any =>
  selectFacts(indexOf(dir), { version }).find((f) => f.id === id)
const defsOf = (dir: string, id: string, version: string, key: string): any =>
  read(dir, id, version)?.content.schema.$defs?.[key]

describe('t008 ref: rows of the referring fact follow the rows of the target', () => {
  test('a target with a new field in next gives the referring schema two rows, one $defs each', async () => {
    const dir = project(
      'align-next',
      `
const target = mf.schema('target', history(
  { since: '0.7.0', schema: { type: 'object', properties: { id: { type: 'string' } } } },
  { since: 'next', schema: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'integer' } } } },
))
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const user = indexOf(dir).facts.find((f: any) => f.id === 'demo.user')
    expect(user.variants.map((v: any) => v.since)).toEqual(['0.7.0', 'next'])
    expect(Object.keys(defsOf(dir, 'demo.user', 'head', 'demo.target').properties)).toEqual(['id', 'extra'])
    expect(Object.keys(defsOf(dir, 'demo.user', '0.7.0', 'demo.target').properties)).toEqual(['id'])
    expect(read(dir, 'demo.user', 'head').content.schema.properties.t).toEqual({ $ref: '#/$defs/demo.target' })
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })

  test('both facts have rows with different boundaries, and every reader gets the schema of its target row', async () => {
    const dir = project(
      'align-boundaries',
      `
const target = mf.schema('target', history(
  { since: '1.0.0', schema: { type: 'string', title: 't0' } },
  { since: '1.3.0', schema: { type: 'string', title: 't1' } },
))
const user = mf.schema('user', history(
  { since: '1.1.0', schema: { type: 'object', description: 'w0', properties: { t: ref(target) } } },
  { since: '1.2.0', schema: { type: 'object', description: 'w1', properties: { t: ref(target) } } },
))
const facts = [target, user]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const user = indexOf(dir).facts.find((f: any) => f.id === 'demo.user')
    expect(user.variants.map((v: any) => v.since)).toEqual(['1.1.0', '1.2.0', '1.3.0'])
    const seen = (v: string) => {
      const s = read(dir, 'demo.user', v).content.schema
      return [s.description, s.$defs['demo.target'].title]
    }
    expect(seen('1.1.0')).toEqual(['w0', 't0'])
    expect(seen('1.1.9')).toEqual(['w0', 't0'])
    expect(seen('1.2.0')).toEqual(['w1', 't0'])
    expect(seen('1.3.0')).toEqual(['w1', 't1'])
    expect(seen('head')).toEqual(['w1', 't1'])
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })

  test('a field the target row of one reader does not have is code ref and prints that reader', async () => {
    const dir = project(
      'align-missing-field',
      `
const target = mf.schema('target', history(
  { since: '0.7.0', schema: { type: 'object', properties: { id: { type: 'string' } } } },
  { since: '0.8.0', schema: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'integer' } } } },
))
const user = mf.schema('user', { type: 'object', properties: { x: ref(target, 'extra') } })
const facts = [target, user]`,
    )
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('at 0.7.0')
    expect(list[0]?.message).toContain('"extra"')
    expect(list[0]?.message).not.toContain('not aligned')
  })

  test('rows whose since can not be combined are code ref and say so', async () => {
    const dir = project(
      'align-array',
      `
const target = mf.schema('target', history(
  { since: '1.0.0', schema: { type: 'string' } },
  { since: '1.1.0', schema: { type: 'integer' } },
))
const user = mf.schema('user', history({ since: ['1.0.5', '1.1.2'], schema: { type: 'object', properties: { t: ref(target) } } }))
const facts = [target, user]`,
    )
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list[0]?.code).toBe('ref')
    expect(list[0]?.message).toContain('can not be aligned')
  })

  test('a target of one row keeps the referring fact as it was', async () => {
    const dir = project(
      'align-single',
      `
const target = mf.schema('target', { type: 'string' })
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const user = indexOf(dir).facts.find((f: any) => f.id === 'demo.user')
    expect(user.variants).toBeUndefined()
  })

  test('a schema embedded through a schema with several rows gets the rows of the innermost target', async () => {
    const dir = project(
      'align-nested',
      `
const leaf = mf.schema('leaf', history(
  { since: '1.0.0', schema: { type: 'string' } },
  { since: '1.1.0', schema: { type: 'integer' } },
))
const mid = mf.schema('mid', { type: 'object', properties: { leaf: ref(leaf) } })
const top = mf.schema('top', { type: 'object', properties: { mid: ref(mid) } })
const facts = [leaf, mid, top]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    expect(defsOf(dir, 'demo.top', '1.0.0', 'demo.leaf')).toEqual({ type: 'string' })
    expect(defsOf(dir, 'demo.top', '1.1.0', 'demo.leaf')).toEqual({ type: 'integer' })
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })
})

describe('t008 ref: a ref to the root inside an embedded schema', () => {
  const validator = (schema: unknown) => new Ajv2020({ strict: false }).compile(schema as object)

  test('#/properties/x and # are rewritten under the id of the embedded schema, and the schema validates samples', async () => {
    const dir = project(
      'rewrite',
      `
const target = mf.schema('target', {
  type: 'object',
  properties: { a: { type: 'string' }, b: { $ref: '#/properties/a' }, child: { $ref: '#' } },
})
const user = mf.schema('user', { type: 'object', properties: { t: ref(target), a: { type: 'integer' } } })
const facts = [target, user]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const schema = read(dir, 'demo.user', 'head').content.schema
    const t = schema.$defs['demo.target']
    expect(t.properties.b).toEqual({ $ref: '#/$defs/demo.target/properties/a' })
    expect(t.properties.child).toEqual({ $ref: '#/$defs/demo.target' })
    const ok = validator(schema)
    expect(ok({ t: { a: 'x', b: 'y', child: { b: 'z' } } })).toBe(true)
    expect(ok({ t: { a: 'x', b: 1 } })).toBe(false)
    expect(ok({ t: { child: { b: 1 } } })).toBe(false)
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })

  test('refs to $defs of the embedded schema and anchors are left as they are', async () => {
    const dir = project(
      'rewrite-keep',
      `
const target = mf.schema('target', {
  type: 'object',
  $defs: { name: { type: 'string' }, tag: { $anchor: 'tag', type: 'string' } },
  properties: { n: { $ref: '#/$defs/name' }, g: { $ref: '#tag' } },
})
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`,
    )
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const t = read(dir, 'demo.user', 'head').content.schema.$defs['demo.target']
    expect(t.properties.n).toEqual({ $ref: '#/$defs/name' })
    expect(t.properties.g).toEqual({ $ref: '#tag' })
  })

  test('$dynamicRef, and a relative pointer under an $id, are code ref', async () => {
    const dynamic = project(
      'rewrite-dynamic',
      `
const target = mf.schema('target', { type: 'object', $dynamicAnchor: 'node', properties: { n: { $dynamicRef: '#node' } } })
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`,
    )
    const a = await problems(dynamic)
    expect(a.code).toBe(1)
    expect(a.list.map((p) => p.code)).toEqual(['ref'])
    expect(a.list[0]?.message).toContain('$dynamicRef')
    const withId = project(
      'rewrite-id',
      `
const target = mf.schema('target', {
  type: 'object',
  properties: { a: { type: 'string' }, b: { $id: 'https://example.com/b', $ref: '#/properties/a' } },
})
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`,
    )
    const b = await problems(withId)
    expect(b.code).toBe(1)
    expect(b.list.map((p) => p.code)).toEqual(['ref'])
    expect(b.list[0]?.message).toContain('$id')
  })
})

describe('t008 ref: check still tests an index that was not aligned', () => {
  test('an embedded schema that is not the one the reader gets is code ref with the reader version', () => {
    const row = (since: string, type: string) => ({ since, content: { schema: { type } } })
    const target = { id: 'demo.target', variants: [row('1.0.0', 'string'), row('1.1.0', 'integer')] }
    const user = {
      id: 'demo.user',
      content: {
        schema: {
          type: 'object',
          properties: { t: { $ref: '#/$defs/demo.target' } },
          $defs: { 'demo.target': { type: 'string' } },
        },
      },
    }
    const found = refProblems([
      {
        index: { package: 'demo-facts', entry: 'flow', facts: [target, user] },
        refs: [{ id: 'demo.user', target: 'demo.target', asSchema: true, rows: [0], location: 'x' }],
      },
    ])
    expect(found.map((p) => p.code)).toEqual(['ref'])
    expect(found[0]?.message).toContain('at 1.1.0')
    expect(found[0]?.message).toContain('not aligned')
  })
})
