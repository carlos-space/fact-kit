import { afterEach, describe, expect, test } from 'vitest'
import { diffFacts, diffIndexFiles } from '../src/index.ts'
import type { Fact } from '../src/index.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const fact = (id: string, value: unknown = 1, extra: Partial<Fact> = {}): Fact => ({
  id,
  tool: 'demo',
  topics: ['t'],
  title: id,
  content: { value },
  source: { kind: 'published' },
  ...extra,
})

const oldFacts = [fact('demo.kept'), fact('demo.edited', 'before'), fact('demo.gone')]
const newFacts = [fact('demo.new'), fact('demo.kept'), fact('demo.edited', 'after')]

describe('c005 diff', () => {
  test('lists added, removed and changed ids', () => {
    expect(diffFacts(oldFacts, newFacts)).toEqual({
      added: ['demo.new'],
      removed: ['demo.gone'],
      changed: ['demo.edited'],
    })
  })

  test('key order and undefined fields do not count as a change; any real field does', () => {
    const reordered = {
      source: { kind: 'published' },
      content: { value: 1 },
      title: 'demo.kept',
      topics: ['t'],
      tool: 'demo',
      id: 'demo.kept',
    } as Fact
    expect(diffFacts([fact('demo.kept')], [reordered])).toEqual({ added: [], removed: [], changed: [] })
    expect(diffFacts([fact('demo.kept')], [fact('demo.kept', 1, { when: { since: '2.0.0' } })]).changed).toEqual([
      'demo.kept',
    ])
    expect(diffFacts([fact('demo.kept', { a: 1, b: 2 })], [fact('demo.kept', { b: 2, a: 1 })]).changed).toEqual([])
  })

  test('reads two index.json files (or their directories), and the CLI prints each class', async () => {
    const dir = makeTmp('diff')
    const index = (facts: Fact[]) => ({ package: 'p', entry: 'e', describes: {}, facts })
    writeTree(dir, { 'v1/index.json': index(oldFacts), 'v2/index.json': index(newFacts) })
    expect(await diffIndexFiles(`${dir}/v1/index.json`, `${dir}/v2`)).toEqual({
      added: ['demo.new'],
      removed: ['demo.gone'],
      changed: ['demo.edited'],
    })
    const text = await cli(['diff', `${dir}/v1`, `${dir}/v2`])
    expect(text.code).toBe(0)
    expect(text.stdout).toBe('added    demo.new\nremoved  demo.gone\nchanged  demo.edited\n')
    const json = await cli(['diff', `${dir}/v1`, `${dir}/v2`, '--json'])
    expect(JSON.parse(json.stdout)).toEqual({ added: ['demo.new'], removed: ['demo.gone'], changed: ['demo.edited'] })
    const none = await cli(['diff', `${dir}/v1`, `${dir}/v1`])
    expect(none.stdout).toBe('no differences\n')
    expect((await cli(['diff', `${dir}/v1`])).code).toBe(2)
  })
})
