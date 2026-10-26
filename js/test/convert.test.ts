import { afterEach, describe, expect, test } from 'vitest'
import {
  flattenSchema,
  interfaceToJsonSchema,
  readJsonSchemaFile,
  readStringTuples,
  readStringTuplesFromFile,
  schemaRowsToMarkdown,
  validateSchemaDocument,
} from '../src/index.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const DTS = `
export declare const HOOK_EVENTS: readonly ['PreToolUse', "PostToolUse", 'Stop'];
export declare const NOT_A_TUPLE: readonly string[];
export declare const MIXED: readonly ['a', 1];
declare const PRIVATE: readonly ['x'];
export const FROM_VALUE = ['one', 'two'] as const;

/** Settings file. */
export interface Settings {
  /** Model name. */
  model: string;
  retries?: number;
  mode: 'fast' | 'slow';
  nested: { flag: boolean };
  tags?: string[];
}
`

describe('c006 .d.ts reading', () => {
  test('extracts string literal tuples and skips everything else', async () => {
    expect(await readStringTuples(DTS)).toEqual({
      HOOK_EVENTS: ['PreToolUse', 'PostToolUse', 'Stop'],
      FROM_VALUE: ['one', 'two'],
    })
  })

  test('reads a file from disk', async () => {
    const dir = makeTmp('dts')
    writeTree(dir, { 'a.d.ts': DTS })
    expect((await readStringTuplesFromFile(`${dir}/a.d.ts`)).HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'Stop'])
  })

  test('converts an interface to a JSON Schema 2020-12 document with descriptions', async () => {
    const dir = makeTmp('iface')
    writeTree(dir, { 'a.d.ts': DTS })
    const schema = (await interfaceToJsonSchema({ path: `${dir}/a.d.ts`, type: 'Settings' })) as Record<string, any>
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.description).toBe('Settings file.')
    expect(schema.required).toEqual(['model', 'mode', 'nested'])
    expect(schema.properties.model).toEqual({ type: 'string', description: 'Model name.' })
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['fast', 'slow'] })
    expect(schema.properties.tags).toEqual({ type: 'array', items: { type: 'string' } })
    expect(schema.definitions).toBeUndefined()
    expect(validateSchemaDocument(schema)).toEqual([])
  })

  test('descriptions: false removes every description and keeps names, types and enum values', async () => {
    const dir = makeTmp('nodesc')
    writeTree(dir, {
      'a.d.ts':
        "/** Root doc. */\nexport interface Root { /** A doc. */ a: Item; /** The description field. */ description: string; mode: 'x' | 'y' }\n/** Item doc. */\nexport interface Item {\n  /**\n   * Name doc.\n   * @deprecated Use id.\n   */\n  name: string\n}\n",
    })
    const schema = (await interfaceToJsonSchema({
      path: `${dir}/a.d.ts`,
      type: 'Root',
      descriptions: false,
    })) as Record<string, any>
    expect(schema.description).toBeUndefined()
    expect(schema.$defs.Item.description).toBeUndefined()
    expect(schema.$defs.Item.properties.name).toEqual({ type: 'string', deprecated: true })
    expect(Object.keys(schema.properties)).toEqual(['a', 'description', 'mode'])
    expect(schema.properties.description).toEqual({ type: 'string' })
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['x', 'y'] })
    expect(validateSchemaDocument(schema)).toEqual([])
  })

  test('descriptions are kept by default', async () => {
    const dir = makeTmp('withdesc')
    writeTree(dir, { 'a.d.ts': '/** Item doc. */\nexport interface Item {\n  /** Name doc. */\n  name: string\n}\n' })
    const schema = (await interfaceToJsonSchema({ path: `${dir}/a.d.ts`, type: 'Item' })) as Record<string, any>
    expect(schema.description).toBe('Item doc.')
    expect(schema.properties.name.description).toBe('Name doc.')
  })

  test('a tsconfig resolves imports through paths', async () => {
    const dir = makeTmp('tsconfig')
    writeTree(dir, {
      'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } } },
      'lib/item.d.ts': "export interface Item { kind: 'b' | 'a' }\n",
      'a.d.ts': "import type { Item } from '@lib/item'\nexport interface Root { item: Item }\n",
    })
    const schema = (await interfaceToJsonSchema({
      path: `${dir}/a.d.ts`,
      type: 'Root',
      tsconfig: `${dir}/tsconfig.json`,
    })) as Record<string, any>
    expect(schema.$defs.Item.properties.kind.enum).toEqual(['b', 'a'])
  })

  test('additionalProperties: true leaves objects open', async () => {
    const dir = makeTmp('open')
    writeTree(dir, { 'a.d.ts': 'export interface Root { a: string }\n' })
    const closed = (await interfaceToJsonSchema({ path: `${dir}/a.d.ts`, type: 'Root' })) as Record<string, any>
    const open = (await interfaceToJsonSchema({
      path: `${dir}/a.d.ts`,
      type: 'Root',
      additionalProperties: true,
    })) as Record<string, any>
    expect(closed.additionalProperties).toBe(false)
    expect('additionalProperties' in open).toBe(false)
  })

  test('definitions become $defs and refs follow', async () => {
    const dir = makeTmp('refs')
    writeTree(dir, {
      'a.d.ts': 'export interface Item { name: string }\nexport interface Root { a: Item; b: Item }\n',
    })
    const schema = (await interfaceToJsonSchema({ path: `${dir}/a.d.ts`, type: 'Root' })) as Record<string, any>
    expect(Object.keys(schema.$defs)).toEqual(['Item'])
    expect(schema.properties.a).toEqual({ $ref: '#/$defs/Item' })
    expect(validateSchemaDocument(schema)).toEqual([])
    // The table follows the ref.
    expect(flattenSchema(schema).map((r) => r.path)).toEqual(['a', 'a.name', 'b', 'b.name'])
  })
})

describe('c006 JSON Schema file and table', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['model'],
    properties: {
      model: { type: 'string', description: 'Model name.', 'x-since': '1.0.0' },
      mode: { enum: ['fast', 'slow'], 'x-defaultRule': 'fast unless CI is set', 'x-platforms': ['claude-code'] },
      limits: {
        type: 'object',
        required: ['max'],
        properties: { max: { type: 'integer', description: 'Upper bound' }, min: { type: ['integer', 'null'] } },
      },
      list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
      env: { type: 'object', additionalProperties: { type: 'string', description: 'Value' } },
      node: { $ref: '#/$defs/Node' },
      either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    $defs: {
      Node: { type: 'object', properties: { name: { type: 'string' }, next: { $ref: '#/$defs/Node' } } },
    },
  }

  test('reads a JSON Schema file', async () => {
    const dir = makeTmp('schema')
    writeTree(dir, { 'a.schema.json': schema, 'bad.json': '[1]' })
    expect(await readJsonSchemaFile(`${dir}/a.schema.json`)).toEqual(schema)
    await expect(readJsonSchemaFile(`${dir}/bad.json`)).rejects.toThrow('not a JSON Schema')
  })

  test('flattens to rows with path, type, required, description and x- keywords', () => {
    const rows = flattenSchema(schema)
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(rows.map((r) => r.path)).toEqual([
      'model',
      'mode',
      'limits',
      'limits.max',
      'limits.min',
      'list',
      'list[]',
      'list[].id',
      'env',
      'env.*',
      'node',
      'node.name',
      'node.next',
      'either',
    ])
    expect(byPath.model).toEqual({
      path: 'model',
      type: 'string',
      required: true,
      description: 'Model name.',
      extensions: { 'x-since': '1.0.0' },
    })
    expect(byPath.mode).toMatchObject({
      type: 'enum',
      required: false,
      values: ['fast', 'slow'],
      extensions: { 'x-defaultRule': 'fast unless CI is set', 'x-platforms': ['claude-code'] },
    })
    expect(byPath['limits.max']).toMatchObject({ type: 'integer', required: true, description: 'Upper bound' })
    expect(byPath['limits.min']?.type).toBe('integer | null')
    expect(byPath['list[]']?.type).toBe('object')
    expect(byPath['env.*']).toMatchObject({ type: 'string', description: 'Value' })
    // A recursive reference stops at the repeat instead of looping.
    expect(byPath['node.next']).toBeDefined()
    expect(byPath['either']?.type).toBe('string | number')
  })

  test('merges allOf and renders a Markdown table', () => {
    const rows = flattenSchema({
      allOf: [
        { properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'number', 'x-since': '2' } } },
      ],
    })
    expect(rows.map((r) => [r.path, r.required])).toEqual([
      ['a', true],
      ['b', false],
    ])
    expect(schemaRowsToMarkdown(rows)).toBe(
      [
        '| Field | Type | Required | Description | Extensions |',
        '| :--- | :--- | :--- | :--- | :--- |',
        '| `a` | string | yes |  |  |',
        '| `b` | number | no |  | x-since: 2 |',
        '',
      ].join('\n'),
    )
    expect(flattenSchema(true)).toEqual([])
  })

  test('merges oneOf branches told apart by a const property', () => {
    const rows = flattenSchema({
      type: 'object',
      properties: {
        source: {
          oneOf: [
            { type: 'object', required: ['kind'], properties: { kind: { const: 'published' } } },
            {
              type: 'object',
              required: ['kind', 'from'],
              properties: { kind: { const: 'converted' }, from: { type: 'string' } },
            },
            {
              type: 'object',
              required: ['kind', 'basis'],
              properties: {
                kind: { const: 'observed' },
                basis: { enum: ['doc', 'measured'] },
                url: { type: 'string' },
              },
            },
          ],
        },
      },
    })
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]))
    expect(byPath['source.kind']).toMatchObject({
      type: 'enum',
      required: true,
      values: ['published', 'converted', 'observed'],
    })
    expect(byPath['source.kind']?.requiredWhen).toBeUndefined()
    expect(byPath['source.from']).toMatchObject({
      required: false,
      requiredWhen: { path: 'source.kind', values: ['converted'] },
    })
    expect(byPath['source.basis']).toMatchObject({
      values: ['doc', 'measured'],
      requiredWhen: { path: 'source.kind', values: ['observed'] },
    })
    expect(byPath['source.url']).toMatchObject({ required: false })
    expect(byPath['source.url']?.requiredWhen).toBeUndefined()
    const from = byPath['source.from']
    expect(from && schemaRowsToMarkdown([from])).toContain('| when `source.kind` is "converted" |')
  })

  test('without a const discriminator, branch-only fields stay optional', () => {
    const rows = flattenSchema({
      anyOf: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
      ],
    })
    expect(rows.map((r) => [r.path, r.required, r.requiredWhen])).toEqual([
      ['a', false, undefined],
      ['b', false, undefined],
    ])
  })
})
