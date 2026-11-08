import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanTmp, cli, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const PKG = '@up/shapes-facts'
const SPEC = `${PKG}/shapes`

const person = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string' }, age: { type: 'integer' } },
}

const schemaFact = (id: string, content: unknown) => ({
  id,
  tool: 'shapes',
  topics: ['t'],
  title: id,
  content,
  source: { kind: 'published' },
})

/** The installed schema package: an index at `dist/shapes/index.json`, and the given files in `schemas/` beside it. */
function shapesPackage(facts: unknown[], schemas: Record<string, unknown> = {}): Record<string, unknown> {
  const files: Record<string, unknown> = {
    [`node_modules/${PKG}/package.json`]: {
      name: PKG,
      version: '2.0.0',
      exports: { './shapes/index.json': './dist/shapes/index.json' },
    },
    [`node_modules/${PKG}/dist/shapes/index.json`]: {
      indexFormat: '1.1',
      package: PKG,
      entry: 'shapes',
      describes: {},
      facts,
    },
  }
  for (const [file, schema] of Object.entries(schemas))
    files[`node_modules/${PKG}/dist/shapes/schemas/${file}`] = schema
  return files
}

/** A fact of the value package that writes `validatedBy` and the given content or rows. */
const valueFact = (name: string, validatedBy: string | undefined, rest: Record<string, unknown>) => ({
  id: `demo.${name}`,
  tool: 'demo',
  topics: ['t'],
  title: name,
  ...(validatedBy === undefined ? {} : { validatedBy }),
  source: { kind: 'published' },
  ...rest,
})

const entry = (facts: unknown[]) => `export default ${JSON.stringify({ describes: {}, facts })}\n`

interface Run {
  code: number
  problems: { code: string; message: string; location: string | null }[]
  stderr: string
}

async function run(command: 'check' | 'build', files: Record<string, unknown>, args: string[] = []): Promise<Run> {
  const dir = makeTmp('validated-by')
  writeTree(dir, { 'package.json': { name: 'demo-facts', version: '1.0.0', type: 'module' }, ...files })
  const r = await cli([command, '--cwd', dir, ...(command === 'check' ? ['--json'] : []), ...args])
  let problems: Run['problems'] = []
  try {
    problems = JSON.parse(r.stdout).problems
  } catch {
    // exit code 2 prints no JSON
  }
  return { code: r.code, problems, stderr: r.stderr }
}
const check = (files: Record<string, unknown>, args: string[] = []) => run('check', files, args)
const validatedBy = (r: Run) => r.problems.filter((p) => p.code === 'validated-by')
const named = `${SPEC}:shapes.person`

describe('validated-by: check reads the installed package that validatedBy names', () => {
  const installed = (extra: Record<string, unknown> = {}) =>
    shapesPackage([schemaFact('shapes.person', { schema: person })], extra)

  test('scenario 1: a value that fits passes without --index', async () => {
    const r = await check({
      ...installed(),
      'facts/a/index.ts': entry([valueFact('ok', named, { content: { value: { name: 'Ann', age: 3 } } })]),
    })
    expect([r.code, r.problems, r.stderr]).toEqual([0, [], ''])
  })

  test('scenario 2: a field the schema does not list is reported with its name', async () => {
    const r = await check({
      ...installed(),
      'facts/a/index.ts': entry([valueFact('extra', named, { content: { value: { name: 'Ann', nick: 'A' } } })]),
    })
    expect(r.code).toBe(1)
    expect(validatedBy(r)).toHaveLength(1)
    expect(validatedBy(r)[0]?.message).toContain('nick')
    expect(validatedBy(r)[0]?.message).toContain('demo.extra')
    expect(validatedBy(r)[0]?.location).toBe('facts/a/index.ts#/facts/0/content/value')
  })

  test('scenario 2: a missing required field is reported with its name, and a nested path is in the message', async () => {
    const missing = await check({
      ...installed(),
      'facts/a/index.ts': entry([valueFact('lack', named, { content: { value: { age: 3 } } })]),
    })
    expect(missing.code).toBe(1)
    expect(validatedBy(missing)).toHaveLength(1)
    expect(validatedBy(missing)[0]?.message).toContain('"name"')
    const nested = await check({
      ...installed(),
      'facts/a/index.ts': entry([valueFact('type', named, { content: { value: { name: 'Ann', age: 'old' } } })]),
    })
    expect(validatedBy(nested)).toHaveLength(1)
    expect(validatedBy(nested)[0]?.message).toContain('value/age')
  })

  test('scenario 3: a package that is not installed is reported with its name, not skipped', async () => {
    const r = await check({
      'facts/a/index.ts': entry([valueFact('x', named, { content: { value: { name: 'Ann' } } })]),
    })
    expect(r.code).toBe(1)
    expect(validatedBy(r)).toHaveLength(1)
    expect(validatedBy(r)[0]?.message).toContain(SPEC)
  })

  test('scenario 4: a fact id that does not exist, and a fact whose content is a value, are reported', async () => {
    const files = {
      ...shapesPackage([schemaFact('shapes.person', { schema: person }), schemaFact('shapes.plain', { value: 1 })]),
    }
    const unknown = await check({
      ...files,
      'facts/a/index.ts': entry([valueFact('x', `${SPEC}:shapes.nobody`, { content: { value: {} } })]),
    })
    expect([unknown.code, validatedBy(unknown)]).toMatchObject([
      1,
      [{ message: expect.stringContaining('shapes.nobody') }],
    ])
    const plain = await check({
      ...files,
      'facts/a/index.ts': entry([valueFact('x', `${SPEC}:shapes.plain`, { content: { value: {} } })]),
    })
    expect([plain.code, validatedBy(plain)]).toMatchObject([1, [{ message: expect.stringContaining('shapes.plain') }]])
  })

  test('scenario 5: a relative $ref reads schemas/ next to the index of the named package', async () => {
    const withRef = shapesPackage(
      [
        schemaFact('shapes.person', {
          schema: { type: 'object', properties: { name: { $ref: 'schemas/name.json' } } },
        }),
      ],
      { 'name.json': { type: 'string', minLength: 2 } },
    )
    const ok = await check({
      ...withRef,
      'facts/a/index.ts': entry([valueFact('ok', named, { content: { value: { name: 'Ann' } } })]),
    })
    expect([ok.code, ok.problems]).toEqual([0, []])
    const bad = await check({
      ...withRef,
      'facts/a/index.ts': entry([valueFact('bad', named, { content: { value: { name: 'A' } } })]),
    })
    expect(bad.code).toBe(1)
    expect(validatedBy(bad)).toHaveLength(1)
    expect(validatedBy(bad)[0]?.message).toContain('value/name')
  })

  test('a $ref that leaves schemas/, or names a file the package does not ship, is reported and nothing is read', async () => {
    for (const ref of ['schemas/../../../../secret.json', 'schemas//etc/passwd', 'schemas/missing.json']) {
      const r = await check({
        ...shapesPackage([schemaFact('shapes.person', { schema: { $ref: ref } })], {}),
        'facts/a/index.ts': entry([valueFact('x', named, { content: { value: {} } })]),
      })
      expect([ref, r.code, validatedBy(r).length]).toEqual([ref, 1, 1])
    }
  })

  test('a schema that can not be compiled is a validated-by problem, and check does not crash', async () => {
    const r = await check({
      ...shapesPackage([
        schemaFact('shapes.person', { schema: { type: 'object', properties: { a: { $ref: '#/$defs/nope' } } } }),
      ]),
      'facts/a/index.ts': entry([valueFact('x', named, { content: { value: { a: 1 } } })]),
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('')
    expect(validatedBy(r)).toHaveLength(1)
    expect(validatedBy(r)[0]?.message).toContain('can not be compiled')
  })

  test('with variants, the value of every row is checked', async () => {
    const r = await check({
      ...installed(),
      'facts/a/index.ts': entry([
        valueFact('rows', named, {
          variants: [
            { since: '1.0.0', content: { value: { name: 'old', gone: 1 } } },
            { since: '1.1.0', content: { value: { name: 'mid' } } },
            { since: 'next', content: { value: { age: 1 } } },
          ],
        }),
      ]),
    })
    expect(r.code).toBe(1)
    expect(validatedBy(r).map((p) => p.location)).toEqual([
      'facts/a/index.ts#/facts/0/variants/0/content/value',
      'facts/a/index.ts#/facts/0/variants/2/content/value',
    ])
  })

  test('an id with no spec names a fact of the same entry', async () => {
    const schema = {
      id: 'demo.shape',
      tool: 'demo',
      topics: ['t'],
      title: 'shape',
      content: { schema: person },
      source: { kind: 'published' },
    }
    const r = await check({
      'facts/a/index.ts': entry([
        schema,
        valueFact('ok', 'demo.shape', { content: { value: { name: 'Ann' } } }),
        valueFact('bad', 'demo.shape', { content: { value: { name: 1 } } }),
        valueFact('gone', 'demo.none', { content: { value: {} } }),
      ]),
    })
    expect(r.code).toBe(1)
    expect(validatedBy(r).map((p) => p.message.split(':')[0])).toEqual(['demo.bad', 'demo.gone'])
  })

  test('an --index that holds the spec is used before node_modules', async () => {
    const strict = { type: 'object', required: ['name', 'age'] }
    const r = await check(
      {
        ...installed(),
        'other/index.json': {
          indexFormat: '1.1',
          package: PKG,
          entry: 'shapes',
          describes: {},
          facts: [schemaFact('shapes.person', { schema: strict })],
        },
        'facts/a/index.ts': entry([valueFact('x', named, { content: { value: { name: 'Ann' } } })]),
      },
      ['--index', 'other'],
    )
    expect(r.code).toBe(1)
    expect(validatedBy(r)).toHaveLength(1)
    expect(validatedBy(r)[0]?.message).toContain('"age"')
  })

  test('scenario 6: build does not fail when the schema package is not installed', async () => {
    const r = await run(
      'build',
      {
        'facts/a/index.ts': entry([valueFact('x', named, { content: { value: { name: 'Ann' } } })]),
      },
      ['--write-exports'],
    )
    expect([r.code, r.stderr]).toEqual([0, ''])
  })
})

describe('the sample in test/fixtures/validated-by', () => {
  test('a consumer that depends on a shared schema package: the right value passes and the wrong one is reported', async () => {
    const dir = makeTmp('validated-by-sample')
    cpSync(join(import.meta.dirname, 'fixtures/validated-by'), dir, { recursive: true })
    // What the install of `file:../shared` leaves in the consumer.
    linkPackage(join(dir, 'consumer'), '@fixture/shapes', join(dir, 'shared'))
    const r = await cli(['check', '--cwd', join(dir, 'consumer'), '--json'])
    const problems: { code: string; message: string; location: string }[] = JSON.parse(r.stdout).problems
    expect(r.code).toBe(1)
    expect(problems.map((p) => p.code)).toEqual(['validated-by', 'validated-by'])
    expect(problems.every((p) => p.location.startsWith('facts/values/index.ts#/facts/1/'))).toBe(true)
    expect(problems.map((p) => p.message).join('\n')).toContain('values.bad')
  })
})
