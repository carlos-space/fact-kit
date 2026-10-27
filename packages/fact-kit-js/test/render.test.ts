import { describe, expect, test } from 'vitest'
import { replaceFactBlocks, valueListToMarkdown } from '../src/index.ts'

const fact = (value: unknown, id = 'demo.list') => ({ id, content: { value } }) as any

describe('valueListToMarkdown', () => {
  test('draws an array of strings as one line per item', () => {
    expect(valueListToMarkdown(fact(['a', 'b']))).toBe('- a\n- b\n')
  })

  test('draws an array of objects as a table', () => {
    expect(valueListToMarkdown(fact([{ name: 'x', note: 'a|b' }, { name: 'y' }]))).toBe(
      '| name | note |\n| :--- | :--- |\n| x | a\\|b |\n| y |  |\n',
    )
  })

  test('picks and orders columns', () => {
    expect(valueListToMarkdown(fact([{ a: 1, b: 2 }]), { columns: ['b'] })).toBe('| b |\n| :--- |\n| 2 |\n')
  })

  test('throws with the fact id when the value is not an array', () => {
    expect(() => valueListToMarkdown(fact({ kinds: [] }, 'demo.obj'))).toThrow(
      /demo\.obj: content\.value is not an array/,
    )
    expect(() => valueListToMarkdown({ id: 'demo.schema', content: { schema: {} } })).toThrow(/demo\.schema/)
  })
})

const doc = (body: string) => `# T\n\n<!-- facts:begin kinds -->\n${body}<!-- facts:end kinds -->\n\ntail\n`

describe('replaceFactBlocks', () => {
  test('replaces the block and reports the change', () => {
    const r = replaceFactBlocks(doc('old\n'), { kinds: '- a\n- b\n' })
    expect(r).toEqual({ text: doc('- a\n- b\n'), changed: true })
  })

  test('reports changed=false when the block is already current', () => {
    const r = replaceFactBlocks(doc('- a\n'), { kinds: '- a\n' })
    expect(r).toEqual({ text: doc('- a\n'), changed: false })
  })

  test('indents the lines like the begin marker and leaves unnamed blocks alone', () => {
    const text =
      '  <!-- facts:begin a -->\n  x\n  <!-- facts:end a -->\n<!-- facts:begin b -->\nkeep\n<!-- facts:end b -->\n'
    expect(replaceFactBlocks(text, { a: '- 1\n\n- 2\n' }).text).toBe(
      '  <!-- facts:begin a -->\n  - 1\n\n  - 2\n  <!-- facts:end a -->\n<!-- facts:begin b -->\nkeep\n<!-- facts:end b -->\n',
    )
  })

  test('throws on begin without end', () => {
    expect(() => replaceFactBlocks('<!-- facts:begin kinds -->\nx\n', { kinds: 'y' })).toThrow(/kinds is never closed/)
  })

  test('throws on a repeated name', () => {
    const one = '<!-- facts:begin kinds -->\n<!-- facts:end kinds -->\n'
    expect(() => replaceFactBlocks(one + one, { kinds: 'y' })).toThrow(/block kinds appears more than once/)
  })

  test('throws on a name missing from the document', () => {
    expect(() => replaceFactBlocks(doc(''), { kinds: 'a', other: 'b' })).toThrow(/no block named other/)
  })

  test('throws on an end without begin', () => {
    expect(() => replaceFactBlocks('<!-- facts:end kinds -->\n', {})).toThrow(/facts:end kinds/)
  })
})

describe('README example script', () => {
  test('generates a block and --check fails on stale content', async () => {
    const { spawnSync } = await import('node:child_process')
    const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const readme = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf8')
    const script = /```js docs-example\n([\s\S]*?)```/.exec(readme)?.[1]
    if (!script) throw new Error('README has no docs-example block')
    const dir = join(resolve(import.meta.dirname, '..', '..', '..'), 'tmp', 'm133', 't004', 'readme-example')
    mkdirSync(join(dir, 'dist', 'sdk'), { recursive: true })
    writeFileSync(
      join(dir, 'dist', 'sdk', 'index.json'),
      JSON.stringify({ facts: [{ id: 'demo.sdk.kinds', content: { value: ['skill', 'agent'] } }] }),
    )
    writeFileSync(join(dir, 'README.md'), '# Demo\n\n<!-- facts:begin kinds -->\nold\n<!-- facts:end kinds -->\n')
    const src = resolve(import.meta.dirname, '..', 'src', 'index.ts')
    writeFileSync(join(dir, 'gen.mts'), script.replace("from 'fact-kit'", `from '${src}'`))
    const run = (...args: string[]) => spawnSync('node', ['gen.mts', ...args], { cwd: dir, encoding: 'utf8' })

    const stale = run('--check')
    expect(stale.status).toBe(1)
    expect(stale.stdout).toContain('out of date')
    expect(run().stdout).toBe('wrote README.md\n')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(
      '# Demo\n\n<!-- facts:begin kinds -->\n- skill\n- agent\n<!-- facts:end kinds -->\n',
    )
    const ok = run('--check')
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('up to date\n')
  })
})
