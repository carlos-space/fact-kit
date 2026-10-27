import { FactReadError, compareLines, compareSemver, mustParse, parseVersion } from './version.ts'
import type { Semver } from './version.ts'
import type { Fact, FactContent, FactIndex, FactVariant, Since } from './types.ts'

export interface SelectOptions {
  /**
   * The version of the described component the reader runs, or `'head'` for the unreleased state. Without it
   * the reader is newer than every released version, so it gets the latest published content.
   */
  version?: string
  /** Labels of `pending` rows a reader on `head` also gets. */
  include?: readonly string[]
  /** A row with a `platforms` condition applies only when the reader names a platform it lists. */
  platform?: string
  /** A row with an `os` condition applies only when the reader names an os it lists. */
  os?: string
}

/** A fact as one reader sees it: the row that applies is flattened into `content`, `since` and `stability`. */
export type SelectedFact = Fact & {
  /** The `since` of the row that was chosen. `0.0.0` when the row has none and so always applies. */
  since: Since
  stability?: 'experimental'
}

/** What `since` reads as when a row does not have one. */
export const NO_SINCE = '0.0.0'

export type Reader = { kind: 'head' } | { kind: 'latest' } | { kind: 'version'; v: Semver }

/** The version a row starts at, seen from one reader: -inf, a version, or +inf (`next`). */
type Bound = { kind: 'min' } | { kind: 'max' } | { kind: 'version'; v: Semver }

const MIN: Bound = { kind: 'min' }
const MAX: Bound = { kind: 'max' }
const RANK = { min: 0, version: 1, max: 2 } as const

function compareBounds(a: Bound, b: Bound): number {
  if (a.kind !== b.kind) return RANK[a.kind] - RANK[b.kind]
  return a.kind === 'version' && b.kind === 'version' ? compareSemver(a.v, b.v) : 0
}

export interface Row {
  since: Since | undefined
  content: FactContent
  pending?: string
  stability?: 'experimental'
  platforms?: string[]
  os?: string[]
}

/** The rows of a fact. Without `variants` the whole fact is one row that starts at `when.since`. */
function rowsOf(fact: Fact): Row[] {
  if (Array.isArray(fact.variants)) {
    return fact.variants
      .filter((v): v is FactVariant => !!v && typeof v === 'object')
      .map((v) => ({
        since: v.since,
        content: v.content,
        ...(v.pending !== undefined ? { pending: v.pending } : {}),
        ...(v.stability !== undefined ? { stability: v.stability } : {}),
        ...(v.platforms !== undefined ? { platforms: v.platforms } : {}),
        ...(v.os !== undefined ? { os: v.os } : {}),
      }))
  }
  return [
    {
      since: fact.when?.since,
      content: fact.content,
      ...(fact.when?.platforms !== undefined ? { platforms: fact.when.platforms } : {}),
      ...(fact.when?.os !== undefined ? { os: fact.when.os } : {}),
    },
  ]
}

function boundOf(since: Since | undefined, reader: Reader, id: string): Bound | undefined {
  if (since === undefined) return MIN
  const what = `fact ${id}: since`
  if (since === 'next') return reader.kind === 'head' ? MAX : undefined
  if (typeof since === 'string') {
    const s = mustParse(since, what)
    if (reader.kind === 'version') return compareSemver(reader.v, s) >= 0 ? { kind: 'version', v: s } : undefined
    return { kind: 'version', v: s }
  }
  if (!Array.isArray(since)) throw new FactReadError('invalid-version', `${what} must be a string or an array`)
  const hasNext = since.includes('next')
  const versions = since.filter((s) => s !== 'next').map((s) => mustParse(s, what))
  if (versions.length === 0) return reader.kind === 'head' ? MAX : undefined
  const newest = versions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b))
  if (reader.kind === 'version') {
    const same = versions.find((s) => compareLines(s, reader.v) === 0)
    if (same) return compareSemver(reader.v, same) >= 0 ? { kind: 'version', v: same } : undefined
    // No version on the reader's line: the row applies once the reader's line is newer than all of them.
    return versions.every((s) => compareLines(reader.v, s) > 0) ? { kind: 'version', v: newest } : undefined
  }
  return reader.kind === 'head' && hasNext ? MAX : { kind: 'version', v: newest }
}

export interface Context {
  include: readonly string[]
  platform: string | undefined
  os: string | undefined
  /** Skip the platform and pending conditions, as the last fallback for the top-level content does. */
  ignoreConditions?: boolean
}

const specificity = (row: Row) => (row.platforms ? 1 : 0) + (row.os ? 1 : 0)

export interface Candidate {
  row: Row
  index: number
  bound: Bound
}

/** The rows that apply to the reader, each with its bound. */
function candidates(rows: readonly Row[], reader: Reader, ctx: Context, id: string): Candidate[] {
  const out: Candidate[] = []
  for (const [index, row] of rows.entries()) {
    if (!ctx.ignoreConditions) {
      if (row.pending !== undefined && !(reader.kind === 'head' && ctx.include.includes(row.pending))) continue
      if (row.platforms && (ctx.platform === undefined || !row.platforms.includes(ctx.platform))) continue
      if (row.os && (ctx.os === undefined || !row.os.includes(ctx.os))) continue
    }
    const bound = boundOf(row.since, reader, id)
    if (bound) out.push({ row, index, bound })
  }
  return out
}

/** Larger bound first, then more conditions. */
const rank = (a: Candidate, b: Candidate): number =>
  compareBounds(a.bound, b.bound) || specificity(a.row) - specificity(b.row)

/** The row that applies: the largest bound, then the more specific platform condition. */
function chooseCandidate(rows: readonly Row[], reader: Reader, ctx: Context, id: string): Candidate | undefined {
  let best: Candidate | undefined
  for (const c of candidates(rows, reader, ctx, id)) {
    const order = best ? rank(c, best) : 1
    // Equal rows are an author mistake that `check` reports. The canonical text keeps the result stable.
    if (order > 0 || (order === 0 && best && canonical(c.row) < canonical(best.row))) best = c
  }
  return best
}

function chooseRow(rows: readonly Row[], reader: Reader, ctx: Context, id: string): Row | undefined {
  return chooseCandidate(rows, reader, ctx, id)?.row
}

/** JSON with sorted object keys and no `undefined`, so equal values give equal strings. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Checks the top of an index and returns its facts. Throws `not-an-index` or `unsupported-index-format`. */
export function assertIndex(index: unknown, label = 'the index'): readonly Fact[] {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new FactReadError('not-an-index', `${label} is not a fact index`)
  }
  const raw = index as Partial<FactIndex>
  // A missing field is format 1.0. Readers take any 1.x and ignore fields they do not know.
  const format = raw.indexFormat === undefined ? '1.0' : raw.indexFormat
  const m = typeof format === 'string' ? /^(\d+)\.\d+$/.exec(format) : null
  if (!m || Number(m[1]) !== 1) {
    throw new FactReadError(
      'unsupported-index-format',
      `${label} has index format ${JSON.stringify(format)}, and this reader takes 1.x`,
    )
  }
  if (!Array.isArray(raw.facts) || typeof raw.package !== 'string') {
    throw new FactReadError('not-an-index', `${label} is not a fact index`)
  }
  return raw.facts
}

function readerOf(version: string | undefined): Reader {
  if (version === undefined) return { kind: 'latest' }
  if (version === 'head') return { kind: 'head' }
  return { kind: 'version', v: mustParse(version, 'query version') }
}

/** The newest released version any row of the index names, which is how new a reader of `latest` is. */
function newestReleased(facts: readonly Fact[]): Semver | undefined {
  let newest: Semver | undefined
  for (const fact of facts) {
    for (const row of rowsOf(fact)) {
      if (row.pending !== undefined || row.since === undefined) continue
      for (const s of Array.isArray(row.since) ? row.since : [row.since]) {
        const v = s === 'next' ? undefined : parseVersion(s)
        if (v && (!newest || compareSemver(v, newest) > 0)) newest = v
      }
    }
  }
  return newest
}

function removed(fact: Fact, reader: Reader, latest: Semver | undefined): boolean {
  const at = fact.when?.removeIn
  if (typeof at !== 'string') return false
  if (reader.kind === 'head') return true
  if (at === 'next') return false
  const gone = parseVersion(at)
  if (!gone) return false
  const current = reader.kind === 'version' ? reader.v : latest
  return current !== undefined && compareSemver(current, gone) >= 0
}

/**
 * The facts one reader sees. A pure function over a parsed `index.json` of format 1.0 or 1.1.
 *
 * Each fact has rows (`variants`, or the whole fact as one row). A row applies to the reader when its `since`
 * has been reached, its `pending` label is included, and its `platforms` and `os` conditions list the reader's
 * platform and os. Of the rows that apply the one with the largest bound wins, and on a tie the one with more
 * conditions. A fact without an applying row, or whose `removeIn` has been reached, is left out.
 * The result keeps the order of the index.
 */
export function selectFacts(index: FactIndex, options: SelectOptions = {}): SelectedFact[] {
  const facts = assertIndex(index)
  const reader = readerOf(options.version)
  const ctx: Context = { include: options.include ?? [], platform: options.platform, os: options.os }
  const latest = reader.kind === 'latest' ? newestReleased(facts) : undefined
  const out: SelectedFact[] = []
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object' || typeof fact.id !== 'string') continue
    const row = chooseRow(rowsOf(fact), reader, ctx, fact.id)
    if (!row || removed(fact, reader, latest)) continue
    const { variants: _variants, ...rest } = fact
    out.push({
      ...rest,
      content: row.content,
      since: row.since ?? NO_SINCE,
      ...(row.stability !== undefined ? { stability: row.stability } : {}),
    })
  }
  return out
}

/**
 * The content a reader of format 1.0 sees in the top-level `content` of a fact: the latest published row without
 * a platform, else the row on `head`, else the row with the largest bound whatever its conditions. `tier` is
 * 1, 2 or 3 for those three, and `check` warns about 3.
 */
export function topLevelContent(fact: Fact): { content: FactContent; tier: 1 | 2 | 3 } | undefined {
  const rows = rowsOf(fact)
  const none: Context = { include: [], platform: undefined, os: undefined }
  const tiers: [Reader, Context, 1 | 2 | 3][] = [
    [{ kind: 'latest' }, none, 1],
    [{ kind: 'head' }, none, 2],
    [{ kind: 'head' }, { ...none, ignoreConditions: true }, 3],
  ]
  for (const [reader, ctx, tier] of tiers) {
    const row = chooseRow(rows, reader, ctx, fact.id)
    if (row) return { content: row.content, tier }
  }
  return undefined
}

/** The rows of a fact, for `check`. */
export const factRows = rowsOf

/** The platform and os a reader that matches no condition of the rows names. */
const OTHER = '\0other'

/** A reader and the conditions it names, one combination that a fact can be read under. */
export interface BoundaryReader {
  reader: Reader
  ctx: Context
}

/**
 * The readers to try against the rows of one or more facts, in the order `ambiguousRows` tries them. The versions
 * are `head`, the latest published, and for every version a row names that version, the next patch and the first
 * version of the next line. Each is combined with every platform, os and pending label the rows name, with none,
 * and with a platform and an os that no row names.
 */
export function boundaryReaders(rows: readonly Row[]): BoundaryReader[] {
  const readers: Reader[] = [{ kind: 'head' }, { kind: 'latest' }]
  for (const row of rows) {
    for (const s of Array.isArray(row.since) ? row.since : row.since === undefined ? [] : [row.since]) {
      const v = s === 'next' ? undefined : parseVersion(s)
      if (!v) continue
      readers.push({ kind: 'version', v })
      readers.push({ kind: 'version', v: { ...v, patch: v.patch + 1, pre: [] } })
      readers.push({ kind: 'version', v: { major: v.major, minor: v.minor + 1, patch: 0, pre: [] } })
    }
  }
  const mentioned = (pick: (r: Row) => readonly string[] | undefined): (string | undefined)[] => [
    undefined,
    OTHER,
    ...new Set(rows.flatMap((r) => pick(r) ?? [])),
  ]
  const platforms = mentioned((r) => r.platforms)
  const systems = mentioned((r) => r.os)
  const labels = [
    [],
    ...[...new Set(rows.flatMap((r) => (r.pending !== undefined ? [r.pending] : [])))].map((l) => [l]),
  ]
  const out: BoundaryReader[] = []
  for (const reader of readers) {
    for (const platform of platforms) {
      for (const os of systems) {
        for (const include of labels) out.push({ reader, ctx: { include, platform, os } })
      }
    }
  }
  return out
}

/**
 * Two rows of one fact that some reader can not tell apart: that reader gets both with the same bound and the
 * same number of conditions, and nothing ranks above them. The readers tried are those of {@link boundaryReaders}.
 * Returns the positions of the two rows.
 * Returns undefined when the fact has no such pair, or when a `since` is not a version (`check` reports that).
 */
export function ambiguousRows(fact: Fact): [number, number] | undefined {
  const rows = rowsOf(fact)
  if (rows.length < 2) return undefined
  try {
    for (const { reader, ctx } of boundaryReaders(rows)) {
      const found = candidates(rows, reader, ctx, fact.id)
      const top = found.filter((c) => found.every((o) => rank(c, o) >= 0))
      if (top.length >= 2) return [(top[0] as Candidate).index, (top[1] as Candidate).index]
    }
  } catch {
    return undefined
  }
  return undefined
}

/** One reader under which two facts are read together, with the row of each that applies. */
export interface PairedRows {
  /** `head`, `latest`, or the version. */
  version: string
  /** The platform and os the reader names, or `undefined` for none. A platform or os no row names is `other`. */
  platform: string | undefined
  os: string | undefined
  include: readonly string[]
  /** The row of the first fact that applies, or `undefined` when none does. */
  a: { content: FactContent; index: number } | undefined
  /** The row of the second fact that applies. */
  b: { content: FactContent; index: number } | undefined
}

const versionLabel = (reader: Reader): string =>
  reader.kind === 'version'
    ? `${reader.v.major}.${reader.v.minor}.${reader.v.patch}${reader.v.pre.length > 0 ? `-${reader.v.pre.join('.')}` : ''}`
    : reader.kind

/**
 * Reads two facts under the readers of {@link boundaryReaders} taken over the rows of both, and picks the row of
 * each that applies. Every check that compares one fact with another at each version boundary starts from this.
 * A reader for which a `since` is not a version is skipped (`check` reports that).
 */
export function pairRows(a: Fact, b: Fact): PairedRows[] {
  const rowsA = rowsOf(a)
  const rowsB = rowsOf(b)
  const out: PairedRows[] = []
  const seen = new Set<string>()
  for (const { reader, ctx } of boundaryReaders([...rowsA, ...rowsB])) {
    const label = versionLabel(reader)
    const key = JSON.stringify([label, ctx.platform, ctx.os, ctx.include])
    if (seen.has(key)) continue
    seen.add(key)
    let pick: { a: Candidate | undefined; b: Candidate | undefined }
    try {
      pick = { a: chooseCandidate(rowsA, reader, ctx, a.id), b: chooseCandidate(rowsB, reader, ctx, b.id) }
    } catch {
      continue
    }
    const shape = (c: Candidate | undefined) => (c ? { content: c.row.content, index: c.index } : undefined)
    out.push({
      version: label,
      platform: ctx.platform === OTHER ? 'other' : ctx.platform,
      os: ctx.os === OTHER ? 'other' : ctx.os,
      include: ctx.include,
      a: shape(pick.a),
      b: shape(pick.b),
    })
  }
  return out
}
