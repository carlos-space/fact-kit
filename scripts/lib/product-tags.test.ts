import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

// product-tags.sh reads the tags of the repository it runs in, so each case builds a throwaway git repo with
// the tags under test and sources the library from this repository.
const lib = join(import.meta.dirname, 'product-tags.sh')
const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function repoWithTags(tags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'product-tags-'))
  made.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'fixture')
  for (const tag of tags) git('tag', tag)
  return (call: string) =>
    execFileSync('bash', ['-c', `source ${lib}; ${call}`], { cwd: dir, encoding: 'utf8' })
      .trim()
      .split('\n')
}

const tags = [
  'v0.1.0',
  'v0.2.0',
  'v0.3.0',
  'v0.3.1',
  'v0.10.0',
  'fact-kit-js/v0.8.0',
  'fact-kit-py/v0.3.0-alpha.1',
  'v0.4.0-rc.1',
]

describe('product-tags.sh', () => {
  test('lists vX.Y.Z tags newest first, and neither a unit tag nor a tag with a suffix', () => {
    const run = repoWithTags(tags)
    expect(run('product_tags')).toEqual(['v0.10.0', 'v0.3.1', 'v0.3.0', 'v0.2.0', 'v0.1.0'])
  })

  test('ignores the old product/vX.Y.Z shape', () => {
    const run = repoWithTags(['product/v0.2.0', 'v0.3.0'])
    expect(run('product_tags')).toEqual(['v0.3.0'])
  })

  test('names a new product tag vX.Y.Z', () => {
    const run = repoWithTags([])
    expect(run('product_tag 0.4.0')).toEqual(['v0.4.0'])
  })

  test('finds the newest tag of a line', () => {
    const run = repoWithTags(tags)
    expect(run('product_latest_tag 0.3')).toEqual(['v0.3.1'])
    expect(run('product_latest_tag 0.2')).toEqual(['v0.2.0'])
    expect(run('product_latest_tag 0.9')).toEqual([''])
  })
})
