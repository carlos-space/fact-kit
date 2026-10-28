import { describe, expect, it } from 'vitest'
import { normalizeSchema } from '../src/index.ts'

describe('normalizeSchema', () => {
  it('moves draft-07 and OpenAPI 3.0 forms to 2020-12 without touching property names', () => {
    const out = normalizeSchema(
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://example.com/x.json',
        definitions: { a: { type: 'string', nullable: true } },
        properties: {
          items: { $ref: '#/definitions/a' },
          deprecated: { type: 'string' },
          pair: { items: [{ type: 'string' }, { type: 'number' }], additionalItems: false, deprecated: 'use y' },
          id: { type: 'string', 'x-vendor': 1 },
        },
        dependencies: { items: ['deprecated'] },
      } as never,
      {},
    ) as any
    expect(out.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(out.$id).toBeUndefined()
    expect(out.$defs.a.type).toEqual(['string', 'null'])
    expect(out.properties.items.$ref).toBe('#/$defs/a')
    expect(out.properties.deprecated).toEqual({ type: 'string' })
    expect(out.properties.pair).toMatchObject({
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
      deprecated: true,
    })
    expect(out.properties.pair.description).toBe('Deprecated: use y')
    expect(out.properties.id).toEqual({ type: 'string' })
    expect(out.dependentRequired).toEqual({ items: ['deprecated'] })
  })
})
