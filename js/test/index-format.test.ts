import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildFacts, checkProject, selectFacts, validateIndex } from '../src/index.ts'
import type { FactIndex } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const fact = (id: string, extra = '') =>
  `{ id: '${id}', tool: 'demo', topics: ['t'], title: '${id}', content: { value: 1 }, source: { kind: 'published' }${extra} }`
const entry = (describes: string, facts: string[]) =>
  `export default { describes: ${describes}, facts: [${facts.join(', ')}] }\n`
const pkg = { name: '@demo/tool-facts', version: '1.0.0', type: 'module' }
const readIndex = (dir: string, entryName: string): any =>
  JSON.parse(readFileSync(join(dir, 'dist', entryName, 'index.json'), 'utf8'))

describe('c001 index format 1.1 is written', () => {
  test('the built index has indexFormat 1.1, and no ac', async () => {
    const dir = makeTmp('format')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.a')]) })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const index = readIndex(dir, 'cli')
    expect(index.indexFormat).toBe('1.1')
    expect(Object.keys(index)[0]).toBe('indexFormat')
    expect(JSON.stringify(index)).not.toContain('"ac"')
    expect(validateIndex(index)).toEqual([])
  })

  test('a fact with variants gets the latest published row as its top-level content', async () => {
    const dir = makeTmp('top-level')
    const variants = `variants: [
      { since: '0.40.0', content: { value: 'a' } },
      { since: '0.49.0', content: { value: 'b' } },
      { since: 'next', content: { value: 'd' }, pending: 'x' },
    ]`
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '0.49.0' }", [
        fact('demo.a', `, ${variants}`),
        // Only a pending row: the top-level content falls back to it, and check warns.
        `{ id: 'demo.p', tool: 'demo', topics: [], title: 'p', content: { value: 0 }, source: { kind: 'published' }, variants: [{ since: 'next', content: { value: 'only' }, pending: 'x' }] }`,
      ]),
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const index = readIndex(dir, 'cli') as FactIndex
    // A reader of format 1.0 reads `content` and ignores `variants`.
    expect(index.facts.map((f) => (f.content as { value: unknown }).value)).toEqual(['b', 'only'])
    expect(selectFacts(index, { version: '0.40.0' }).map((f) => (f.content as { value: unknown }).value)).toEqual(['a'])
    expect(validateIndex(index)).toEqual([])
  })
})

describe('c004 derivedFrom, replacement and movedTo', () => {
  test('are built into the index and read back', async () => {
    const dir = makeTmp('relations')
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [
        fact('demo.old', ", when: { replacement: ['demo.new1', 'demo.new2'], movedTo: 'other-facts/git:git.cmd' }"),
        fact('demo.new1', ", derivedFrom: ['demo.new2', 'other-facts/git:git.cmd']"),
        fact('demo.new2'),
      ]),
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const index = readIndex(dir, 'cli')
    expect(index.facts[0].when).toEqual({ replacement: ['demo.new1', 'demo.new2'], movedTo: 'other-facts/git:git.cmd' })
    expect(index.facts[1].derivedFrom).toEqual(['demo.new2', 'other-facts/git:git.cmd'])
    const read = selectFacts(index)
    expect(read[0]?.when?.replacement).toEqual(['demo.new1', 'demo.new2'])
    expect(read[1]?.derivedFrom).toEqual(['demo.new2', 'other-facts/git:git.cmd'])
  })

  test('a single replacement string still builds, and a movedTo without a spec is rejected', async () => {
    const dir = makeTmp('relations-bad')
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [
        fact('demo.old', ", when: { replacement: 'demo.new' }"),
        fact('demo.new'),
      ]),
    })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
    const badDir = makeTmp('relations-moved')
    writeTree(badDir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.old', ", when: { movedTo: 'git.cmd' }")]),
    })
    const bad = await buildFacts({ cwd: badDir })
    expect(bad.problems.map((p) => p.code)).toEqual(['format'])
    expect(bad.problems[0]?.location).toContain('/when/movedTo')
  })

  test('check rejects a replacement or a local derivedFrom that names no fact, but not one in another package', async () => {
    const dir = makeTmp('relations-check')
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [
        fact('demo.a', ", when: { replacement: ['demo.b', 'demo.ghost'] }, derivedFrom: ['demo.nope', 'other:x.y']"),
        fact('demo.b'),
      ]),
    })
    const { problems } = await checkProject({ cwd: dir })
    expect(problems.map((p) => p.message)).toEqual([
      'demo.a: replacement "demo.ghost" is not a known fact id',
      'demo.a: derivedFrom "demo.nope" is not a known fact id',
    ])
  })
})

describe('c004 check: describes names at most one component', () => {
  const run = async (files: Record<string, string>) => {
    const dir = makeTmp('describes')
    writeTree(dir, { 'package.json': pkg, ...files })
    return { dir, ...(await cli(['check', '--cwd', dir])) }
  }

  test('one key passes', async () => {
    const r = await run({ 'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.a')]) })
    expect(r.code).toBe(0)
  })

  test('no key passes, it says the described thing has no version', async () => {
    const r = await run({ 'facts/cli/index.ts': entry('{}', [fact('demo.a')]) })
    expect(r.code).toBe(0)
    const all = await run({
      'facts/cli/index.ts': entry('{}', [fact('demo.a')]),
      'facts/hooks/index.ts': entry('{}', [fact('demo.b')]),
    })
    expect(all.code).toBe(0)
  })

  test('an entry with {} and an entry with a component fail', async () => {
    const r = await run({
      'facts/cli/index.ts': entry('{}', [fact('demo.a')]),
      'facts/hooks/index.ts': entry("{ demo: '1.0.0' }", [fact('demo.b')]),
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('describes "demo", but facts/cli/index.ts of the same package describes nothing ({})')
  })

  test('two keys fail and name them', async () => {
    const r = await run({ 'facts/cli/index.ts': entry("{ demo: '1.2.0', other: '2.0.0' }", [fact('demo.a')]) })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('at most one component, and this one names 2 (demo, other)')
  })

  test('two entries of one package that describe different components fail', async () => {
    const r = await run({
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.a')]),
      'facts/hooks/index.ts': entry("{ other: '1.2.0' }", [fact('demo.b')]),
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('describes "other", but facts/cli/index.ts of the same package describes "demo"')
    // Two entries of the same component pass.
    const ok = await run({
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.a')]),
      'facts/hooks/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.b')]),
    })
    expect(ok.code).toBe(0)
  })

  test('build does not apply the rule, so a package with describes {} still builds', async () => {
    const dir = makeTmp('describes-build')
    writeTree(dir, { 'package.json': pkg, 'facts/cli/index.ts': entry('{}', [fact('demo.a')]) })
    expect((await buildFacts({ cwd: dir })).problems).toEqual([])
  })

  test('a published index of format 1.0 with several products is not held to the rule', async () => {
    const dir = makeTmp('describes-index-file')
    writeTree(dir, {
      'package.json': pkg,
      'old/index.json': {
        package: 'p',
        entry: 'e',
        describes: { a: '1.0.0', b: '2.0.0' },
        facts: [
          { id: 'demo.x', tool: 'demo', topics: [], title: 'x', content: { value: 1 }, source: { kind: 'published' } },
        ],
      },
    })
    const r = await cli(['check', '--cwd', dir, '--index', 'old'])
    expect(r.code).toBe(0)
  })
})

describe('check: rows', () => {
  const check = async (variants: string, extra = '') => {
    const dir = makeTmp('rows')
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [fact('demo.a', `, variants: [${variants}]${extra}`)]),
    })
    return checkProject({ cwd: dir })
  }
  const row = (since: string, more = '') => `{ since: ${since}, content: { value: 1 }${more} }`

  test('accepts the three forms of since', async () => {
    const r = await check(
      [row("'0.40.0'"), row("['0.48.1', '0.49.1', 'next']"), row("'0.50.0-alpha.1'", ", platforms: ['codex']")].join(
        ',',
      ),
    )
    expect(r.problems).toEqual([])
  })

  test('rejects a since that is not a version, a next in the middle and two versions on one line', async () => {
    const bad = await check([row("'soon'"), row("['next', '0.49.0']"), row("['0.49.0', '0.49.1']")].join(','))
    expect(bad.problems.map((p) => [p.code, p.message])).toEqual([
      ['since-format', 'demo.a: since "soon" is neither a version nor "next"'],
      ['since-format', 'demo.a: since "next" may only be the last item of an array'],
      ['since-format', 'demo.a: since two versions on release line 0.49'],
    ])
    const empty = await check(row('[]'))
    expect([...new Set(empty.problems.map((p) => p.code))].sort()).toEqual(['format', 'since-format'])
  })

  test('rejects two rows that a reader can not tell apart', async () => {
    const same = await check([row("'0.40.0'"), row("'0.40.0'")].join(','))
    expect(same.problems.map((p) => p.code)).toEqual(['ambiguous-rows'])
    // The same bound reached through different forms of since.
    const forms = await check([row("'0.49.0'"), row("['0.48.1', '0.49.0']")].join(','))
    expect(forms.problems.map((p) => p.code)).toEqual(['ambiguous-rows'])
    // Platforms that do not overlap, or different numbers of conditions, are fine.
    const fine = await check(
      [
        row("'0.40.0'", ", platforms: ['codex']"),
        row("'0.40.0'", ", platforms: ['claude-code']"),
        row("'0.40.0'"),
        row("'0.40.0'", ", platforms: ['claude-code'], os: ['macos']"),
      ].join(','),
    )
    expect(fine.problems).toEqual([])
    const overlap = await check(
      [row("'0.40.0'", ", platforms: ['codex', 'x']"), row("'0.40.0'", ", platforms: ['x']")].join(','),
    )
    expect(overlap.problems.map((p) => p.code)).toEqual(['ambiguous-rows'])
  })

  test('a platform row and an os row tie for a reader with both, unless a row with both conditions ranks above', async () => {
    const platformRow = row("'0.40.0'", ", platforms: ['claude-code']")
    const osRow = row("'0.40.0'", ", os: ['macos']")
    const tie = await check([platformRow, osRow].join(','))
    expect(tie.problems.map((p) => p.code)).toEqual(['ambiguous-rows'])
    const both = row("'0.40.0'", ", platforms: ['claude-code'], os: ['macos']")
    expect((await check([platformRow, osRow, both].join(','))).problems).toEqual([])
    // Two pending labels are alternatives, not a tie.
    const pending = [row("'next'", ", pending: 'x'"), row("'next'", ", pending: 'y'")].join(',')
    expect((await check(pending)).problems).toEqual([])
  })

  test('warns, without failing, when no row applies to a reader that names no platform', async () => {
    const r = await check(row("'0.40.0'", ", platforms: ['codex']"))
    expect(r.problems).toEqual([])
    expect(r.warnings.map((w) => w.code)).toEqual(['top-level-content'])
    const none = await check(row("'0.40.0'"))
    expect(none.warnings).toEqual([])
  })

  test('the CLI prints the warning and still exits 0', async () => {
    const dir = makeTmp('rows-cli')
    writeTree(dir, {
      'package.json': pkg,
      'facts/cli/index.ts': entry("{ demo: '1.2.0' }", [
        fact('demo.a', `, variants: [${row("'0.40.0'", ", platforms: ['codex']")}]`),
      ]),
    })
    const r = await cli(['check', '--cwd', dir])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('warning top-level-content')
  })
})
