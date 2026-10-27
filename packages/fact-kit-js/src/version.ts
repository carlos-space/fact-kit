import type { Since } from './types.ts'

/** The stable `code` of an error a reader throws. The message is for people and can change. */
export type ReadErrorCode = 'not-an-index' | 'unsupported-index-format' | 'not-found' | 'invalid-version'

export class FactReadError extends Error {
  readonly code: ReadErrorCode
  constructor(code: ReadErrorCode, message: string) {
    super(`${message} (${code})`)
    this.name = 'FactReadError'
    this.code = code
  }
}

export interface Semver {
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers, empty for a release. */
  pre: string[]
}

const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
)

/** Parses a semver 2.0.0 version, or returns undefined. Build metadata is accepted and ignored. */
export function parseVersion(text: string): Semver | undefined {
  const m = SEMVER.exec(text)
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

export function mustParse(text: string, what: string): Semver {
  const v = typeof text === 'string' ? parseVersion(text) : undefined
  if (!v) throw new FactReadError('invalid-version', `${what} "${String(text)}" is not a semver 2.0.0 version`)
  return v
}

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  // A release is greater than any of its pre-releases.
  if (a.length === 0 || b.length === 0) return sign(b.length - a.length)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string
    const y = b[i] as string
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return sign(Number(x) - Number(y))
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return sign(a.length - b.length)
}

/** The semver 2.0.0 precedence of `a` against `b`. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  return sign(a.major - b.major) || sign(a.minor - b.minor) || sign(a.patch - b.patch) || comparePre(a.pre, b.pre)
}

/** Compares two version strings. Throws `invalid-version` when one is not semver. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return compareSemver(mustParse(a, 'version'), mustParse(b, 'version'))
}

/** The release line `X.Y` of a version. `0.49.0-alpha.1` is on line `0.49`. */
export function releaseLine(version: string): string {
  const v = mustParse(version, 'version')
  return `${v.major}.${v.minor}`
}

/** Compares the release lines of two versions. */
export function compareLines(a: Semver, b: Semver): -1 | 0 | 1 {
  return sign(a.major - b.major) || sign(a.minor - b.minor)
}

/** What is wrong with a `since` value: a form that is not allowed, or two versions on one release line. */
export interface SinceIssue {
  code: 'since-format' | 'same-line'
  message: string
}

/** Why a `since` value is not one of the three allowed forms, or undefined when it is fine. */
export function sinceIssue(since: Since): SinceIssue | undefined {
  const format = (message: string): SinceIssue => ({ code: 'since-format', message })
  if (typeof since === 'string') {
    return since === 'next' || parseVersion(since) ? undefined : format(`"${since}" is neither a version nor "next"`)
  }
  if (!Array.isArray(since) || since.length === 0) return format('an array of versions must not be empty')
  const lines = new Set<string>()
  for (const [i, item] of since.entries()) {
    if (item === 'next') {
      if (i !== since.length - 1) return format('"next" may only be the last item of an array')
      continue
    }
    const v = typeof item === 'string' ? parseVersion(item) : undefined
    if (!v) return format(`"${String(item)}" is not a version`)
    const line = `${v.major}.${v.minor}`
    if (lines.has(line)) {
      return { code: 'same-line', message: `two versions on release line ${line}` }
    }
    lines.add(line)
  }
  if (since.length === 1 && since[0] === 'next') return format('use "next", not ["next"]')
  return undefined
}

/** Same as {@link sinceIssue}, the message only. */
export const sinceProblem = (since: Since): string | undefined => sinceIssue(since)?.message
