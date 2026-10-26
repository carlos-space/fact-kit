/** A string, or one string per language. Prompts take `zh-TW` and fall back to `en`. */
export type Text = string | { en?: string; 'zh-TW'?: string }

/** A JSON Schema 2020-12 document or subschema. `x-` keywords are limited to the registered ones. */
export type JsonSchema = boolean | { [keyword: string]: unknown }

/** How an observed fact is re-checked without a model. */
export type FactProbe =
  | { kind: 'hash'; anchor: string; hash: string; url?: string }
  | { kind: 'sample'; path: string }
  | { kind: 'manual'; reason: string }

export type FactContent =
  | { value: unknown } // lists, constants, lookup tables
  | { schema: JsonSchema } // field shapes; may $ref a file under schemas/
  | { statement: Text } // one sentence of behavior

export type FactSource =
  | { kind: 'published' }
  | { kind: 'converted'; from: string; converter: string; upstream: string }
  | {
      kind: 'observed'
      basis: 'doc' | 'measured' | 'spike'
      url?: string
      /** Date the source was read (`YYYY-MM-DD`). Differs from `verify.verifiedOn` when a later check kept the fact. */
      fetched?: string
      /** What was observed on: environment, version and sample size of a measurement, or the sources of a document. */
      note?: Text
    }

export interface Fact {
  /** `<tool>.<name>`, unique across all sources. */
  id: string
  tool: string
  topics: string[]
  title: Text
  /** What it does. Rationale stays in the spec docs. */
  description?: Text
  content: FactContent
  when?: {
    platforms?: string[]
    os?: ('macos' | 'linux' | 'windows')[]
    since?: string
    deprecatedIn?: string
    removeIn?: string
    /** Id of the fact that replaces this one. */
    replacement?: string
  }
  source: FactSource
  /** Observed facts only. */
  verify?: { probe: FactProbe; verifiedOn: string; screenedThrough?: string }
  /** Acceptance criteria backing this fact. */
  ac?: string[]
}

/** What a `facts/<entry>/index.ts` module default-exports. */
export interface FactsModule {
  /** Products this entry describes, with the version, e.g. `{ mainflow: '1.2.0' }`. */
  describes: Record<string, string>
  formatVersion?: string
  facts: Fact[]
}

/** The built `dist/<entry>/index.json`. */
export interface FactIndex extends FactsModule {
  package: string
  entry: string
}

/** One problem found by `check`. `code` is stable, `message` is for people. */
export interface Problem {
  code:
    | 'format'
    | 'duplicate-id'
    | 'id-prefix'
    | 'local-path'
    | 'unregistered-domain'
    | 'unknown-fact-id'
    | 'missing-schema-file'
    | 'load'
  message: string
  /** File, plus a JSON pointer inside it when there is one. */
  location?: string
}
