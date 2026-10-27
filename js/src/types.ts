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
  /** Derived from a fact of another package: `from` is its spec, `version` the version of that package installed at build. */
  | { kind: 'derived'; from: string; version: string }
  | {
      kind: 'observed'
      basis: 'doc' | 'measured' | 'spike'
      url?: string
      /** Date the source was read (`YYYY-MM-DD`). Differs from `verify.verifiedOn` when a later check kept the fact. */
      fetched?: string
      /** What was observed on: environment, version and sample size of a measurement, or the sources of a document. */
      note?: Text
    }

/**
 * When a row of a fact starts to apply: a released version (`0.49.0`, a pre-release such as `0.49.0-alpha.1`),
 * `'next'` for the release that is not out yet, or one version per release line (`X.Y`) written as an array.
 * The array may end in `'next'`, e.g. `['0.48.1', 'next']`.
 */
export type Since = string | string[]

export type Os = 'macos' | 'linux' | 'windows'

/** One row of a fact whose content changed over versions or differs by platform. */
export interface FactVariant {
  since: Since
  content: FactContent
  /** Planned content that is not in the next release. Only a reader on `head` that includes the label sees it. */
  pending?: string
  stability?: 'experimental'
  platforms?: string[]
  os?: Os[]
}

export interface Fact {
  /** `<tool>.<name>`, unique across all sources. */
  id: string
  tool: string
  topics: string[]
  title: Text
  /** What it does. Rationale stays in the spec docs. */
  description?: Text
  /**
   * The content of a fact without `variants`. With `variants` the build replaces it with the latest published
   * content, which is what a reader of format 1.0 sees.
   */
  content: FactContent
  /** Rows by version, platform and stability. Without it the whole fact is one row that starts at `when.since`. */
  variants?: FactVariant[]
  /** Fact locations (`<id>` or `<spec>:<id>`) this fact is computed from. */
  derivedFrom?: string[]
  when?: {
    platforms?: string[]
    os?: Os[]
    since?: Since
    deprecatedIn?: string
    removeIn?: string
    /** Id, or ids, of the facts that replace this one. */
    replacement?: string | string[]
    /** `<spec>:<id>`: where this fact moved to, when it is in another package or entry. */
    movedTo?: string
  }
  source: FactSource
  /** Observed facts only. */
  verify?: { probe: FactProbe; verifiedOn: string; screenedThrough?: string }
}

/**
 * A fact as an author writes it in `facts/<entry>/index.ts`. `variants` is usually the result of `history(...)`,
 * `relates` takes other fact objects of the same package, and `content` may be left out when there are `variants`.
 * The build turns it into a {@link Fact}.
 */
export interface FactDecl extends Omit<Fact, 'content'> {
  content?: FactContent
  /** Other facts of this package this one is computed from. The build lists them in `derivedFrom`. */
  relates?: readonly FactLike[]
}

/** What `derive(...)` returns: a fact computed from a fact of another package, resolved at build. */
export interface DerivedFact {
  readonly spec: string
  readonly id: string
  readonly map?: (upstream: Fact) => Partial<FactDecl>
}

/** Anything that can stand for a fact in `relates` and `factLink`. */
export type FactLike = Fact | FactDecl | DerivedFact

/** What a `facts/<entry>/index.ts` module default-exports, as written. */
export interface FactsSource {
  describes: Record<string, string>
  formatVersion?: string
  facts: (FactDecl | DerivedFact)[]
}

/** The facts of one entry after the build has expanded `history`, `relates`, `factLink` and `derive`. */
export interface FactsModule {
  /** The one component this entry describes and the latest published version it covers, e.g. `{ mainflow: '1.2.0' }`. */
  describes: Record<string, string>
  formatVersion?: string
  facts: Fact[]
}

/** The built `dist/<entry>/index.json`. */
export interface FactIndex extends FactsModule {
  /** `1.1` for what this version writes. A missing field reads as `1.0`. */
  indexFormat?: string
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
    | 'describes'
    | 'since-format'
    | 'ambiguous-rows'
    | 'top-level-content'
    | 'load'
    | 'history'
    | 'relates-foreign'
    | 'derive'
    | 'derive-version'
    | 'same-line'
    | 'relation-cycle'
    | 'lib-rows'
    | 'since-ahead'
    | 'train-next'
    | 'pending-untested'
    | 'doc-unknown-id'
    | 'impl-imports-facts'
    | 'impl-reads-facts-dist'
    | 'impl-depends-on-facts'
    | 'builder'
    | 'subset-of'
  message: string
  /** File, plus a JSON pointer inside it when there is one. */
  location?: string
}
