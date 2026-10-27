import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { BuilderError, buildFacts, factsOf, observedDoc, ref } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, repoRoot, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const run = promisify(execFile)
const kitIndex = join(import.meta.dirname, '../src/index.ts')
const src = pathToFileURL(kitIndex).href
const tsc = join(import.meta.dirname, '../node_modules/.bin/tsc')
const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }

const head = `import { factsOf, history, observedDoc, ref } from '${src}'
const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })
`
const entry = (body: string, extraImports = '') =>
  `${extraImports}${head}${body}\nexport default { describes: { demo: '1.2.0' }, facts }\n`

const project = (name: string, files: Record<string, string>) => {
  const dir = makeTmp(name)
  writeTree(dir, { 'package.json': pkg, ...files })
  return dir
}
type P = { code: string; message: string; location?: string }
const problems = async (dir: string): Promise<{ code: number; list: P[] }> => {
  const r = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
  return { code: r.code, list: JSON.parse(r.stdout).problems }
}
const indexOf = (dir: string, entryName = 'flow'): any =>
  JSON.parse(readFileSync(join(dir, `dist/${entryName}/index.json`), 'utf8'))
const factOf = (dir: string, id: string, entryName = 'flow'): any =>
  indexOf(dir, entryName).facts.find((f: any) => f.id === id)

/** Schemas and values that refer to each other, the way the DDD example does. */
const sample = `
const criterion = mf.schema('criterion', { type: 'object', properties: { text: { type: 'string' } } })
const mainline = mf.schema('mainline', {
  type: 'object',
  'x-identity': 'id',
  properties: { id: { type: 'string' }, criteria: { type: 'array', items: ref(criterion) } },
})
const closed = mf.schema('mainline-closed', {
  type: 'object',
  properties: { mainline: ref(mainline, 'id'), whole: ref(mainline), reason: { type: 'string' } },
})
const settings = mf.schema('settings', {
  type: 'object',
  properties: { limits: { type: 'object', properties: { max: { type: 'integer' } } } },
})
const deep = mf.schema('deep', { type: 'object', properties: { max: ref(settings, 'limits.max') } })
const config = mf.value('config', { limits: { max: 3 }, name: 'x' })
const uses = mf.value('uses-config', { max: ref(config, 'limits.max'), who: ref(config), id: ref(mainline, 'id') })
const note = mf.statement('note', \`see \${ref(config)} and \${ref(mainline, 'id')}\`)
const facts = [criterion, mainline, closed, settings, deep, config, uses, note]`

describe('c003 ref: what the build writes', () => {
  test('a ref without a field in a schema becomes $ref and the schema goes into $defs', async () => {
    const dir = project('ref-schema', { 'facts/flow/index.ts': entry(sample) })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const mainline = factOf(dir, 'demo.mainline')
    expect(mainline.content.schema.properties.criteria.items).toEqual({ $ref: '#/$defs/demo.criterion' })
    expect(Object.keys(mainline.content.schema.$defs)).toEqual(['demo.criterion'])
    expect(mainline.content.schema.$defs['demo.criterion']).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    })
    expect(mainline.derivedFrom).toEqual(['demo.criterion'])
    // `$defs` is the last key, after what the author wrote.
    expect(Object.keys(mainline.content.schema)).toEqual(['type', 'x-identity', 'properties', '$defs'])
  })

  test('a ref with a field in a schema points into properties, and $defs holds the target flat', async () => {
    const dir = project('ref-field', { 'facts/flow/index.ts': entry(sample) })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const closed = factOf(dir, 'demo.mainline-closed')
    expect(closed.content.schema.properties.mainline).toEqual({ $ref: '#/$defs/demo.mainline/properties/id' })
    expect(closed.content.schema.properties.whole).toEqual({ $ref: '#/$defs/demo.mainline' })
    // The schema of the target without its own $defs, then what it embedded, flattened to the root.
    expect(Object.keys(closed.content.schema.$defs)).toEqual(['demo.mainline', 'demo.criterion'])
    expect(closed.content.schema.$defs['demo.mainline']).not.toHaveProperty('$defs')
    expect(closed.content.schema.$defs['demo.mainline'].properties.criteria.items).toEqual({
      $ref: '#/$defs/demo.criterion',
    })
    // Only the schema it refers to is derived from, not what that one embedded.
    expect(closed.derivedFrom).toEqual(['demo.mainline'])
  })

  test('a nested field is written with dots and becomes a path through properties', async () => {
    const dir = project('ref-nested', { 'facts/flow/index.ts': entry(sample) })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const deep = factOf(dir, 'demo.deep')
    expect(deep.content.schema.properties.max).toEqual({
      $ref: '#/$defs/demo.settings/properties/limits/properties/max',
    })
    expect(Object.keys(deep.content.schema.$defs)).toEqual(['demo.settings'])
    expect(deep.derivedFrom).toEqual(['demo.settings'])
  })

  test('in a value, a statement, or a longer string a ref is the location, with #field for a field', async () => {
    const dir = project('ref-value', { 'facts/flow/index.ts': entry(sample) })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const uses = factOf(dir, 'demo.uses-config')
    expect(uses.content.value).toEqual({ max: 'demo.config#limits.max', who: 'demo.config', id: 'demo.mainline#id' })
    expect(uses.derivedFrom).toEqual(['demo.config', 'demo.mainline'])
    const note = factOf(dir, 'demo.note')
    expect(note.content.statement).toBe('see demo.config and demo.mainline#id')
    expect(note.derivedFrom).toEqual(['demo.config', 'demo.mainline'])
    expect(JSON.stringify(indexOf(dir))).not.toContain('fact-ref')
  })

  test('the location of a fact in another entry has the package and entry in front', async () => {
    const dir = project('ref-cross-entry', {
      'facts/other/index.ts': entry(
        "const target = mf.schema('target', { type: 'object', properties: { id: { type: 'string' } } })\nexport const shared = target\nconst facts = [target]",
      ),
      'facts/flow/index.ts': entry(
        "const mine = mf.value('mine', { id: ref(shared, 'id') })\nconst wrap = mf.schema('wrap', { type: 'object', properties: { t: ref(shared) } })\nconst facts = [mine, wrap]",
        "import { shared } from '../other/index.ts'\n",
      ),
    })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    expect(factOf(dir, 'demo.mine').content.value).toEqual({ id: 'demo-facts/other:demo.target#id' })
    expect(factOf(dir, 'demo.mine').derivedFrom).toEqual(['demo-facts/other:demo.target'])
    expect(factOf(dir, 'demo.wrap').content.schema.properties.t).toEqual({ $ref: '#/$defs/demo.target' })
  })

  test('the same schema reached twice is in $defs once', async () => {
    const dir = project('ref-once', {
      'facts/flow/index.ts': entry(`
const a = mf.schema('a', { type: 'string' })
const b = mf.schema('b', { type: 'object', properties: { x: ref(a), y: ref(a), z: { items: ref(a) } } })
const facts = [a, b]`),
    })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
    const b = factOf(dir, 'demo.b')
    expect(Object.keys(b.content.schema.$defs)).toEqual(['demo.a'])
    expect(b.derivedFrom).toEqual(['demo.a'])
  })

  test('the built package passes check, and the schema with $defs is a valid schema document', async () => {
    const dir = project('ref-check-ok', { 'facts/flow/index.ts': entry(sample) })
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })
})

describe('c003 ref: what check rejects', () => {
  test('a fact object that no entry lists is relates-foreign, and the message says to list it', async () => {
    const dir = project('ref-unlisted', {
      'facts/flow/index.ts': entry(`
const lost = mf.schema('lost', { type: 'object', properties: { id: { type: 'string' } } })
const user = mf.value('user', { who: ref(lost, 'id') })
const facts = [user]`),
    })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'relates-foreign' })
    expect(list[0]?.message).toContain('demo.user')
    expect(list[0]?.message).toContain('"demo.lost"')
    expect(list[0]?.message).toContain('not listed in the `facts` of any entry')
  })

  test('an object of another package is relates-foreign and the message says to use derive', async () => {
    const dir = project('ref-foreign', {
      'facts/flow/index.ts': entry(
        `const user = mf.value('user', { who: ref(outsider, 'id') })
const facts = [user]`,
        "const outsider = { id: 'other.thing', tool: 'other', topics: [], title: 't', content: { schema: {} }, source: { kind: 'published' } }\n",
      ),
    })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['relates-foreign'])
    expect(list[0]?.message).toContain('"other.thing"')
    expect(list[0]?.message).toContain('derive(upstreamSpec, id)')
  })

  test('a field the target does not have fails with code ref, for a schema and for a value', async () => {
    const dir = project('ref-no-field', {
      'facts/flow/index.ts': entry(`
const s = mf.schema('s', { type: 'object', properties: { id: { type: 'string' } } })
const v = mf.value('v', { a: { b: 1 } })
const u1 = mf.value('u1', { x: ref(s, 'name') })
const u2 = mf.schema('u2', { type: 'object', properties: { x: ref(s, 'id.deeper') } })
const u3 = mf.value('u3', { x: ref(v, 'a.c') })
const facts = [s, v, u1, u2, u3]`),
    })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['ref', 'ref', 'ref'])
    expect(list.map((p) => p.message.split(':')[0])).toEqual(['demo.u1', 'demo.u2', 'demo.u3'])
    expect(list[0]?.message).toContain('demo.s')
    expect(list[0]?.message).toContain('"name"')
  })

  test('a field with a dot in its name can not be referenced and the message says so', async () => {
    const dir = project('ref-dotted', {
      'facts/flow/index.ts': entry(`
const v = mf.value('v', { 'a.b': 1 })
const u = mf.value('u', { x: ref(v, 'a.b') })
const facts = [v, u]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('dot')
  })

  test('a field of a statement, and a $ref to a value or a statement, fail with code ref', async () => {
    const dir = project('ref-kind', {
      'facts/flow/index.ts': entry(`
const text = mf.statement('text', 'plain words')
const v = mf.value('v', { a: 1 })
const u1 = mf.value('u1', { x: ref(text, 'a') })
const u2 = mf.schema('u2', { type: 'object', properties: { x: ref(v) } })
const facts = [text, v, u1, u2]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['ref', 'ref'])
    expect(list[0]?.message).toContain('statement')
    expect(list[1]?.message).toContain('not a schema')
  })

  test('a row of the target without the field fails and prints the reader version', async () => {
    const dir = project('ref-row', {
      'facts/flow/index.ts': entry(`
const target = mf.schema('target', history(
  { since: '1.0.0', schema: { type: 'object', properties: { id: { type: 'string' }, old: { type: 'string' } } } },
  { since: '1.1.0', schema: { type: 'object', properties: { id: { type: 'string' } } } },
))
const user = mf.value('user', { x: ref(target, 'old') })
const facts = [target, user]`),
    })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('demo.user')
    expect(list[0]?.message).toContain('demo.target')
    expect(list[0]?.message).toContain('"old"')
    expect(list[0]?.message).toContain('at 1.1.0')
    // Nothing is written while check fails.
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems.map((p) => p.code)).toEqual(['ref'])
  })

  test('a field every row of the target has passes, and a reader before the target has a row fails', async () => {
    const ok = project('ref-rows-ok', {
      'facts/flow/index.ts': entry(`
const target = mf.value('target', history({ since: '1.0.0', value: { id: 1, a: 1 } }, { since: '1.1.0', value: { id: 1 } }))
const user = mf.value('user', { x: ref(target, 'id') })
const facts = [target, user]`),
    })
    expect(await problems(ok)).toEqual({ code: 0, list: [] })
    const early = project('ref-rows-early', {
      'facts/flow/index.ts': entry(`
const target = mf.value('target', history({ since: '1.1.0', value: { id: 1 } }))
const user = mf.value('user', history({ since: '1.0.0', value: { x: ref(target, 'id') } }))
const facts = [target, user]`),
    })
    const { list } = await problems(early)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('at 1.0.0')
    expect(list[0]?.message).toContain('no row of demo.target applies')
  })

  test('a row of the referring fact that has no ref is not checked', async () => {
    const dir = project('ref-other-row', {
      'facts/flow/index.ts': entry(`
const target = mf.value('target', history({ since: '1.1.0', value: { id: 1 } }))
const user = mf.value('user', history({ since: '1.0.0', value: { x: 1 } }, { since: '1.1.0', value: { x: ref(target, 'id') } }))
const facts = [target, user]`),
    })
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })

  test('a schema that embeds a target with several rows gets a row for each, so check passes', async () => {
    const same = project('ref-embed-same', {
      'facts/flow/index.ts': entry(`
const target = mf.schema('target', history(
  { since: '1.0.0', schema: { type: 'string' } },
  { since: '1.1.0', schema: { type: 'string' } },
))
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`),
    })
    expect(await problems(same)).toEqual({ code: 0, list: [] })
    const differ = project('ref-embed-differ', {
      'facts/flow/index.ts': entry(`
const target = mf.schema('target', history(
  { since: '1.0.0', schema: { type: 'string' } },
  { since: '1.1.0', schema: { type: 'integer' } },
))
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } })
const facts = [target, user]`),
    })
    // The build gives `user` a row for each row of `target`, so the readers of both get the schema of their row.
    expect(await problems(differ)).toEqual({ code: 0, list: [] })
  })

  test('schemas that embed each other fail with code ref and list the loop', async () => {
    const dir = project('ref-cycle', {
      'facts/flow/index.ts': entry(`
const a = mf.schema('a', { type: 'object', properties: {} })
const b = mf.schema('b', { type: 'object', properties: { a: ref(a) } })
a.content.schema.properties.b = ref(b)
const facts = [a, b]`),
    })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    // The loop is also a loop of derivedFrom, which another rule has always reported.
    expect(list.map((p) => p.code).sort()).toEqual(['ref', 'relation-cycle'])
    expect(list.find((p) => p.code === 'ref')?.message).toMatch(
      /demo\.a -> demo\.b -> demo\.a|demo\.b -> demo\.a -> demo\.b/,
    )
  })

  test('a schema that refers to itself fails with code ref', async () => {
    const dir = project('ref-self', {
      'facts/flow/index.ts': entry(`
const a = mf.schema('a', { type: 'object', properties: {} })
a.content.schema.properties.me = ref(a)
const facts = [a]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code).sort()).toEqual(['ref', 'relation-cycle'])
    expect(list.find((p) => p.code === 'ref')?.message).toContain('demo.a -> demo.a')
  })

  test('embedding a schema of another entry that has a $ref to a file fails with code ref', async () => {
    const files = {
      'facts/other/schemas/part.schema.json': { type: 'string' },
      'facts/other/index.ts': entry(
        "const target = mf.schema('target', { type: 'object', properties: { p: { $ref: 'schemas/part.schema.json' } } })\nexport const shared = target\nconst facts = [target]",
      ),
    }
    const across = project('ref-file-ref', {
      ...files,
      'facts/flow/index.ts': entry(
        "const wrap = mf.schema('wrap', { type: 'object', properties: { t: ref(shared) } })\nconst facts = [wrap]",
        "import { shared } from '../other/index.ts'\n",
      ),
    })
    const { code, list } = await problems(across)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('schemas/part.schema.json')
    // In the same entry the relative path still holds.
    const same = project('ref-file-ref-same', {
      'facts/flow/schemas/part.schema.json': { type: 'string' },
      'facts/flow/index.ts': entry(`
const target = mf.schema('target', { type: 'object', properties: { p: { $ref: 'schemas/part.schema.json' } } })
const wrap = mf.schema('wrap', { type: 'object', properties: { t: ref(target) } })
const facts = [target, wrap]`),
    })
    expect(await problems(same)).toEqual({ code: 0, list: [] })
  })

  test('a $defs key the author wrote with other content fails with code ref', async () => {
    const dir = project('ref-defs-clash', {
      'facts/flow/index.ts': entry(`
const a = mf.schema('a', { type: 'string' })
const b = mf.schema('b', { type: 'object', $defs: { 'demo.a': { type: 'integer' } }, properties: { x: ref(a) } })
const facts = [a, b]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['ref'])
    expect(list[0]?.message).toContain('demo.a')
  })

  test('an empty part in the field path fails with code ref', async () => {
    const dir = project('ref-empty-part', {
      'facts/flow/index.ts': entry(`
const v = mf.value('v', { a: { b: 1 } })
const u = mf.value('u', { x: ref(v, 'a..b') })
const facts = [v, u]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['ref'])
  })
})

describe('c003 ref: the function', () => {
  const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })
  const target = mf.schema('target', { type: 'object', properties: { id: { type: 'string' } } })

  test('returns one placeholder per fact and field, and writes nothing else', () => {
    expect(ref(target, 'id')).toBe(ref(target, 'id'))
    expect(ref(target)).not.toBe(ref(target, 'id'))
    expect(ref(target)).toMatch(/^⟦fact-ref:\d+⟧$/)
    expect(ref(target)).not.toMatch(/fact-link/)
  })

  test('needs a fact object and a non-empty string field', () => {
    expect(() => ref('demo.target' as never)).toThrow(BuilderError)
    expect(() => ref(target, '' as never)).toThrow(BuilderError)
    expect(() => ref(target, 3 as never)).toThrow(BuilderError)
  })
})

describe('c003 ref: field names are checked by tsc', () => {
  async function compile(name: string, file: string) {
    const dir = makeTmp(name)
    writeTree(dir, {
      'sample.ts': file,
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
        files: ['sample.ts'],
      },
    })
    try {
      const { stdout } = await run(tsc, ['-p', join(dir, 'tsconfig.json')])
      return { code: 0, out: stdout }
    } catch (error) {
      const e = error as { code?: number; stdout?: string }
      return { code: e.code ?? 1, out: e.stdout ?? '' }
    }
  }
  const typed = `import { factsOf, history, observedDoc, ref } from 'fact-kit'
const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })
const mainline = mf.schema('mainline', {
  type: 'object',
  properties: { id: { type: 'string' }, limits: { type: 'object', properties: { max: { type: 'integer' } } } },
})
const config = mf.value('config', { limits: { max: 3 }, name: 'x' })
const text = mf.statement('text', 'words')
const versioned = mf.schema('versioned', history({ since: '1.0.0', schema: { type: 'object' } }))
`

  test('field names that exist, nested ones, and facts whose shape is unknown compile', async () => {
    const r = await compile(
      'ref-types-ok',
      `${typed}
export const a = [ref(mainline), ref(mainline, 'id'), ref(mainline, 'limits.max'), ref(config, 'name'), ref(config, 'limits.max')]
export const b = [ref(text), ref(versioned, 'anything.at.all')]
export const guard: import('fact-kit').FactRef = ref(mainline)
`,
    )
    expect(r).toEqual({ code: 0, out: '' })
  })

  test('a field name written wrong fails the compile and names it', async () => {
    const r = await compile(
      'ref-types-bad',
      `${typed}
export const a = ref(mainline, 'nope')
export const b = ref(config, 'limits.min')
export const c = ref(text, 'x')
`,
    )
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('sample.ts(11,')
    expect(r.out).toContain('"nope"')
    expect(r.out).toContain('sample.ts(12,')
    expect(r.out).toContain('"limits.min"')
    expect(r.out).toContain('sample.ts(13,')
    // Keep the output for the record.
    const keep = join(repoRoot, 'tmp/m150/t004-evidence')
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, 'tsc-ref-typo.txt'), r.out)
  })
})

describe('c002 x-identity names properties of the same schema', () => {
  const entity = (identity: string, properties = "{ id: { type: 'string' }, mainline: { type: 'string' } }") =>
    entry(
      `const e = mf.schema('e', { type: 'object', 'x-identity': ${identity}, properties: ${properties} })\nconst facts = [e]`,
    )

  test('a field name and a composite identity of fields that exist pass, and build writes them as given', async () => {
    const one = project('identity-one', { 'facts/flow/index.ts': entity("'id'") })
    expect(await problems(one)).toEqual({ code: 0, list: [] })
    const both = project('identity-two', { 'facts/flow/index.ts': entity("['mainline', 'id']") })
    expect(await problems(both)).toEqual({ code: 0, list: [] })
    expect((await buildFacts({ cwd: both, writeExports: true })).problems).toEqual([])
    expect(factOf(both, 'demo.e').content.schema['x-identity']).toEqual(['mainline', 'id'])
  })

  test('a field the properties do not have fails with schema-property and names it', async () => {
    const dir = project('identity-missing', { 'facts/flow/index.ts': entity("'name'") })
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list.map((p) => p.code)).toEqual(['schema-property'])
    expect(list[0]?.message).toContain('"name"')
    expect(list[0]?.message).toContain('id, mainline')
    expect(list[0]?.location).toContain('/facts/0/content/schema/x-identity')
    const built = await buildFacts({ cwd: dir, writeExports: true })
    expect(built.problems.map((p) => p.code)).toEqual(['schema-property'])
  })

  test('each missing name of a composite identity is named', async () => {
    const dir = project('identity-composite-missing', { 'facts/flow/index.ts': entity("['id', 'nope', 'zip']") })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['schema-property'])
    expect(list[0]?.message).toContain('"nope", "zip"')
  })

  test('the name must be in the same schema, not in a parent or a child', async () => {
    const dir = project('identity-nested', {
      'facts/flow/index.ts': entry(`
const e = mf.schema('e', {
  type: 'object',
  properties: { id: { type: 'string' }, child: { type: 'object', 'x-identity': 'id', properties: { key: { type: 'string' } } } },
})
const facts = [e]`),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['schema-property'])
    expect(list[0]?.location).toContain('/properties/child/x-identity')
  })

  test('a row of a fact with history is checked too, and a property named x-identity is not a keyword', async () => {
    const bad = project('identity-row', {
      'facts/flow/index.ts': entry(`
const e = mf.schema('e', history(
  { since: '1.0.0', schema: { type: 'object', 'x-identity': 'id', properties: { id: { type: 'string' } } } },
  { since: '1.1.0', schema: { type: 'object', 'x-identity': 'id', properties: { key: { type: 'string' } } } },
))
const facts = [e]`),
    })
    const { list } = await problems(bad)
    expect(list.map((p) => p.code)).toEqual(['schema-property'])
    expect(list[0]?.location).toContain('/variants/1/content/schema/x-identity')
    const field = project('identity-field', {
      'facts/flow/index.ts': entity("'id'", "{ id: { type: 'string' }, 'x-identity': { type: 'string' } }"),
    })
    expect(await problems(field)).toEqual({ code: 0, list: [] })
  })

  test('a schema file under schemas/ is checked as well', async () => {
    const dir = project('identity-file', {
      'facts/flow/schemas/e.schema.json': {
        type: 'object',
        'x-identity': 'nope',
        properties: { id: { type: 'string' } },
      },
      'facts/flow/index.ts': entry('const facts = []'),
    })
    const { list } = await problems(dir)
    expect(list.map((p) => p.code)).toEqual(['schema-property'])
    expect(list[0]?.message).toContain('schemas/e.schema.json')
  })
})
