import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { interfaceToJsonSchema, validateSchemaDocument } from '../src/index.ts'
import * as convertModule from '../src/convert.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const fixture = (file: string) => fileURLToPath(new URL(`./fixtures/promptex-plugin/${file}`, import.meta.url))

async function convert(source: string, type: string): Promise<Record<string, any>> {
  const dir = makeTmp('recursive')
  writeTree(dir, { 'a.d.ts': source })
  return (await interfaceToJsonSchema({ path: `${dir}/a.d.ts`, type, descriptions: false })) as Record<string, any>
}

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

describe('interfaceToJsonSchema on types that refer to themselves', () => {
  // The expected documents are what fact-kit 0.4.2 writes for the same input.
  test('a root type that refers to itself is written at the top and as a $defs entry', async () => {
    const schema = await convert('export interface SelfRoot { name: string; next?: SelfRoot }\n', 'SelfRoot')
    const selfRoot = {
      type: 'object',
      properties: { name: { type: 'string' }, next: { $ref: '#/$defs/SelfRoot' } },
      required: ['name'],
      additionalProperties: false,
    }
    expect(schema).toEqual({ $schema: DRAFT, ...selfRoot, $defs: { SelfRoot: selfRoot } })
    expect(validateSchemaDocument(schema)).toEqual([])
  })

  test('an instantiation that refers to itself is a $defs entry named as TypeScript prints it', async () => {
    const schema = await convert(
      'export interface Tree<T> { value: T; children?: Tree<T>[] }\nexport interface UsesTree { t: Tree<string> }\n',
      'UsesTree',
    )
    expect(schema).toEqual({
      $schema: DRAFT,
      type: 'object',
      properties: { t: { $ref: '#/$defs/Tree%3Cstring%3E' } },
      required: ['t'],
      additionalProperties: false,
      $defs: {
        'Tree<string>': {
          type: 'object',
          properties: {
            value: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/$defs/Tree%3Cstring%3E' } },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    })
    expect(validateSchemaDocument(schema)).toEqual([])
  })

  test('every instantiation on a cycle is a $defs entry, and a second use refers to it', async () => {
    const schema = await convert(
      'export interface A<T> { value: T; b?: B<T> }\nexport interface B<T> { a?: A<T> }\nexport interface UsesAB { a: A<string>; again: A<string> }\n',
      'UsesAB',
    )
    expect(schema).toEqual({
      $schema: DRAFT,
      type: 'object',
      properties: { a: { $ref: '#/$defs/A%3Cstring%3E' }, again: { $ref: '#/$defs/A%3Cstring%3E' } },
      required: ['a', 'again'],
      additionalProperties: false,
      $defs: {
        'A<string>': {
          type: 'object',
          properties: { value: { type: 'string' }, b: { $ref: '#/$defs/B%3Cstring%3E' } },
          required: ['value'],
          additionalProperties: false,
        },
        'B<string>': {
          type: 'object',
          properties: { a: { $ref: '#/$defs/A%3Cstring%3E' } },
          additionalProperties: false,
        },
      },
    })
  })

  test('an instantiation that does not refer to itself is written in place', async () => {
    const schema = await convert(
      'export interface Box<T> { v: T }\nexport interface UsesBox { a: Box<string>; b: Box<number> }\n',
      'UsesBox',
    )
    expect(schema).toEqual({
      $schema: DRAFT,
      type: 'object',
      properties: {
        a: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'], additionalProperties: false },
        b: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'], additionalProperties: false },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    })
  })

  test('a generic type that makes a new instantiation at each level throws an error that names it', async () => {
    const error = await convert(
      'export interface Box<T> { v: T }\nexport interface Nest<T> { value: T; next?: Nest<Box<T>> }\nexport interface UsesNest { n: Nest<string> }\n',
      'UsesNest',
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RangeError)
    expect((error as Error).message).toMatch(/\bNest\b/)
  })
})

describe('interfaceToJsonSchema on function members', () => {
  test('a method is left out', async () => {
    const schema = await convert(
      'export interface WithMethod { name: string; run?(n: number): string }\n',
      'WithMethod',
    )
    expect(schema).toEqual({
      $schema: DRAFT,
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    })
  })

  test('a property whose type is a function becomes a $comment with the signature', async () => {
    const schema = await convert(
      'export interface WithFnProp { name: string; run?: (n: number) => string }\n',
      'WithFnProp',
    )
    expect(schema).toEqual({
      $schema: DRAFT,
      type: 'object',
      properties: { name: { type: 'string' }, run: { $comment: '(n: number) => string' } },
      required: ['name'],
      additionalProperties: false,
    })
  })

  test('a method that returns a Promise of the type it is declared in does not recurse', async () => {
    const schema = await convert('export interface Holder { p?: Promise<void>; load(): Promise<Holder> }\n', 'Holder')
    expect(Object.keys(schema.properties)).toEqual(['p'])
  })
})

describe('interfaceToJsonSchema on the promptex-js 1.5.2 declarations', () => {
  // The top-level properties are the ones fact-kit 0.4.2 writes.
  test('converts Plugin', async () => {
    const schema = (await interfaceToJsonSchema({ path: fixture('config.d.ts'), type: 'Plugin' })) as Record<
      string,
      any
    >
    expect(Object.keys(schema.properties).sort()).toEqual([
      'configSchema',
      'configSchemaLocales',
      'kinds',
      'name',
      'version',
    ])
    expect(validateSchemaDocument(schema)).toEqual([])
  })

  test('converts ConfigUnit, which holds plugins', async () => {
    const schema = (await interfaceToJsonSchema({ path: fixture('config.d.ts'), type: 'ConfigUnit' })) as Record<
      string,
      any
    >
    expect(Object.keys(schema.properties).sort()).toEqual([
      'externals',
      'name',
      'outDir',
      'plugins',
      'scope',
      'select',
      'srcDir',
      'targets',
    ])
    expect(validateSchemaDocument(schema)).toEqual([])
  })
})

describe('an error thrown while converting', () => {
  const { withRelease } = convertModule

  test('is not replaced by an error from releasing the resource', async () => {
    let releases = 0
    const failing = withRelease(
      () => {
        releases++
        throw new Error('close failed')
      },
      () => {
        throw new Error('body failed')
      },
    )
    await expect(failing).rejects.toThrow('body failed')
    expect(releases).toBe(1)
  })

  test('an error from releasing is thrown when the body succeeds', async () => {
    const failing = withRelease(
      () => {
        throw new Error('close failed')
      },
      async () => 'done',
    )
    await expect(failing).rejects.toThrow('close failed')
  })

  test('a stack overflow inside the compiler API reaches the caller as a RangeError', async () => {
    // 6000 interfaces in a chain overflow a stack of 2000 to 4000 KB. Whether the overflow breaks the connection
    // to the compiler process depends on where it lands, so the conversion runs with nine stack sizes. When it
    // does, closing the process fails with a protocol error such as `Expected fixed 3-element array`, which used
    // to replace the RangeError for some of the nine.
    const dir = makeTmp('overflow')
    let chain = ''
    for (let i = 0; i < 6000; i++) chain += `export interface D${i} { next: D${i + 1} }\n`
    chain += 'export interface D6000 { end: string }\n'
    const convertUrl = pathToFileURL(fileURLToPath(new URL('../src/convert.ts', import.meta.url))).href
    writeTree(dir, {
      'a.d.ts': chain,
      'run.mjs': `const { interfaceToJsonSchema } = await import(${JSON.stringify(convertUrl)})
try {
  await interfaceToJsonSchema({ path: process.argv[2], type: 'D0' })
  console.log('converted')
} catch (e) {
  console.log(e.name + ': ' + e.message)
}
`,
    })
    const run = promisify(execFile)
    const outcomes: Record<number, string> = {}
    for (let size = 2000; size <= 4000; size += 250) {
      const { stdout } = await run(process.execPath, [`--stack-size=${size}`, `${dir}/run.mjs`, `${dir}/a.d.ts`])
      outcomes[size] = stdout.trim()
    }
    const overflow = 'RangeError: Maximum call stack size exceeded'
    expect(Object.entries(outcomes).filter(([, outcome]) => outcome !== overflow)).toEqual([])
  }, 180_000)
})
