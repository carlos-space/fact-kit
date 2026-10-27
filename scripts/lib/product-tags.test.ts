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

// From the version after 0.2.0 on a product tag is vX.Y.Z; product/v0.1.0 and product/v0.2.0 keep their names.
const tags = [
  'product/v0.1.0',
  'product/v0.2.0',
  'v0.3.0',
  'v0.3.1',
  'v0.10.0',
  'fact-kit-js/v0.8.0',
  'fact-kit-py/v0.3.0-alpha.1',
  'v0.4.0-rc.1',
]

describe('product-tags.sh', () => {
  test('lists both tag shapes, newest first, and neither a unit tag nor a tag with a suffix', () => {
    const run = repoWithTags(tags)
    expect(run('product_tags')).toEqual(['v0.10.0', 'v0.3.1', 'v0.3.0', 'product/v0.2.0', 'product/v0.1.0'])
  })

  test('names a new product tag vX.Y.Z and reads the version of either shape', () => {
    const run = repoWithTags([])
    expect(run('product_tag 0.4.0')).toEqual(['v0.4.0'])
    expect(run('product_tag_version v0.4.0; product_tag_version product/v0.2.0')).toEqual(['0.4.0', '0.2.0'])
  })

  test('finds the newest tag of a line, and the existing tag of a version, in either shape', () => {
    const run = repoWithTags(tags)
    expect(run('product_latest_tag 0.3')).toEqual(['v0.3.1'])
    expect(run('product_latest_tag 0.2')).toEqual(['product/v0.2.0'])
    expect(run('product_latest_tag 0.9')).toEqual([''])
    expect(run('product_tag_for 0.2.0')).toEqual(['product/v0.2.0'])
    expect(run('product_tag_for 0.3.0')).toEqual(['v0.3.0'])
    expect(run('product_tag_for 0.7.0 || echo none')).toEqual(['none'])
  })
})
