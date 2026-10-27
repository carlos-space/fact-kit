// Shared test of the reader components (facts/py, facts/rs, facts/go, facts/swift). It installs one component the
// way the aggregate publishes it, as fact-kit-facts/<component>, and reads it with the JS readFacts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildIndex, readFacts } from '../js/src/index.ts'
import type { FactReader, ReadErrorCode } from '../js/src/index.ts'
import { loadEntries } from '../js/src/load.ts'
import { cleanTmp, makeTmp, writeTree } from '../js/test/helpers.ts'
import kit from './fact-kit/facts/fact-kit/index.ts'
import type { ReaderApi } from './readers-lib.ts'

const factsDir = fileURLToPath(new URL('.', import.meta.url))
const aggregate = JSON.parse(readFileSync(join(factsDir, 'package.json'), 'utf8')) as { name: string; version: string }

const READ_ERROR_CODES: ReadErrorCode[] = ['not-an-index', 'unsupported-index-format', 'not-found', 'invalid-version']
// Only the JS reader has these (m151/d003).
const JS_ONLY = new Set(['options.onRead'])

const jsRead = kit.facts.find((f) => f.id === 'fact-kit.read-facts')?.content as {
  value: { parameters: { name: string }[]; returns: { members: { name: string }[] } }
}

/** A hub with fact-kit-facts installed, holding only this component. */
async function installComponent(component: string): Promise<string> {
  const [entry] = await loadEntries(join(factsDir, component, 'facts'))
  if (!entry) throw new Error(`facts/${component} has no entry`)
  const hub = makeTmp(`readers-${component}`)
  writeTree(hub, {
    'package.json': { name: 'hub', private: true },
    [`node_modules/${aggregate.name}/package.json`]: {
      name: aggregate.name,
      version: aggregate.version,
      exports: { [`./${component}/index.json`]: `./dist/${component}/index.json` },
    },
    [`node_modules/${aggregate.name}/dist/${component}/index.json`]: buildIndex(aggregate.name, entry),
  })
  return hub
}

export function readerSpec(
  component: string,
  pending: { version: 'head'; include: string[] },
  names: { read: string; select: string },
): void {
  const tool = `fact-kit-${component}`
  const spec = `${aggregate.name}/${component}`
  let hub: string
  let reader: FactReader
  beforeAll(async () => {
    hub = await installComponent(component)
    reader = readFacts(spec, { root: hub, ...pending })
  })
  afterAll(() => cleanTmp())

  describe(spec, () => {
    it('a reader on head with the pending label gets the four facts', () => {
      expect(reader.facts.map((f) => f.id).sort()).toEqual(
        ['package', 'read-errors', 'read-facts', 'select-facts'].map((n) => `${tool}.${n}`),
      )
    })

    it('names the read and select functions', () => {
      expect(reader.value<ReaderApi['read']>(`${tool}.read-facts`).name).toBe(names.read)
      expect(reader.value<ReaderApi['select']>(`${tool}.select-facts`).name).toBe(names.select)
    })

    it('maps every parameter and member of the JS readFacts but the JS-only ones', () => {
      const read = reader.value<ReaderApi['read']>(`${tool}.read-facts`)
      const jsParams = jsRead.value.parameters.map((p) => p.name).filter((n) => !JS_ONLY.has(n))
      expect(read.parameters.map((p) => p.js).sort()).toEqual([...jsParams].sort())
      expect(read.returns.members.map((m) => m.js).sort()).toEqual(
        jsRead.value.returns.members.map((m) => m.name).sort(),
      )
      const select = reader.value<ReaderApi['select']>(`${tool}.select-facts`)
      expect(select.parameters.map((p) => p.js).sort()).toEqual(
        ['index', ...jsParams.filter((n) => n !== 'spec' && n !== 'options.root')].sort(),
      )
    })

    it('maps the four error codes of the JS reader', () => {
      const errors = reader.value<ReaderApi['errors']>(`${tool}.read-errors`)
      expect(errors.codes.map((c) => c.code)).toEqual(READ_ERROR_CODES)
    })

    it('a reader without the label, or on the latest release, gets none of them', () => {
      expect(readFacts(spec, { root: hub, version: 'head' }).facts).toEqual([])
      expect(readFacts(spec, { root: hub }).facts).toEqual([])
    })
  })
}
