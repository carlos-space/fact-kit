// Shared shape of the facts about the readers in other languages (facts/py, facts/rs, facts/go, facts/swift).
// Each component describes one language with the same four facts, so a test can compare every language with the
// JS reader the same way. The readers are not released yet, so every row is pending under one label.
import type { Fact, FactsModule, ReadErrorCode } from '../js/src/index.ts'

/** The pending label of every reader fact until the first release of the readers. */
export const READERS = 'readers'

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

export interface ReaderApi {
  /** The tool id, also the prefix of every fact id. */
  tool: string
  language: string
  package: {
    registry: string
    name: string
    import: string
    tagPrefix: string
    requires: string
  }
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

function pendingFact(f: Omit<Fact, 'source' | 'variants' | 'content'> & { value: unknown }): Fact {
  const { value, ...rest } = f
  return {
    ...rest,
    content: { value },
    variants: [{ since: 'next', pending: READERS, content: { value } }],
    source: published,
  }
}

/** The four facts of one language and the entry module that holds them. */
export function readerFacts(api: ReaderApi): FactsModule {
  const { tool, language } = api
  const facts: Fact[] = [
    pendingFact({
      id: `${tool}.package`,
      tool,
      topics: ['install'],
      title: { en: `Where the ${language} reader is published` },
      description: { en: 'The registry, the package name, the name code imports, the tag prefix and the toolchain.' },
      value: api.package,
    }),
    pendingFact({
      id: `${tool}.read-facts`,
      tool,
      topics: ['read'],
      title: { en: `${api.read.name} parameters and return value` },
      description: {
        en: 'Each parameter and member names the one of the JS `readFacts` it stands for. `options.onRead` and the check of `describes` against an installed component are JS only.',
      },
      value: api.read,
    }),
    pendingFact({
      id: `${tool}.select-facts`,
      tool,
      topics: ['read', 'select'],
      title: { en: `${api.select.name} parameters` },
      description: { en: 'Chooses the rows of a parsed index for one reader, with the rules of `conformance/`.' },
      value: api.select,
    }),
    pendingFact({
      id: `${tool}.read-errors`,
      tool,
      topics: ['read', 'errors'],
      title: { en: `Error codes of the ${language} reader` },
      description: { en: 'The stable code of each error. The message is for people and can change.' },
      value: api.errors,
    }),
  ]
  return { describes: {}, facts }
}
