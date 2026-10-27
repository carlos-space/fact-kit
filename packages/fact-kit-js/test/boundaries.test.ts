import { describe, expect, test } from 'vitest'
import { ambiguousRows, boundaryReaders, factRows, pairRows } from '../src/select.ts'
import type { Fact, FactVariant } from '../src/index.ts'

const fact = (id: string, variants: FactVariant[]): Fact => ({
  id,
  tool: 'demo',
  topics: [],
  title: id,
  content: variants[0]?.content ?? { value: [] },
  variants,
  source: { kind: 'published' },
})
const row = (since: FactVariant['since'], value: unknown, extra: Partial<FactVariant> = {}): FactVariant => ({
  since,
  content: { value },
  ...extra,
})
const labels = (fact: Fact) =>
  boundaryReaders(factRows(fact)).map(({ reader, ctx }) => [
    reader.kind === 'version' ? `${reader.v.major}.${reader.v.minor}.${reader.v.patch}` : reader.kind,
    ctx.platform,
    ctx.os,
    ctx.include,
  ])

describe('c003 boundaryReaders', () => {
  test('names head, latest and, for each version a row names, that version, the next patch and the next line', () => {
    const f = fact('demo.a', [row('1.2.0', [1]), row('1.3.0', [2])])
    const versions = new Set(labels(f).map((l) => l[0]))
    expect(versions).toEqual(new Set(['head', 'latest', '1.2.0', '1.2.1', '1.3.0', '1.3.1', '1.4.0']))
  })

  test('combines every platform, os and pending label the rows name with none and with one no row names', () => {
    const f = fact('demo.a', [
      row('1.0.0', [1]),
      row('1.1.0', [2], { platforms: ['codex'], os: ['macos'] }),
      row('1.2.0', [3], { pending: 'beta' }),
    ])
    const head = labels(f).filter((l) => l[0] === 'head')
    const platforms = new Set(head.map((l) => l[1]))
    expect(platforms).toEqual(new Set([undefined, '\0other', 'codex']))
    expect(new Set(head.map((l) => l[2]))).toEqual(new Set([undefined, '\0other', 'macos']))
    expect(new Set(head.map((l) => JSON.stringify(l[3])))).toEqual(new Set(['[]', '["beta"]']))
    expect(head).toHaveLength(3 * 3 * 2)
  })

  test('takes the rows of two facts together', () => {
    const a = fact('demo.a', [row('1.0.0', [1])])
    const b = fact('demo.b', [row('2.0.0', [1])])
    const versions = new Set(boundaryReaders([...factRows(a), ...factRows(b)]).map((r) => (r.reader as any).v?.major))
    expect(versions).toEqual(new Set([undefined, 1, 2]))
  })

  test('ambiguousRows still finds two rows nothing ranks above the other', () => {
    expect(ambiguousRows(fact('demo.a', [row('next', [1]), row('next', [2])]))).toEqual([0, 1])
    expect(ambiguousRows(fact('demo.a', [row('1.0.0', [1]), row('next', [2])]))).toBeUndefined()
    // Only a platform that no row names can tell the rows apart from the one that names it.
    expect(
      ambiguousRows(fact('demo.a', [row('1.0.0', [1], { platforms: ['x'] }), row('1.0.0', [2], { platforms: ['y'] })])),
    ).toBeUndefined()
    expect(
      ambiguousRows(fact('demo.a', [row('1.0.0', [1], { os: ['linux'] }), row('1.0.0', [2], { os: ['linux'] })])),
    ).toEqual([0, 1])
  })
})

describe('c003 pairRows', () => {
  const a = fact('demo.a', [row('1.0.0', ['x']), row('2.0.0', ['x', 'y'])])
  const b = fact('demo.b', [row('1.5.0', ['x', 'y', 'z'])])

  test('picks the row of each fact that applies at every boundary of either', () => {
    const paired = pairRows(a, b)
    const at = (version: string) =>
      paired.find((p) => p.version === version && !p.platform && !p.os && p.include.length === 0)
    expect(at('1.0.0')).toMatchObject({ a: { index: 0 }, b: undefined })
    expect(at('1.5.0')).toMatchObject({ a: { index: 0 }, b: { index: 0 } })
    expect(at('2.0.0')).toMatchObject({ a: { index: 1 }, b: { index: 0 } })
    expect(at('head')).toMatchObject({ a: { index: 1 }, b: { index: 0 } })
    expect(at('latest')).toMatchObject({ a: { index: 1 }, b: { index: 0 } })
  })

  test('lists each combination once and names an unmentioned platform other', () => {
    const paired = pairRows(a, b)
    const keys = paired.map((p) => JSON.stringify([p.version, p.platform, p.os, p.include]))
    expect(new Set(keys).size).toBe(keys.length)
    expect(paired.some((p) => p.platform === 'other' && p.os === 'other')).toBe(true)
  })

  test('picks the row with the platform condition only for a reader that names it', () => {
    const c = fact('demo.c', [row('1.0.0', ['p']), row('1.0.0', ['q'], { platforms: ['codex'] })])
    const paired = pairRows(c, b)
    const head = paired.filter((p) => p.version === 'head' && !p.os && p.include.length === 0)
    expect(head.find((p) => p.platform === 'codex')?.a?.index).toBe(1)
    expect(head.find((p) => !p.platform)?.a?.index).toBe(0)
    expect(head.find((p) => p.platform === 'other')?.a?.index).toBe(0)
  })

  test('skips the readers of a fact whose since is not a version', () => {
    const bad = fact('demo.bad', [row('not-a-version', [1])])
    expect(() => pairRows(bad, b)).not.toThrow()
  })
})
