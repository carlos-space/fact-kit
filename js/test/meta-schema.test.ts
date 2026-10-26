import { describe, expect, test } from 'vitest'
import { validateFact, validateSchemaDocument } from '../src/validate.ts'
import type { Fact } from '../src/types.ts'

const valid: Fact = {
  id: 'mainflow.task-status',
  tool: 'mainflow',
  topics: ['status'],
  title: 'Task statuses',
  content: { value: ['todo', 'doing', 'blocked', 'done', 'dropped'] },
  source: { kind: 'published' },
}

const withSchema = (schema: unknown): unknown => ({
  ...valid,
  id: 'mainflow.config',
  content: { schema },
})

describe('c001 meta-schema', () => {
  test('a valid fact passes, for every content and source form', () => {
    expect(validateFact(valid)).toEqual([])
    expect(
      validateFact({
        id: 'claude-code.hook-exit-2',
        tool: 'claude-code',
        topics: ['hook'],
        title: { en: 'Exit 2', 'zh-TW': '結束碼 2' },
        content: { statement: { 'zh-TW': 'PreToolUse hook 以結束碼 2 結束時，擋下這次工具呼叫' } },
        when: { platforms: ['claude-code'], os: ['macos'], since: '1.0.0', replacement: 'claude-code.hook-exit-3' },
        source: { kind: 'observed', basis: 'doc', url: 'https://docs.example.com/hooks' },
        verify: { probe: { kind: 'hash', anchor: 'exit code 2', hash: 'abc' }, verifiedOn: '2.1.308' },
        ac: ['ac001'],
      }),
    ).toEqual([])
    expect(
      validateFact({
        ...valid,
        id: 'claude-code.hook-events',
        tool: 'claude-code',
        source: { kind: 'converted', from: 'pkg/file.d.ts', converter: 'scripts/convert.ts', upstream: '1.0.0' },
      }),
    ).toEqual([])
  })

  test('an observed source takes fetched and note, and stays valid without them', () => {
    const observed = (source: unknown): unknown => ({ ...valid, id: 'claude-code.thing', tool: 'claude-code', source })
    // The old shape, with neither field.
    expect(validateFact(observed({ kind: 'observed', basis: 'measured' }))).toEqual([])
    expect(validateFact(observed({ kind: 'observed', basis: 'doc', url: 'https://docs.example.com/a' }))).toEqual([])
    expect(
      validateFact(
        observed({ kind: 'observed', basis: 'measured', fetched: '2026-10-12', note: '本機 Claude Code 2.1.285，n=1' }),
      ),
    ).toEqual([])
    expect(
      validateFact(observed({ kind: 'observed', basis: 'spike', note: { en: 'local, n=1', 'zh-TW': '本機，n=1' } })),
    ).toEqual([])
    // Wrong shapes, and the fields on a kind that does not take them.
    expect(validateFact(observed({ kind: 'observed', basis: 'doc', fetched: '' }))).not.toEqual([])
    expect(validateFact(observed({ kind: 'observed', basis: 'doc', note: 3 }))).not.toEqual([])
    expect(validateFact(observed({ kind: 'published', note: 'x' }))).not.toEqual([])
  })

  test('a fact with a schema using every registered x- keyword passes', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        a: {
          type: 'string',
          'x-since': '1.0.0',
          'x-deprecatedIn': '2.0.0',
          'x-removeIn': '3.0.0',
          'x-replacement': 'b',
          'x-platforms': ['claude-code'],
          'x-diagnostic': 'E001',
          'x-defaultRule': 'same as b',
        },
        // A property that happens to be named like an x- keyword is a field, not a keyword.
        'x-field': { type: 'number' },
      },
    }
    expect(validateFact(withSchema(schema))).toEqual([])
  })

  test('a misspelled x- keyword is rejected and named, at any depth', () => {
    const top = validateFact(withSchema({ type: 'object', 'x-sinse': '1.0.0' }))
    expect(top.map((i) => i.message).join('\n')).toContain('x-sinse')
    const nested = validateFact(
      withSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'string', 'x-sinse': '1' } } } }),
    )
    expect(nested).toHaveLength(1)
    expect(nested[0]?.message).toContain('"x-sinse"')
    expect(nested[0]?.pointer).toBe('/content/schema/properties/a/items')
    expect(validateSchemaDocument({ type: 'string', 'x-bogus': 1 })[0]?.message).toContain('x-bogus')
  })

  test('registered x- keywords with the wrong value type are rejected', () => {
    expect(validateSchemaDocument({ type: 'string', 'x-platforms': 'claude-code' })).not.toEqual([])
  })

  test('structural mistakes are rejected', () => {
    expect(validateFact({ ...valid, extra: 1 }).map((i) => i.message)).toContain('unknown property "extra"')
    expect(validateFact({ ...valid, id: 'NoDot' })).not.toEqual([])
    expect(validateFact({ ...valid, content: { value: 1, statement: 'x' } })).not.toEqual([])
    expect(validateFact({ ...valid, source: { kind: 'observed' } })).not.toEqual([])
    expect(validateFact({ ...valid, verify: { probe: { kind: 'manual', reason: 'r' }, verifiedOn: '1' } })).not.toEqual(
      [],
    )
  })
})
