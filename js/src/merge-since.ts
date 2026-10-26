import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { InputError } from './load.ts'
import { loadOxc } from './oxc.ts'
import type { OxcModule } from './oxc.ts'
import { applyEdits, findRows } from './rows.ts'
import type { Edit, SinceRow } from './rows.ts'
import { CODE, lineOf } from './rules.ts'
import { compareVersions, parseVersion, releaseLine } from './version.ts'

const exec = promisify(execFile)

export interface MergeSinceOptions {
  /** A directory inside the repository, normally the component package. Only files under it are read. */
  cwd?: string
}

export interface MergeSinceResult {
  /** Files in which at least one conflict block was resolved, with the number of blocks. */
  resolved: { file: string; blocks: number }[]
  /** Rows rewritten to `[version, 'next']`. */
  normalized: { file: string; line: number; from: string; to: string }[]
  /** Conflicts left in the files, and files that could not be read. `line` is the line in the file as it is now. */
  unresolved: { file: string; line: number; reason: string }[]
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
  } catch (error) {
    const e = error as { stderr?: string; message: string }
    throw new InputError(`git ${args.join(' ')} failed: ${(e.stderr ?? e.message).trim()}`)
  }
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec('git', ['-C', cwd, ...args])
    return true
  } catch {
    return false
  }
}

const splitZ = (out: string): string[] => out.split('\0').filter((s) => s !== '')

// --- conflict blocks ----------------------------------------------------------------------------------
const START = /^<{7}(?: |$)/
const BASE = /^\|{7}(?: |$)/
const MIDDLE = /^={7}$/
const END = /^>{7}(?: |$)/

/**
 * A `since` with a literal value, in a row written on one line or several. The value is a string or an array of
 * strings. Group 1 is the value.
 */
const SINCE = /(?<![\w$])(?:'since'|"since"|since)\s*:\s*(\[[^\]]*\]|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g

interface Found {
  /** Offsets of the value in the text. */
  start: number
  end: number
  items: string[]
  array: boolean
  quote: string
}

function findSince(text: string): Found[] | undefined {
  const out: Found[] = []
  for (const m of text.matchAll(SINCE)) {
    const value = m[1] as string
    const end = (m.index as number) + m[0].length
    const start = end - value.length
    if (value.startsWith('[')) {
      const inner = value.slice(1, -1)
      const items = [...inner.matchAll(LITERAL)].map((l) => (l[1] ?? l[2]) as string)
      if (inner.replace(LITERAL, '').replace(/[\s,]/g, '') !== '') return undefined
      out.push({ start, end, items, array: true, quote: /['"]/.exec(inner)?.[0] ?? "'" })
    } else {
      out.push({ start, end, items: [value.slice(1, -1)], array: false, quote: value[0] as string })
    }
  }
  return out
}

const maskSince = (text: string, found: readonly Found[]): string => {
  let out = ''
  let at = 0
  for (const f of found) {
    out += text.slice(at, f.start) + '\u0001'
    at = f.end
  }
  return out + text.slice(at)
}

/** Union of the versions, the smaller one where two are on the same release line, by release line, `next` last. */
function mergeItems(lists: readonly string[][]): string[] | string {
  const byLine = new Map<string, string>()
  let next = false
  for (const item of lists.flat()) {
    if (item === 'next') {
      next = true
      continue
    }
    if (!parseVersion(item)) return `"${item}" is not a version`
    const line = releaseLine(item)
    const kept = byLine.get(line)
    if (kept === undefined || compareVersions(item, kept) < 0) byLine.set(line, item)
  }
  const versions = [...byLine.values()].sort(compareVersions)
  return next ? [...versions, 'next'] : versions
}

const quoted = (items: readonly string[], q: string): string => `[${items.map((i) => `${q}${i}${q}`).join(', ')}]`

/** The text that replaces a conflict block, or the reason it can not be resolved. */
function mergeSides(ours: string, theirs: string): { text: string } | { reason: string } {
  const a = findSince(ours)
  const b = findSince(theirs)
  if (!a || !b) return { reason: 'a "since" array holds something other than version strings' }
  if (a.length === 0 || a.length !== b.length || maskSince(ours, a) !== maskSince(theirs, b)) {
    return { reason: 'the two sides differ in more than the "since" values' }
  }
  const replacements: Edit[] = []
  for (const [i, x] of a.entries()) {
    const y = b[i] as Found
    const merged = mergeItems([x.items, y.items])
    if (typeof merged === 'string') return { reason: merged }
    if (merged.length === 0) return { reason: 'a "since" holds no version' }
    const array = x.array || y.array
    const scalar = merged.length === 1 && (!array || merged[0] === 'next')
    replacements.push({
      start: x.start,
      end: x.end,
      text: scalar ? `${x.quote}${merged[0]}${x.quote}` : quoted(merged, x.quote),
    })
  }
  return { text: applyEdits(ours, replacements) }
}

interface Resolution {
  text: string
  blocks: number
  unresolved: { line: number; reason: string }[]
}

function resolveConflicts(text: string, canMerge: boolean): Resolution {
  const lines = text.split('\n')
  const out: string[] = []
  const unresolved: Resolution['unresolved'] = []
  let blocks = 0
  const bare = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!START.test(bare(line))) {
      out.push(line)
      continue
    }
    // Collect the block: start, ours, [base], theirs, end.
    const ours: string[] = []
    const theirs: string[] = []
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    let j = i + 1
    let closed = false
    for (; j < lines.length; j++) {
      const l = bare(lines[j] as string)
      if (START.test(l)) break
      if (part === 'ours' && BASE.test(l)) part = 'base'
      else if (part !== 'theirs' && MIDDLE.test(l)) part = 'theirs'
      else if (part === 'theirs' && END.test(l)) {
        closed = true
        break
      } else if (part === 'ours') ours.push(lines[j] as string)
      else if (part === 'theirs') theirs.push(lines[j] as string)
    }
    const original = lines.slice(i, closed ? j + 1 : j)
    const keep = (reason: string): void => {
      unresolved.push({ line: out.length + 1, reason })
      out.push(...original)
      i += original.length - 1
    }
    if (!closed) {
      keep('the conflict block has no closing marker')
      continue
    }
    if (!canMerge) {
      keep('not a TypeScript or JavaScript file, so the conflict needs a person')
      continue
    }
    const cr = (ours[0] ?? theirs[0] ?? line).endsWith('\r') ? '\r' : ''
    const merged = mergeSides(ours.map(bare).join('\n'), theirs.map(bare).join('\n'))
    if ('reason' in merged) {
      keep(merged.reason)
      continue
    }
    out.push(...merged.text.split('\n').map((l) => l + cr))
    blocks++
    i = j
  }
  return { text: out.join('\n'), blocks, unresolved }
}

const hasMarkers = (text: string): boolean => text.split('\n').some((l) => START.test(l) || END.test(l))

// --- rows that came in with the merge -----------------------------------------------------------------
const rowKey = (row: SinceRow): string | undefined => {
  if (!row.since) return undefined
  const items = row.since.kind === 'string' ? [row.since.item.text] : row.since.items.map((i) => i.text)
  return `${row.factId}\u0000${JSON.stringify(items)}`
}

function parseOrReason(oxc: OxcModule, file: string, source: string): { program: unknown } | string {
  const parsed = oxc.parseSync(file, source)
  return parsed.errors.length > 0 ? `cannot parse: ${(parsed.errors[0] as { message: string }).message}` : parsed
}

/**
 * A row only the merged-in side has, and whose `since` is one patch version, also applies to the release after
 * it, so it becomes `[version, 'next']`. A row `HEAD` already had (same fact, same `since`) stays.
 */
function normalize(
  oxc: OxcModule,
  file: string,
  source: string,
  before: string | undefined,
): { text: string; changes: { line: number; from: string; to: string }[] } | string {
  const now = parseOrReason(oxc, file, source)
  if (typeof now === 'string') return now
  const had = new Set<string>()
  if (before !== undefined) {
    const old = parseOrReason(oxc, file, before)
    if (typeof old === 'string') return `the version in HEAD: ${old}`
    for (const row of findRows(old.program)) {
      const key = rowKey(row)
      if (key) had.add(key)
    }
  }
  const edits: Edit[] = []
  const changes: { line: number; from: string; to: string }[] = []
  for (const row of findRows(now.program)) {
    if (row.since?.kind !== 'string' || row.pending !== 'none') continue
    const { item } = row.since
    const v = parseVersion(item.text)
    if (!v || v.pre.length > 0 || v.patch === 0) continue
    const key = rowKey(row)
    if (key === undefined || had.has(key)) continue
    const q = item.quote
    const to = `[${q}${item.text}${q}, ${q}next${q}]`
    edits.push({ start: item.start, end: item.end, text: to })
    changes.push({ line: lineOf(source, row.start), from: source.slice(item.start, item.end), to })
  }
  return { text: applyEdits(source, edits), changes }
}

/**
 * Run after `git merge`. Resolves the conflict blocks in the unmerged files under `cwd` that differ only in
 * `since` (union of the versions, the smaller one on a release line, ordered by release line, `next` last, in
 * the normal, `diff3` and `zdiff3` marker styles), then rewrites rows that only the merged-in side has. Writes
 * what it could settle and reports what it could not. It does not stage anything.
 */
export async function mergeSince(options: MergeSinceOptions = {}): Promise<MergeSinceResult> {
  const given = resolve(options.cwd ?? process.cwd())
  try {
    if (!(await stat(given)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new InputError(`${given} is not a directory`)
  }
  const cwd = realpathSync(given)
  const oxc = await loadOxc()
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const inside = (path: string): string | undefined => {
    const abs = join(top, path)
    const rel = relative(cwd, abs)
    return rel.startsWith('..') || rel === '' ? undefined : rel.split(sep).join('/')
  }
  const result: MergeSinceResult = { resolved: [], normalized: [], unresolved: [] }

  const unmerged = splitZ(await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']))
  for (const path of unmerged) {
    const rel = inside(path)
    const abs = join(top, path)
    if (rel === undefined || !existsSync(abs)) continue
    const source = await readFile(abs, 'utf8')
    if (!hasMarkers(source)) continue
    const r = resolveConflicts(source, CODE.has(extname(abs)))
    if (r.text !== source) await writeFile(abs, r.text)
    if (r.blocks > 0) result.resolved.push({ file: rel, blocks: r.blocks })
    for (const u of r.unresolved) result.unresolved.push({ file: rel, ...u })
  }

  // The side we are on: HEAD while the merge is open, the first parent once it was committed.
  let ours = 'HEAD'
  if (!(await gitOk(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) {
    if (await gitOk(cwd, ['rev-parse', '-q', '--verify', 'HEAD^2'])) ours = 'HEAD^1'
    else if (unmerged.length === 0) {
      throw new InputError('no merge to read: MERGE_HEAD is missing and HEAD is not a merge commit')
    }
  }
  for (const path of splitZ(await git(cwd, ['diff', '--name-only', '-z', ours, '--']))) {
    const rel = inside(path)
    const abs = join(top, path)
    if (rel === undefined || !CODE.has(extname(abs)) || abs.endsWith('.d.ts') || !existsSync(abs)) continue
    const source = await readFile(abs, 'utf8')
    if (hasMarkers(source)) continue // reported above
    let before: string | undefined
    try {
      before = (await exec('git', ['-C', cwd, 'show', `${ours}:${path}`], { maxBuffer: 64 * 1024 * 1024 })).stdout
    } catch {
      before = undefined // a file the merge added
    }
    const n = normalize(oxc, rel, source, before)
    if (typeof n === 'string') {
      result.unresolved.push({ file: rel, line: 1, reason: n })
      continue
    }
    if (n.text !== source) await writeFile(abs, n.text)
    for (const c of n.changes) result.normalized.push({ file: rel, ...c })
  }
  return result
}
