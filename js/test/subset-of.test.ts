import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const run = promisify(execFile)
const kitIndex = join(import.meta.dirname, '../src/index.ts')
const src = pathToFileURL(kitIndex).href
const tsc = join(import.meta.dirname, '../node_modules/.bin/tsc')

/** Compiles `files` with `fact-kit` pointed at the source. Returns the exit code and what tsc printed. */
async function compile(name: string, files: Record<string, string>) {
  const dir = makeTmp(name)
  writeTree(dir, {
    ...files,
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
      files: Object.keys(files),
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

const head = `import { factsOf, observedDoc, subsetOf } from 'fact-kit'
const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })
const all = mf.value('all', ['A', 'B', 'C'])
`

describe('c004 subsetOf types', () => {
  test('a subset inside a typed parent compiles', async () => {
    const r = await compile('types-ok', {
      'ok.ts': `${head}export const some = mf.value('some', subsetOf(all, ['A', 'C']))
export const unknownParent = mf.value('u', subsetOf({} as import('fact-kit').Fact, ['anything']))
`,
    })
    expect(r).toEqual({ code: 0, out: '' })
  })

  test('a value the parent does not have fails the compile and names it', async () => {
    const r = await compile('types-bad', {
      'bad.ts': `${head}export const some = mf.value('some', subsetOf(all, ['A', 'Z']))\n`,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('bad.ts(4')
    expect(r.out).toContain('"Z"')
  })
})

const pkg = { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} }
const parentFact = (variants: unknown[]) => ({
  id: 'demo.events',
  tool: 'demo',
  topics: [],
  title: 'events',
  content: (variants[0] as any).content,
  variants,
  source: { kind: 'published' },
})
const row = (since: string, ...value: string[]) => ({ since, content: { value } })

/** A package whose parent list comes from a converted JSON file, so the type can not check it. */
function project(name: string, parentRows: unknown[], childRows: string, extra: Record<string, string> = {}) {
  const dir = makeTmp(name)
  writeTree(dir, {
    'package.json': pkg,
    'facts/flow/converted.json': { describes: { demo: '2.1.300' }, facts: [parentFact(parentRows)] },
    'facts/flow/index.ts': [
      `import { factsOf, history, observedDoc, subsetOf } from '${src}'`,
      "import converted from './converted.json' with { type: 'json' }",
      "const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
      "const events = (converted.facts as any[]).find((f) => f.id === 'demo.events')",
      childRows,
      'export default { describes: converted.describes, facts: [...converted.facts, child] }',
      '',
    ].join('\n'),
    ...extra,
  })
  return dir
}

const problems = async (dir: string) => {
  const r = await cli(['check', '--cwd', dir, '--json', '--allow-domain', 'example.com'])
  return { code: r.code, list: JSON.parse(r.stdout).problems as { code: string; message: string; location?: string }[] }
}

describe('c004 subset-of check at the version boundaries', () => {
  test('passes when every boundary has the subset inside the parent', async () => {
    const dir = project(
      'subset-pass',
      [row('2.1.200', 'A', 'B', 'C'), row('2.1.300', 'A', 'B', 'C', 'D')],
      "const child = mf.value('child', history({ since: '2.1.200', value: subsetOf(events, ['A', 'B']) }, { since: '2.1.300', value: subsetOf(events, ['A', 'D']) }))",
    )
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
    expect((await buildFacts({ cwd: dir, writeExports: true })).problems).toEqual([])
  })

  test('fails and prints the version where the parent lost a value of the subset', async () => {
    const dir = project(
      'subset-fail',
      [row('2.1.200', 'A', 'B', 'C'), row('2.1.300', 'A', 'C')],
      "const child = mf.value('child', subsetOf(events, ['A', 'B']))",
    )
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'subset-of' })
    expect(list[0]?.message).toContain('demo.child: at 2.1.300')
    expect(list[0]?.message).toContain('"B" is not in demo.events')
    // `build` runs the rule too, so the package is not written.
    const built = await buildFacts({ cwd: dir, writeExports: true })
    expect(built.problems.map((p) => p.code)).toEqual(['subset-of'])
    expect(built.files).toEqual([])
  })

  test('reports each missing value once and says how many other versions it fails at', async () => {
    const dir = project(
      'subset-many',
      [row('2.1.200', 'A'), row('2.1.300', 'A')],
      "const child = mf.value('child', subsetOf(events, ['A', 'X', 'Y']))",
    )
    const { list } = await problems(dir)
    expect(list.map((p) => p.message.match(/"[XY]"/)?.[0]).sort()).toEqual(['"X"', '"Y"'])
    expect(list[0]?.message).toContain('at 2.1.200')
    expect(list[0]?.message).toMatch(/and at \d+ other versions?/)
  })

  test('fails at a boundary where the parent has no row yet', async () => {
    const dir = project(
      'subset-no-row',
      [row('2.1.200', 'A', 'B')],
      "const child = mf.value('child', history({ since: '2.1.100', value: subsetOf(events, ['A']) }))",
    )
    const { list } = await problems(dir)
    expect(list).toHaveLength(1)
    expect(list[0]?.message).toContain('at 2.1.100')
    expect(list[0]?.message).toContain('no row of demo.events applies')
  })

  test('compares objects by value, whatever the order of their keys', async () => {
    const dir = makeTmp('subset-objects')
    writeTree(dir, {
      'package.json': pkg,
      'facts/flow/converted.json': {
        describes: { demo: '1.0.0' },
        facts: [parentFact([{ since: '1.0.0', content: { value: [{ a: 1, b: 2 }] } }])],
      },
      'facts/flow/index.ts': [
        `import { factsOf, observedDoc, subsetOf } from '${src}'`,
        "import converted from './converted.json' with { type: 'json' }",
        "const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        "const events = (converted.facts as any[]).find((f) => f.id === 'demo.events')",
        "const child = mf.value('child', subsetOf(events, [{ b: 2, a: 1 }]))",
        'export default { describes: converted.describes, facts: [...converted.facts, child] }',
        '',
      ].join('\n'),
    })
    expect(await problems(dir)).toEqual({ code: 0, list: [] })
  })

  test('derivedFrom of the subset names the parent', async () => {
    const dir = project(
      'subset-derived',
      [row('2.1.200', 'A', 'B')],
      "const child = mf.value('child', subsetOf(events, ['A']))",
    )
    const result = await buildFacts({ cwd: dir, writeExports: true })
    expect(result.problems).toEqual([])
    const index = JSON.parse((await import('node:fs')).readFileSync(join(dir, 'dist/flow/index.json'), 'utf8'))
    expect(index.facts.find((f: any) => f.id === 'demo.child').derivedFrom).toEqual(['demo.events'])
    expect(index.subsets).toBeUndefined()
  })

  test('a parent that was not found stops the load with builder', async () => {
    const dir = project(
      'subset-missing',
      [row('2.1.200', 'A')],
      "const child = mf.value('child', subsetOf((converted.facts as any[]).find((f) => f.id === 'demo.nope'), ['A']))",
    )
    const { code, list } = await problems(dir)
    expect(code).toBe(1)
    expect(list[0]).toMatchObject({ code: 'builder' })
  })

  test('a parent in another entry is found by its location', async () => {
    const dir = makeTmp('subset-entries')
    const body = (id: string, rows: string) =>
      [
        `import { factsOf, observedDoc, subsetOf } from '${src}'`,
        "import { parentEntry } from '../shared.ts'",
        '',
      ].join('\n') +
      rows +
      id
    writeTree(dir, {
      'package.json': pkg,
      'facts/shared.ts': '',
      'facts/b/index.ts': [
        `import { factsOf, observedDoc } from '${src}'`,
        "const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        "export const events = mf.value('events', ['A', 'B'])",
        "export default { describes: { demo: '1.0.0' }, facts: [events] }",
        '',
      ].join('\n'),
      'facts/a/index.ts': [
        `import { factsOf, observedDoc, subsetOf } from '${src}'`,
        "import { events } from '../b/index.ts'",
        "const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        "export default { describes: { demo: '1.0.0' }, facts: [mf.value('child', subsetOf(events, ['A', 'Z']))] }",
        '',
      ].join('\n'),
    })
    void body
    const { list } = await problems(dir)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'subset-of' })
    expect(list[0]?.message).toContain('"Z" is not in demo-facts/b:demo.events')
  })
})
