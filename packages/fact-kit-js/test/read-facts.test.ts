import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFacts } from '../src/index.ts'
import { splitSpec } from '../src/read.ts'
import { FactReadError } from '../src/version.ts'
import { cleanTmp, makeTmp, writeTree } from './helpers.ts'

afterEach(() => {
  vi.restoreAllMocks()
  cleanTmp()
})

const run = promisify(execFile)
const pnpm = (args: string[], cwd: string) => run('pnpm', args, { cwd, env: { ...process.env, CI: 'true' } })

const fact = (id: string, value: unknown) => ({
  id,
  tool: 'demo',
  topics: ['t'],
  title: id,
  content: { value },
  source: { kind: 'published' },
})

/** Packs a one-entry fact package of the given version into `dest` and returns the tarball path. */
async function packFixture(root: string, version: string, facts: unknown[], dest: string): Promise<string> {
  const dir = join(root, `fixture-${version}`)
  writeTree(dir, {
    'package.json': {
      name: '@demo/fixture-facts',
      version,
      type: 'module',
      files: ['dist'],
      exports: { './sdk/index.json': './dist/sdk/index.json' },
    },
    'dist/sdk/index.json': {
      package: '@demo/fixture-facts',
      entry: 'sdk',
      describes: { demo: version },
      facts,
    },
  })
  await pnpm(['pack', '--pack-destination', dest], dir)
  const tarball = readdirSync(dest).find((f) => f.endsWith(`-${version}.tgz`))
  if (!tarball) throw new Error(`no tarball for ${version}`)
  return join(dest, tarball)
}

async function makeHub(root: string, name: string, tarball: string): Promise<string> {
  const hub = join(root, name)
  writeTree(hub, {
    'package.json': { name, private: true, dependencies: { '@demo/fixture-facts': `file:${tarball}` } },
    // Its own workspace root, so pnpm does not treat the hub as a project of this repository.
    'pnpm-workspace.yaml': 'packages: []\n',
  })
  await pnpm(['install', '--ignore-scripts'], hub)
  return hub
}

describe('c004 readFacts', () => {
  test('each hub reads the version its own install pinned', { timeout: 120_000 }, async () => {
    const root = makeTmp('hubs')
    const tarballs = join(root, 'tarballs')
    const v1 = await packFixture(root, '0.0.1', [fact('demo.limit', 1)], tarballs)
    const v2 = await packFixture(root, '0.0.2', [fact('demo.limit', 2), fact('demo.extra', ['x'])], tarballs)
    const hubA = await makeHub(root, 'hub-a', v1)
    const hubB = await makeHub(root, 'hub-b', v2)

    // The installed packages really are different versions.
    const installed = (hub: string) =>
      JSON.parse(readFileSync(join(hub, 'node_modules/@demo/fixture-facts/package.json'), 'utf8')).version
    expect([installed(hubA), installed(hubB)]).toEqual(['0.0.1', '0.0.2'])

    const a = readFacts('@demo/fixture-facts/sdk', { root: hubA })
    const b = readFacts('@demo/fixture-facts/sdk', { root: hubB })
    expect(a.describes).toEqual({ demo: '0.0.1' })
    expect(b.describes).toEqual({ demo: '0.0.2' })
    expect(a.value('demo.limit')).toBe(1)
    expect(b.value('demo.limit')).toBe(2)
    expect(a.facts.map((f) => f.id)).toEqual(['demo.limit'])
    expect(b.facts.map((f) => f.id)).toEqual(['demo.limit', 'demo.extra'])
    expect(a.has('demo.extra')).toBe(false)
    expect(b.get('demo.extra').content).toEqual({ value: ['x'] })
    expect(b.value<string[]>('demo.extra')).toEqual(['x'])
    expect(a.package).toBe('@demo/fixture-facts')
    expect([a.version, b.version]).toEqual(['0.0.1', '0.0.2'])
    expect(a.entry).toBe('sdk')

    // root defaults to process.cwd(), read at call time.
    vi.spyOn(process, 'cwd').mockReturnValue(hubB)
    expect(readFacts('@demo/fixture-facts/sdk').value('demo.limit')).toBe(2)

    // Errors name what is wrong.
    expect(() => a.get('demo.extra')).toThrow('no fact "demo.extra"')
    expect(() => readFacts('@demo/fixture-facts/other', { root: hubA })).toThrow('cannot resolve')
    expect(() => readFacts('@demo/not-installed/sdk', { root: hubA })).toThrow('cannot resolve')
  })

  test('value() refuses facts that carry no value', () => {
    const root = makeTmp('novalue')
    writeTree(root, {
      'package.json': { name: 'hub', private: true },
      'node_modules/pkg-facts/package.json': {
        name: 'pkg-facts',
        version: '1.0.0',
        exports: { './cli/index.json': './index.json' },
      },
      'node_modules/pkg-facts/index.json': {
        package: 'pkg-facts',
        entry: 'cli',
        describes: {},
        facts: [{ ...fact('demo.s', 1), content: { statement: 'x' } }],
      },
    })
    const reader = readFacts('pkg-facts/cli', { root })
    expect(() => reader.value('demo.s')).toThrow('no value content')
  })

  test('checks describes against the packages installed under root', () => {
    const root = makeTmp('describes')
    const factPackage = (version: string, describes: Record<string, string>) => ({
      'node_modules/pkg-facts/package.json': {
        name: 'pkg-facts',
        version,
        exports: { './cli/index.json': './index.json' },
      },
      'node_modules/pkg-facts/index.json': {
        package: 'pkg-facts',
        entry: 'cli',
        describes,
        facts: [fact('demo.a', 1)],
      },
    })
    writeTree(root, {
      'package.json': { name: 'hub', private: true },
      // A product package whose exports leave out ./package.json is still found.
      'node_modules/demo/package.json': { name: 'demo', version: '1.2.0', exports: { '.': './index.js' } },
      ...factPackage('3.0.0', { demo: '1.2.0', 'some-cli': '9.9.9' }),
    })
    // Same version: reads; a product not installed under root (some-cli) is not checked.
    const reader = readFacts('pkg-facts/cli', { root })
    expect(reader.version).toBe('3.0.0')
    expect(reader.value('demo.a')).toBe(1)

    // Another version installed: reading fails and names both versions.
    writeTree(root, factPackage('3.0.1', { demo: '1.1.0' }))
    expect(() => readFacts('pkg-facts/cli', { root })).toThrow('readFacts: pkg-facts/cli describes demo 1.1.0, but')
    expect(() => readFacts('pkg-facts/cli', { root })).toThrow('has demo 1.2.0')

    // The product is found from a parent directory, as Node resolves it.
    const nested = join(root, 'apps', 'site')
    writeTree(nested, { 'package.json': { name: 'site', private: true } })
    expect(() => readFacts('pkg-facts/cli', { root: nested })).toThrow('has demo 1.2.0')
  })

  describe('publish (index 1.2): the npm name of a component whose describes key is a ComponentName', () => {
    const publishTree = (root: string, installed: string, publish: unknown) =>
      writeTree(root, {
        'package.json': { name: 'hub', private: true },
        // describes is keyed by the ComponentName `fact-kit-js`. The npm package is `fact-kit`.
        'node_modules/fact-kit/package.json': { name: 'fact-kit', version: installed },
        'node_modules/fact-kit-js/package.json': { name: 'fact-kit-js', version: '9.9.9' },
        'node_modules/pkg-facts/package.json': {
          name: 'pkg-facts',
          version: '3.0.0',
          exports: { './cli/index.json': './index.json' },
        },
        'node_modules/pkg-facts/index.json': {
          indexFormat: '1.2',
          package: 'pkg-facts',
          entry: 'cli',
          describes: { 'fact-kit-js': '1.2.0' },
          ...(publish === undefined ? {} : { publish }),
          facts: [fact('demo.a', 1)],
        },
      })

    test('target npm: reads when the installed PublishName version equals describes, and returns publish', () => {
      const root = makeTmp('publish-equal')
      publishTree(root, '1.2.0', { target: 'npm', name: 'fact-kit' })
      const reader = readFacts('pkg-facts/cli', { root })
      expect(reader.value('demo.a')).toBe(1)
      expect(reader.publish).toEqual({ target: 'npm', name: 'fact-kit' })
    })

    test('target npm: throws describes-behind when the installed PublishName version is newer', () => {
      const root = makeTmp('publish-newer')
      publishTree(root, '1.3.0', { target: 'npm', name: 'fact-kit' })
      let error: unknown
      try {
        readFacts('pkg-facts/cli', { root })
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(FactReadError)
      expect((error as FactReadError).code).toBe('describes-behind')
      expect((error as Error).message).toContain('has fact-kit 1.3.0')
    })

    test('another target is not checked', () => {
      const root = makeTmp('publish-pypi')
      publishTree(root, '1.3.0', { target: 'pypi', name: 'fact-kit' })
      const reader = readFacts('pkg-facts/cli', { root })
      expect(reader.value('demo.a')).toBe(1)
      expect(reader.publish?.target).toBe('pypi')
    })

    test('without publish the describes key is the package name, as before', () => {
      const root = makeTmp('publish-none')
      // node_modules/fact-kit-js is 9.9.9, newer than describes 1.2.0.
      publishTree(root, '1.2.0', undefined)
      let error: unknown
      try {
        readFacts('pkg-facts/cli', { root })
      } catch (e) {
        error = e
      }
      expect((error as FactReadError).code).toBe('describes-behind')
      expect((error as Error).message).toContain('has fact-kit-js 9.9.9')
      expect(readFacts('pkg-facts/cli', { root, version: 'head' }).publish).toBeUndefined()
    })
  })

  test('splits specs of plain and scoped packages', () => {
    expect(splitSpec('pkg-facts/cli')).toEqual({ packageName: 'pkg-facts', entry: 'cli' })
    expect(splitSpec('@scope/pkg-facts/hooks/events')).toEqual({
      packageName: '@scope/pkg-facts',
      entry: 'hooks/events',
    })
    expect(splitSpec('pkg-facts')).toEqual({ packageName: 'pkg-facts', entry: '' })
    expect(splitSpec('@scope/pkg')).toEqual({ packageName: '@scope/pkg', entry: '' })
    expect(splitSpec('pkg-facts/macos/examples')).toEqual({ packageName: 'pkg-facts', entry: 'macos/examples' })
    expect(() => splitSpec('')).toThrow('not of the form')
    expect(() => splitSpec('@scope')).toThrow('not of the form')
    expect(() => splitSpec('pkg-facts/')).toThrow('not of the form')
  })
})
