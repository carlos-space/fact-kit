// Runs the shared samples in conformance/ against the JS reader. Every other language runs the same files, see
// conformance/README.md. The expected results were written by hand, so a change to the reader that moves one of
// them fails here.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { FactReadError, compareVersions, readFacts, releaseLine, selectFacts } from '../src/index.ts'
import { repoRoot } from './helpers.ts'

const conformance = join(repoRoot, 'conformance')
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))
const dirs = (name: string): string[] =>
  readdirSync(join(conformance, name), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

type Expected = { facts: { id: string; content: unknown; since: unknown; stability?: string }[] } | { error: string }

/** What a reader returns, in the shape of `expected.json`, or the error code it threw. */
function outcome(run: () => { id: string; content: unknown; since: unknown; stability?: string }[]): Expected {
  try {
    const facts = run()
      .map((f) => ({
        id: f.id,
        content: f.content,
        since: f.since,
        ...(f.stability !== undefined ? { stability: f.stability } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { facts }
  } catch (error) {
    if (error instanceof FactReadError) return { error: error.code }
    throw error
  }
}

describe('c002 conformance/cases: selectFacts', () => {
  const cases = dirs('cases')

  test('there are cases, and each has the three files', () => {
    expect(cases.length).toBeGreaterThanOrEqual(80)
    for (const name of cases) {
      for (const file of ['index.json', 'query.json', 'expected.json']) {
        expect(existsSync(join(conformance, 'cases', name, file)), `${name}/${file}`).toBe(true)
      }
    }
  })

  test.each(cases)('%s', (name) => {
    const dir = join(conformance, 'cases', name)
    const query = readJson(join(dir, 'query.json'))
    const got = outcome(() => selectFacts(readJson(join(dir, 'index.json')), query))
    expect(got).toEqual(readJson(join(dir, 'expected.json')))
  })
})

describe('c002 conformance/resolve: readFacts', () => {
  const cases = dirs('resolve')

  test('there are cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15)
  })

  test.each(cases)('%s', (name) => {
    const dir = join(conformance, 'resolve', name)
    const { spec, ...query } = readJson(join(dir, 'query.json'))
    const got = outcome(() => readFacts(spec, { root: join(dir, 'root'), ...query }).facts as never)
    expect(got).toEqual(readJson(join(dir, 'expected.json')))
  })
})

describe('c002 conformance/semver.json', () => {
  const entries: ({ a: string; b: string; expected: number } | { version: string; line: string })[] = readJson(
    join(conformance, 'semver.json'),
  )
  const compares = entries.filter((e): e is { a: string; b: string; expected: number } => 'a' in e)
  const lines = entries.filter((e): e is { version: string; line: string } => 'version' in e)

  test('has comparisons and release lines', () => {
    expect(compares.length).toBeGreaterThan(50)
    expect(lines.length).toBeGreaterThan(5)
  })

  test.each(compares.map((e) => [e.a, e.b, e.expected] as const))('%s against %s is %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  test.each(lines.map((e) => [e.version, e.line] as const))('%s is on line %s', (version, line) => {
    expect(releaseLine(version)).toBe(line)
  })
})
