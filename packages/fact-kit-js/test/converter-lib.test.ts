import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DRAFT_2020_12, readPinned, sourceUrl, stableJson, writeFormatted, type PinnedSource } from '../src/index.ts'
import { loadPeer } from '../src/peer.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('stableJson', () => {
  test('sorts object keys at every depth and keeps array order', () => {
    expect(stableJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}',
    )
  })
})

describe('DRAFT_2020_12', () => {
  test('is the 2020-12 schema URL', () => {
    expect(DRAFT_2020_12).toBe('https://json-schema.org/draft/2020-12/schema')
  })
})

describe('writeFormatted', () => {
  test('formats with the prettier config next to the file and creates parent directories', async () => {
    const dir = makeTmp('fmt')
    writeTree(dir, { '.prettierrc.json': { semi: false, singleQuote: true } })
    const file = join(dir, 'a', 'b.ts')
    await writeFormatted(file, 'const x = "1";')
    expect(readFileSync(file, 'utf8')).toBe("const x = '1'\n")
  })

  test('a missing optional peer dependency throws an error that names what to install', async () => {
    await expect(loadPeer('fact-kit-test-not-installed', 'prettier', 'writeFormatted')).rejects.toThrow(
      /writeFormatted needs the optional peer dependency prettier\. Install it with: pnpm add -D prettier@3/,
    )
  })
})

describe('sourceUrl and readPinned', () => {
  const text = 'hello pinned\n'
  const source: PinnedSource = {
    repo: 'owner/name',
    commit: 'a'.repeat(40),
    path: 'dir/file.json',
    sha256: sha(text),
    license: 'MIT',
  }

  test('sourceUrl points at the file at the pinned commit', () => {
    expect(sourceUrl(source)).toBe(`https://github.com/owner/name/blob/${'a'.repeat(40)}/dir/file.json`)
  })

  test('a cache hit reads <cacheDir>/<sha256>.txt without downloading', async () => {
    const cacheDir = makeTmp('cache')
    writeTree(cacheDir, { [`${source.sha256}.txt`]: text })
    expect(await readPinned(source, { cacheDir })).toBe(text)
  })

  test('a cached file with another sha256 throws', async () => {
    const cacheDir = makeTmp('cache')
    writeTree(cacheDir, { [`${source.sha256}.txt`]: 'tampered' })
    await expect(readPinned(source, { cacheDir })).rejects.toThrow(
      `owner/name/dir/file.json: sha256 is ${sha('tampered')}, expected ${source.sha256}`,
    )
  })

  test('a download is verified and written to the cache', async () => {
    const cacheDir = makeTmp('cache-new')
    const original = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response(text)
    }) as typeof fetch
    try {
      expect(await readPinned(source, { cacheDir })).toBe(text)
    } finally {
      globalThis.fetch = original
    }
    expect(urls).toEqual([`https://raw.githubusercontent.com/owner/name/${'a'.repeat(40)}/dir/file.json`])
    expect(existsSync(join(cacheDir, `${source.sha256}.txt`))).toBe(true)
  })

  test('a download with another sha256 throws and is not cached', async () => {
    const cacheDir = makeTmp('cache-bad')
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('other')) as typeof fetch
    try {
      await expect(readPinned(source, { cacheDir })).rejects.toThrow(/sha256 is .*, expected /)
    } finally {
      globalThis.fetch = original
    }
    expect(existsSync(join(cacheDir, `${source.sha256}.txt`))).toBe(false)
  })
})
