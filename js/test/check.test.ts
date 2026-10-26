import { afterEach, describe, expect, test } from 'vitest'
import { checkFacts, checkProject, findLocalPaths, findUrlHosts } from '../src/index.ts'
import type { ExampleGroup, Fact, IndexInput } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const fact = (id: string, extra: Partial<Fact> = {}): Fact => ({
  id,
  tool: id.split('.')[0] as string,
  topics: ['t'],
  title: id,
  content: { value: 1 },
  source: { kind: 'published' },
  ...extra,
})

const index = (facts: Fact[], origin = 'facts/a/index.ts'): IndexInput => ({
  origin,
  index: { package: 'p-facts', entry: 'a', describes: { p: '1.0.0' }, facts },
})

const group = (factIds: string[]): ExampleGroup => ({
  id: 'first-build',
  name: 'First build',
  situation: 'I want my first output',
  claim: 'One command is enough',
  scenarios: [
    {
      title: 'Minimal',
      situation: 'Just one skill',
      code: [{ caption: 'a.ts', lang: 'ts', source: 'export {}' }],
      outcome: ['A file appears'],
      points: ['Nothing else is needed'],
      facts: factIds,
    },
  ],
})

describe('c002 check', () => {
  test('a clean set of facts passes', () => {
    const r = checkFacts({ indexes: [index([fact('p.one'), fact('p.two')])] })
    expect(r.problems).toEqual([])
    expect(r.counts.facts).toBe(2)
  })

  test('an empty set passes', () => {
    expect(checkFacts({ indexes: [] }).problems).toEqual([])
  })

  test('a duplicate id is rejected, within one index and across indexes', () => {
    const within = checkFacts({ indexes: [index([fact('p.one'), fact('p.one')])] })
    expect(within.problems.map((p) => p.code)).toEqual(['duplicate-id'])
    expect(within.problems[0]?.message).toContain('"p.one"')
    const across = checkFacts({
      indexes: [index([fact('p.one')], 'a/index.json'), index([fact('p.one')], 'b/index.json')],
    })
    expect(across.problems).toHaveLength(1)
    expect(across.problems[0]).toMatchObject({ code: 'duplicate-id', location: 'b/index.json#/facts/0/id' })
    expect(across.problems[0]?.message).toContain('a/index.json')
  })

  test('local absolute paths are rejected', () => {
    for (const bad of [
      '/Users/alice/project/x',
      '/home/ci/work',
      'C:\\Users\\me\\x',
      'C:/Users/me/x',
      'file:///etc/hosts',
    ]) {
      const r = checkFacts({ indexes: [index([fact('p.one', { title: `see ${bad} here` })])] })
      expect(
        r.problems.map((p) => p.code),
        bad,
      ).toContain('local-path')
    }
    const nested = checkFacts({ indexes: [index([fact('p.one', { content: { value: { dir: '/Users/x/y' } } })])] })
    expect(nested.problems[0]).toMatchObject({
      code: 'local-path',
      location: 'facts/a/index.ts#/facts/0/content/value/dir',
    })
  })

  test('path look-alikes are not reported', () => {
    expect(findLocalPaths('https://example.com/home/page and src/Users/x and ~/.claude/settings.json and a/b')).toEqual(
      [],
    )
  })

  test('a domain that is not registered is rejected, registered ones and subdomains pass', () => {
    const f = fact('p.one', { description: 'docs at https://docs.example.com/a and https://evil.test/x' })
    const r = checkFacts({ indexes: [index([f])], allowedDomains: ['example.com'] })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatchObject({ code: 'unregistered-domain' })
    expect(r.problems[0]?.message).toContain('evil.test')
    expect(checkFacts({ indexes: [index([f])], allowedDomains: ['example.com', 'evil.test'] }).problems).toEqual([])
    // With no allowed domains every URL host is reported.
    expect(checkFacts({ indexes: [index([f])] }).problems).toHaveLength(2)
    expect(findUrlHosts('https://<host>/x and https://${HOST}/y and http://a.b.test:8080/z')).toEqual(['a.b.test'])
  })

  test('paths and domains inside schema files are scanned and the files are validated', () => {
    const input: IndexInput = {
      ...index([fact('p.one')]),
      schemas: [
        { file: 'a.schema.json', schema: { description: 'see /Users/me/x or https://evil.test', 'x-sinse': '1' } },
      ],
    }
    const codes = checkFacts({ indexes: [input] }).problems.map((p) => p.code)
    expect(codes).toEqual(expect.arrayContaining(['format', 'local-path', 'unregistered-domain']))
  })

  test('format errors name the fact', () => {
    const r = checkFacts({ indexes: [index([fact('p.one', { source: { kind: 'observed' } as never })])] })
    expect(r.problems[0]?.code).toBe('format')
    expect(r.problems[0]?.message).toContain('p.one')
  })

  test('an id must start with its tool, and a $ref into schemas/ must have its file', () => {
    const wrongTool = checkFacts({ indexes: [index([fact('p.one', { tool: 'q' })])] })
    expect(wrongTool.problems.map((p) => p.code)).toEqual(['id-prefix'])
    const ref = fact('p.one', { content: { schema: { $ref: 'schemas/missing.schema.json' } } })
    expect(checkFacts({ indexes: [index([ref])] }).problems.map((p) => p.code)).toEqual(['missing-schema-file'])
    const ok = { ...index([ref]), schemas: [{ file: 'missing.schema.json', schema: { type: 'string' } }] }
    expect(checkFacts({ indexes: [ok] }).problems).toEqual([])
  })

  test('a replacement must be a known fact id', () => {
    const r = checkFacts({ indexes: [index([fact('p.one', { when: { replacement: 'p.nope' } })])] })
    expect(r.problems.map((p) => p.code)).toEqual(['unknown-fact-id'])
  })
})

describe('c007 examples', () => {
  test('an example referencing an existing fact id passes', () => {
    const r = checkFacts({
      indexes: [index([fact('p.one')])],
      examples: [{ origin: 'examples/first-build.ts', group: group(['p.one']) }],
    })
    expect(r.problems).toEqual([])
    expect(r.counts.examples).toBe(1)
  })

  test('an example referencing a fact id that does not exist is rejected, naming the id', () => {
    const r = checkFacts({
      indexes: [index([fact('p.one')])],
      examples: [{ origin: 'examples/first-build.ts', group: group(['p.one', 'p.missing']) }],
    })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatchObject({
      code: 'unknown-fact-id',
      location: 'examples/first-build.ts#/scenarios/0/facts/1',
    })
    expect(r.problems[0]?.message).toContain('"p.missing"')
  })

  test('group-level fact ids are checked too, and a malformed example is a format problem', () => {
    const g = { ...group(['p.one']), facts: ['p.nope'] }
    const r = checkFacts({ indexes: [index([fact('p.one')])], examples: [{ origin: 'e.ts', group: g }] })
    expect(r.problems[0]?.message).toContain('"p.nope"')
    const bad = checkFacts({ indexes: [], examples: [{ origin: 'e.ts', group: { id: 'x' } }] })
    expect(bad.problems[0]?.code).toBe('format')
  })
})

describe('check on disk', () => {
  const pkg = { name: 'demo-facts', version: '0.0.0', type: 'module' }
  const entry = (facts: string) => `export default { describes: { demo: '1.0.0' }, facts: [${facts}] }\n`
  const factSrc = (id: string, extra = '') =>
    `{ id: '${id}', tool: 'demo', topics: ['t'], title: 'T', content: { value: 1 }, source: { kind: 'published' }${extra} }`

  test('a package with no facts directory passes', async () => {
    const dir = makeTmp('empty')
    writeTree(dir, { 'package.json': pkg })
    const r = await checkProject({ cwd: dir })
    expect(r.problems).toEqual([])
    expect(r.counts.facts).toBe(0)
  })

  test('the CLI finds a duplicate id across entries, a local path and an unregistered domain, and exits 1', async () => {
    const dir = makeTmp('cli-check')
    writeTree(dir, {
      'package.json': pkg,
      'fact-kit.config.json': { allowedDomains: ['example.com'] },
      'facts/a/index.ts': entry(factSrc('demo.same')),
      'facts/b/index.ts': entry(
        `${factSrc('demo.same')}, ${factSrc('demo.path', ", description: 'in /Users/me/x'")}, ${factSrc('demo.url', ", description: 'https://evil.test/y'")}`,
      ),
    })
    const r = await cli(['check', '--cwd', dir])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('duplicate-id')
    expect(r.stderr).toContain('local-path')
    expect(r.stderr).toContain('unregistered-domain')
    expect(r.stderr).toContain('evil.test')
  })

  test('the CLI passes clean facts and checks examples against a built index passed with --index', async () => {
    const dir = makeTmp('cli-ok')
    writeTree(dir, {
      'package.json': pkg,
      'facts/a/index.ts': entry(factSrc('demo.one')),
      'examples/g.json': group(['demo.one']),
    })
    const ok = await cli(['check', '--cwd', dir])
    expect(ok.stderr).toBe('')
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain('1 facts')
    writeTree(dir, { 'examples/g.json': group(['demo.ghost']) })
    const bad = await cli(['check', '--cwd', dir])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('demo.ghost')

    const ex = makeTmp('cli-examples')
    writeTree(ex, {
      'package.json': { name: 'demo-examples', type: 'module' },
      'examples/g.json': group(['demo.one']),
      'index/index.json': { package: 'demo-facts', entry: 'a', describes: {}, facts: [fact('demo.one')] },
    })
    const viaIndex = await cli(['check', '--cwd', ex, '--index', 'index'])
    expect(viaIndex.stderr).toBe('')
    expect(viaIndex.code).toBe(0)
  })

  test('a module that cannot be run is reported as a load problem', async () => {
    const dir = makeTmp('load')
    writeTree(dir, { 'package.json': pkg, 'facts/a/index.ts': 'throw new Error("boom")\n' })
    const r = await checkProject({ cwd: dir })
    expect(r.problems[0]).toMatchObject({ code: 'load' })
    expect(r.problems[0]?.message).toContain('boom')
  })
})
