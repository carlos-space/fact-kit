import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { interfaceToJsonSchema } from '../src/index.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterAll(cleanTmp)

// The types claude-code-facts converts from @anthropic-ai/claude-agent-sdk (pinned in devDependencies), with the
// JSON Schema that the fact-kit 0.6.0 converter produced for each one.
interface Fixture {
  sdkVersion: string
  types: Record<string, { file: string; schema: unknown }>
}
const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/agent-sdk-schemas.0.6.0.json', import.meta.url)), 'utf8'),
)
const sdkDir = fileURLToPath(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/', import.meta.url))

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Lists where two schemas differ. Key order does not count, array order does. */
function differences(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: array length ${a.length} -> ${b.length}`)
    for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${path}[${i}]`, out)
  } else if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) out.push(`${path}.${key}: added`)
      else if (!(key in b)) out.push(`${path}.${key}: removed`)
      else differences(a[key], b[key], `${path}.${key}`, out)
    }
  } else out.push(`${path}: changed`)
  return out
}

describe('c001 converting the claude-agent-sdk types on TypeScript 7.1', () => {
  test('the fixture is for the installed sdk version', () => {
    const installed = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version
    expect(installed).toBe(fixture.sdkVersion)
    expect(Object.keys(fixture.types)).toHaveLength(104)
  })

  // 104 conversions, each with its own program: about 4s locally and up to 12s on CI runners
  test('104 types differ from the 0.6.0 output only in the prefixItems of tuples', async () => {
    const dir = makeTmp('agent-sdk')
    const changed: Record<string, string[]> = {}
    for (const [name, { file, schema }] of Object.entries(fixture.types)) {
      writeTree(dir, {
        [`${name}.d.ts`]: `import type { ${name} as T } from '${join(sdkDir, file)}'\nexport type Root = T\n`,
      })
      const converted = await interfaceToJsonSchema({ path: join(dir, `${name}.d.ts`), type: 'Root' })
      const diff = differences(schema, converted)
      if (diff.length) changed[name] = diff
    }
    expect(changed).toEqual({
      // `[string, ...string[]]` keeps its first element as prefixItems and the rest as items
      ArtifactInput: ['$.properties.file_paths.prefixItems: added'],
      // `[Q] | [Q, Q] | ...`: a one-element tuple was `items` and is now `prefixItems`
      AskUserQuestionInput: [
        '$.properties.questions.anyOf[0].items: removed',
        '$.properties.questions.anyOf[0].prefixItems: added',
      ],
      Settings: [
        '$.properties.allowedMcpServers.items.properties.serverCommand.prefixItems: added',
        '$.properties.deniedMcpServers.items.properties.serverCommand.prefixItems: added',
      ],
      ProposeSkillsInput: [
        '$.properties.proposals.anyOf[0].items: removed',
        '$.properties.proposals.anyOf[0].prefixItems: added',
      ],
    })
  }, 60_000)
})

describe('c001 union members keep the order of the source', () => {
  const convert = async (source: string, type = 'Root') => {
    const dir = makeTmp('order')
    writeTree(dir, { 'a.d.ts': source })
    return (await interfaceToJsonSchema({ path: join(dir, 'a.d.ts'), type })) as Record<string, any>
  }

  test('enum members, through arrays, records, tuples and aliases', async () => {
    const schema = await convert(`
export type Status = 'pending' | 'in_progress' | 'completed' | 'deleted'
export type Provider = 'z' | 'a' | 'm'
export interface Root {
  status?: Status
  inline?: 'on' | 'name-only' | 'off'
  list?: ('zeta' | 'alpha' | 'mid')[]
  generic?: Array<'q' | 'b'>
  record: Record<string, 'on' | 'name-only' | 'user-invocable-only' | 'off'>
  index: { [key: string]: 'y' | 'a' }
  pair: ['b' | 'a', 'd' | 'c']
  both: Provider | 'x'
}`)
    expect(schema.$defs.Status.enum).toEqual(['pending', 'in_progress', 'completed', 'deleted'])
    expect(schema.properties.inline.enum).toEqual(['on', 'name-only', 'off'])
    expect(schema.properties.list.items.enum).toEqual(['zeta', 'alpha', 'mid'])
    expect(schema.properties.generic.items.enum).toEqual(['q', 'b'])
    expect(schema.properties.record.additionalProperties.enum).toEqual([
      'on',
      'name-only',
      'user-invocable-only',
      'off',
    ])
    expect(schema.properties.index.additionalProperties.enum).toEqual(['y', 'a'])
    expect(schema.properties.pair.prefixItems.map((p: any) => p.enum)).toEqual([
      ['b', 'a'],
      ['d', 'c'],
    ])
    expect(schema.properties.both.enum).toEqual(['z', 'a', 'm', 'x'])
  })

  test('0 | number keeps both members, and members of anyOf stay in written order', async () => {
    const schema = await convert(`
export interface Root {
  interval?: 0 | number
  mixed: { a: string } | boolean
  other: boolean | { a: string }
}`)
    expect(schema.properties.interval.anyOf).toEqual([{ type: 'number', const: 0 }, { type: 'number' }])
    expect(schema.properties.mixed.anyOf.map((m: any) => m.type)).toEqual(['object', 'boolean'])
    expect(schema.properties.other.anyOf.map((m: any) => m.type)).toEqual(['boolean', 'object'])
  })

  test('tuples become prefixItems, with items for a rest element', async () => {
    const schema = await convert(`
export interface Root { one: [string]; rest: [number, ...string[]]; optional: [string, number?] }`)
    expect(schema.properties.one).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }],
      minItems: 1,
      maxItems: 1,
    })
    expect(schema.properties.rest).toEqual({
      type: 'array',
      prefixItems: [{ type: 'number' }],
      minItems: 1,
      items: { type: 'string' },
    })
    expect(schema.properties.optional.minItems).toBe(1)
    expect(schema.properties.optional.maxItems).toBe(2)
  })
})
