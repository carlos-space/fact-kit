// Shared shape of the facts about the readers in other languages (facts/fact-kit-py, facts/fact-kit-rs, facts/fact-kit-go, facts/fact-kit-swift).
// Each component describes one language with the same four facts, so a test can compare every language with the
// JS reader the same way. Each component passes the version of its first release as `since`.
import type { Fact, FactsModule, ReadErrorCode } from '../../packages/fact-kit-js/src/index.ts'
import type { PublishInfo } from '../../packages/fact-kit-js/src/types.ts'

export interface ReaderParam {
  name: string
  /** The parameter of the JS `readFacts` or `selectFacts` it stands for, as the JS facts name it. */
  js: string
  type: string
  required: boolean
  default?: string
}

export interface ReaderMember {
  name: string
  /** The member of the JS reader it stands for. */
  js: string
}

export interface ReaderPackage {
  registry: string
  name: string
  import: string
  /** The tag prefix of the repository the user installs from. In a mirror repository that is the mirror's own tag. */
  tagPrefix: string
  /** The tag prefix in this repository for a component published through a mirror. Left out when the user installs from this repository. */
  sourceTagPrefix?: string
  requires: string
}

export interface ReaderPackageRow {
  since: string
  value: ReaderPackage
}

export interface ReaderApi {
  /** The tool id, also the prefix of every fact id. */
  tool: string
  language: string
  /** Where the component is published and its PublishName, which the index records as `publish`. */
  publish: PublishInfo
  /** One value, or one per identity when the package moved: rows in ascending `since`, the last one is the current. */
  package: ReaderPackage | ReaderPackageRow[]
  read: {
    name: string
    signature: string
    parameters: ReaderParam[]
    returns: { type: string; members: ReaderMember[] }
  }
  select: {
    name: string
    signature: string
    parameters: ReaderParam[]
    returns: string
  }
  errors: {
    type: string
    /** How a caller gets the code string. */
    code: string
    /** One entry per code of the JS `ReadErrorCode`, in its order. */
    codes: { code: ReadErrorCode; variant: string }[]
  }
}

const published = { kind: 'published' } as const

/** `rows` are the values of the fact in ascending `since`. The last one is the current `content`. */
function readerFact(rows: { since: string; value: unknown }[], f: Omit<Fact, 'source' | 'variants' | 'content'>): Fact {
  const current = rows[rows.length - 1]!
  return {
    ...f,
    content: { value: current.value },
    variants: rows.map((r) => ({ since: r.since, content: { value: r.value } })),
    source: published,
  }
}

/** The four facts of one language and the entry module that holds them, all since the version of its first release. */
export function readerFacts(api: ReaderApi, since: string): FactsModule {
  const { tool, language } = api
  const one = (value: unknown) => [{ since, value }]
  const packageRows = Array.isArray(api.package) ? api.package : [{ since, value: api.package }]
  if (packageRows[0]?.since !== since) throw new Error(`${tool}.package: the first row must start at ${since}`)
  const facts: Fact[] = [
    readerFact(packageRows, {
      id: `${tool}.package`,
      tool,
      topics: ['install'],
      title: { en: `Where the ${language} reader is published` },
      description: {
        en: 'The registry, the package name, the name code imports, the tag prefix and the toolchain. A package that moved has one value per identity.',
      },
    }),
    readerFact(one(api.read), {
      id: `${tool}.read-facts`,
      tool,
      topics: ['read'],
      title: { en: `${api.read.name} parameters and return value` },
      description: {
        en: 'Each parameter and member names the one of the JS `readFacts` it stands for. `options.onRead` and the check of `describes` against an installed component are JS only.',
      },
    }),
    readerFact(one(api.select), {
      id: `${tool}.select-facts`,
      tool,
      topics: ['read', 'select'],
      title: { en: `${api.select.name} parameters` },
      description: { en: 'Chooses the rows of a parsed index for one reader, with the rules of `conformance/`.' },
    }),
    readerFact(one(api.errors), {
      id: `${tool}.read-errors`,
      tool,
      topics: ['read', 'errors'],
      title: { en: `Error codes of the ${language} reader` },
      description: { en: 'The stable code of each error. The message is for people and can change.' },
    }),
  ]
  return { describes: {}, publish: api.publish, facts }
}
