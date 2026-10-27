import type { Fact } from './types.ts'

export interface ValueListOptions {
  /** Columns of the table drawn for an array of objects. Defaults to the keys of the items, in first-seen order. */
  columns?: readonly string[]
}

const cell = (v: unknown): string => {
  const text = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v)
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Renders a fact whose `content.value` is an array as Markdown. An array of strings gives one `- item` line per
 * item. An array of objects gives a table with one row per item and one column per key (or `options.columns`).
 * Other items are written as inline JSON in a list line. Throws, naming the fact id, when the fact has no
 * `content.value` or the value is not an array.
 */
export function valueListToMarkdown(fact: Pick<Fact, 'id' | 'content'>, options: ValueListOptions = {}): string {
  const content = fact.content as { value?: unknown }
  if (!('value' in content)) throw new Error(`${fact.id}: content has no value, so it cannot be rendered as a list`)
  const value = content.value
  if (!Array.isArray(value)) throw new Error(`${fact.id}: content.value is not an array`)
  if (value.length === 0) return ''
  if (value.every(isObj)) {
    const columns = options.columns ?? [...new Set(value.flatMap((item) => Object.keys(item)))]
    const lines = [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => ':---').join(' | ')} |`]
    for (const item of value) lines.push(`| ${columns.map((c) => cell(item[c])).join(' | ')} |`)
    return `${lines.join('\n')}\n`
  }
  return `${value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')}\n`
}

export interface ReplaceBlocksResult {
  /** The document with every named block rewritten. */
  text: string
  /** False when the text is identical to the input, so a `--check` can tell a generated block is up to date. */
  changed: boolean
}

const MARKER = /^([ \t]*)<!-- facts:(begin|end) ([A-Za-z0-9._-]+) -->[ \t]*\r?$/

/**
 * Replaces the text between `<!-- facts:begin NAME -->` and `<!-- facts:end NAME -->` with `blocks[NAME]`.
 * Marker lines sit on their own line, and the lines inside take the indent of the begin marker. Blocks the
 * document has but `blocks` does not name stay as they are. Throws, naming the block, on a `begin` with no
 * `end`, an `end` with no `begin`, a nested or repeated name, or a name in `blocks` that the document lacks.
 */
export function replaceFactBlocks(text: string, blocks: Readonly<Record<string, string>>): ReplaceBlocksResult {
  const lines = text.split('\n')
  const out: string[] = []
  const seen = new Set<string>()
  let open: string | null = null
  let keep = false
  for (const [i, line] of lines.entries()) {
    const m = MARKER.exec(line)
    if (!m) {
      if (open === null || keep) out.push(line)
      continue
    }
    const [, indent = '', edge, name = ''] = m
    const where = `line ${i + 1}`
    if (edge === 'begin') {
      if (open !== null) throw new Error(`facts:begin ${name} at ${where} is inside the open block ${open}`)
      if (seen.has(name)) throw new Error(`block ${name} appears more than once (${where})`)
      seen.add(name)
      out.push(line)
      const body = blocks[name]
      if (body !== undefined) {
        const eol = line.endsWith('\r') ? '\r' : ''
        if (body !== '') {
          for (const l of body.replace(/\n$/, '').split('\n')) out.push(l === '' ? eol : indent + l + eol)
        }
      }
      open = name
      keep = body === undefined
    } else {
      if (open !== name) throw new Error(`facts:end ${name} at ${where} has no matching facts:begin`)
      open = null
      keep = false
      out.push(line)
    }
  }
  if (open !== null) throw new Error(`facts:begin ${open} is never closed`)
  const missing = Object.keys(blocks).filter((name) => !seen.has(name))
  if (missing.length > 0) throw new Error(`the document has no block named ${missing.join(', ')}`)
  const next = out.join('\n')
  return { text: next, changed: next !== text }
}
