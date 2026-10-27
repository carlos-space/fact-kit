import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { cleanTmp, cli, linkPackage, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))
const fact = (name: string, more = '') =>
  `{ id: 'a.${name}', tool: 'a', topics: ['t'], title: '${name}', content: { value: 1 }, source: { kind: 'published' }${more} }`

test('relates, factLink and derive come out with the published identity in the aggregate package', async () => {
  const repo = makeTmp('relations-aggregate')
  writeTree(repo, {
    // @npm/a: entry y points at a fact of entry x, by relates and by factLink.
    'a/package.json': { name: '@npm/a', version: '2.0.0', private: true, type: 'module' },
    'a/facts/x/base.ts': `export const base = ${fact('base')}\n`,
    'a/facts/x/index.ts': "import { base } from './base.ts'\nexport default { describes: {}, facts: [base] }\n",
    'a/facts/y/index.ts': [
      `import { factLink } from '${src}'`,
      "import { base } from '../x/base.ts'",
      `const related = ${fact('related', ', relates: [base]')}`,
      `const linked = { ${fact('linked').slice(2, -2)}, content: { statement: \`Same as \${factLink(base)}.\` } }`,
      'export default { describes: {}, facts: [related, linked] }',
      '',
    ].join('\n'),
    // @npm/b derives from @npm/a/x.
    'b/package.json': { name: '@npm/b', version: '0.0.0', private: true, type: 'module' },
    'b/facts/d/index.ts': `import { derive } from '${src}'\nexport default { describes: {}, facts: [derive('@npm/a/x', 'a.base', () => ({ id: 'b.base', tool: 'b' }))] }\n`,
    'agg/package.json': { name: 'demo-facts', version: '1.0.0', type: 'module', files: ['dist'] },
    'agg/fact-kit.config.json': { aggregate: { a: '@npm/a', b: '@npm/b' } },
  })
  linkPackage(join(repo, 'b'), '@npm/a', join(repo, 'a'))
  linkPackage(join(repo, 'agg'), '@npm/a', join(repo, 'a'))
  linkPackage(join(repo, 'agg'), '@npm/b', join(repo, 'b'))
  for (const dir of ['a', 'b', 'agg']) {
    const built = await cli(['build', '--cwd', join(repo, dir), '--write-exports'])
    expect(built.stderr, dir).toBe('')
    expect(built.code, dir).toBe(0)
  }

  // Inside the component the locations carry the component package name.
  expect(readJson(join(repo, 'a/dist/y/index.json')).facts[0].derivedFrom).toEqual(['@npm/a/x:a.base'])

  const dist = join(repo, 'agg/dist')
  const y = readJson(join(dist, 'a/y/index.json'))
  expect(y).toMatchObject({ package: 'demo-facts', entry: 'a/y', component: '@npm/a' })
  expect(y.facts[0].derivedFrom).toEqual(['demo-facts/a/x:a.base'])
  expect(y.facts[1].derivedFrom).toEqual(['demo-facts/a/x:a.base'])
  expect(y.facts[1].content.statement).toBe('Same as demo-facts/a/x:a.base.')

  const d = readJson(join(dist, 'b/index.json')).facts[0]
  expect(d.derivedFrom).toEqual(['demo-facts/a/x:a.base'])
  expect(d.source).toEqual({ kind: 'derived', from: 'demo-facts/a/x', version: '2.0.0' })

  // Nothing but the `component` field names a component package.
  for (const file of ['a/y', 'a/x', 'b']) {
    const text = JSON.stringify(readJson(join(dist, file, 'index.json')).facts)
    expect(text, file).not.toContain('@npm/')
  }
})
