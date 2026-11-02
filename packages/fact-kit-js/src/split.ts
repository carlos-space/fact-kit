import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoadedEntry } from './load.ts'
import { loadOxc } from './oxc.ts'
import { lineOf, nameOf } from './rules.ts'
import type { Node } from './rules.ts'
import type { Problem } from './types.ts'

/** The most facts one `*.facts.ts` may hold when the config does not say. */
export const DEFAULT_MAX_FACTS_PER_FILE = 40

/**
 * Walks the syntax tree and tells `fn` the node and whether it sits in the arguments of a `factsOf(...)` call.
 * oxc gives ESTree nodes, so a child is any object-valued property that has a string `type`.
 */
function walkWithContext(node: unknown, inFactsOf: boolean, fn: (node: Node, inFactsOf: boolean) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkWithContext(item, inFactsOf, fn)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const n = node as Node
  if (typeof n.type === 'string') fn(n, inFactsOf)
  const here = inFactsOf || (n.type === 'CallExpression' && nameOf(n.callee) === 'factsOf')
  for (const [key, value] of Object.entries(n)) {
    if (key === 'type' || typeof value !== 'object') continue
    // The callee of `factsOf(...)` is not an argument, but it holds no `tool` property either.
    walkWithContext(value, here, fn)
  }
}

const isPropertyNamed = (n: Node, name: string): boolean =>
  (n.type === 'Property' || n.type === 'ObjectProperty') && !n.computed && nameOf(n.key) === name

async function parse(file: string): Promise<{ program: unknown; source: string }> {
  const oxc = await loadOxc()
  const source = await readFile(file, 'utf8')
  return { program: oxc.parseSync(file, source).program, source }
}

/**
 * The split rules of an entry that has `*.facts.ts` files: `split-topic`, `split-size`, `split-index` and
 * `split-tool`. `cwd` is the package directory, and the locations are relative to it.
 */
export async function splitProblems(
  entries: readonly LoadedEntry[],
  cwd: string,
  maxFactsPerFile: number = DEFAULT_MAX_FACTS_PER_FILE,
): Promise<Problem[]> {
  const problems: Problem[] = []
  for (const entry of entries) {
    if (entry.factsFiles.length === 0) continue
    for (const f of entry.factsFiles) {
      if (f.topics.length > 1) {
        problems.push({
          code: 'split-topic',
          message: `${f.file} holds facts of ${f.topics.length} topics (${f.topics.join(', ')}). Keep one topics[0] in a file`,
          location: f.file,
        })
      }
      if (f.count > maxFactsPerFile) {
        problems.push({
          code: 'split-size',
          message: `${f.file} holds ${f.count} facts, more than the ${maxFactsPerFile} that maxFactsPerFile allows. Split it`,
          location: f.file,
        })
      }
      const { program, source } = await parse(join(cwd, f.file))
      walkWithContext(program, false, (n, inFactsOf) => {
        if (inFactsOf || !isPropertyNamed(n, 'tool')) return
        problems.push({
          code: 'split-tool',
          message: `a tool is written outside the argument of factsOf(...). Write the tool once, in factsOf({ tool, ... })`,
          location: `${f.file}:${lineOf(source, n.start)}`,
        })
      })
    }
    const indexFile = join(entry.dir, 'index.ts')
    const rel = indexFile.slice(cwd.length + 1)
    const { program, source } = await parse(indexFile)
    walkWithContext(program, false, (n) => {
      if (n.type !== 'ObjectExpression') return
      const props = (n.properties as Node[]).filter((p) => isPropertyNamed(p, 'id') || isPropertyNamed(p, 'content'))
      const names = new Set(props.map((p) => nameOf(p.key)))
      if (names.has('id') && names.has('content')) {
        problems.push({
          code: 'split-index',
          message: `${rel} holds a fact object. Put the facts of an entry with *.facts.ts files in those files`,
          location: `${rel}:${lineOf(source, n.start)}`,
        })
      }
    })
  }
  return problems
}
