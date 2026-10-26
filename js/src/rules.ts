import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, sep } from 'node:path'
import { loadOxc } from './oxc.ts'
import type { Problem } from './types.ts'

/** Rules that read files around the facts: the helper directory, tests, docs and the implementation. */

type Node = { type: string; start: number; [key: string]: unknown }

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'tmp'])
const CODE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** Files under `dir` with one of the extensions. A missing directory has none. */
async function walk(dir: string, accept: ReadonlySet<string> | ((name: string) => boolean)): Promise<string[]> {
  const wanted = typeof accept === 'function' ? accept : (name: string) => accept.has(extname(name))
  const out: string[] = []
  const visit = async (current: string): Promise<void> => {
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
        return
      throw error
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, item.name)
      if (item.isDirectory()) {
        if (!SKIPPED.has(item.name)) await visit(path)
      } else if (wanted(item.name) && !item.name.endsWith('.d.ts')) out.push(path)
    }
  }
  await visit(dir)
  return out
}

function visitNodes(node: unknown, fn: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) visitNodes(item, fn)
  } else if (typeof node === 'object' && node !== null) {
    const n = node as Node
    if (typeof n.type === 'string') fn(n)
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'type' && typeof value === 'object') visitNodes(value, fn)
    }
  }
}

const lineOf = (source: string, offset: number): number => source.slice(0, offset).split('\n').length

async function parsed(file: string): Promise<{ program: unknown; source: string }> {
  const oxc = await loadOxc()
  const source = await readFile(file, 'utf8')
  return { program: oxc.parseSync(file, source).program, source }
}

/** The name an object key or a literal stands for. */
function nameOf(node: unknown): string | undefined {
  const n = node as { type?: string; name?: string; value?: unknown } | null
  if (n?.type === 'Identifier') return n.name
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value
  return undefined
}

function stringsIn(node: unknown, out: Set<string>): void {
  visitNodes(node, (n) => {
    if (n.type === 'Literal' && typeof n.value === 'string') out.add(n.value)
    else if (n.type === 'TemplateLiteral') {
      const quasis = n.quasis as { value: { cooked?: string } }[]
      const expressions = n.expressions as unknown[]
      if (expressions.length === 0 && quasis[0]?.value.cooked !== undefined) out.add(quasis[0].value.cooked)
    }
  })
}

const where = (root: string, file: string, source: string, offset: number) =>
  `${relative(root, file).split(sep).join('/')}:${lineOf(source, offset)}`

/** `facts/_lib` holds shared functions and constants, so a `since` there is a row in the wrong place. */
export async function libRowProblems(libDir: string, base: string): Promise<Problem[]> {
  const problems: Problem[] = []
  for (const file of await walk(libDir, CODE)) {
    const { program, source } = await parsed(file)
    visitNodes(program, (n) => {
      if (n.type === 'Property' && nameOf(n.key) === 'since') {
        problems.push({
          code: 'lib-rows',
          message: `a row with "since" in the shared helper directory. Rows belong in a facts/<entry>/index.ts, and _lib holds only functions and constants`,
          location: where(base, file, source, n.start),
        })
      }
    })
  }
  return problems
}

/** The strings the tests in `dirs` pass as `include`. */
export async function testIncludes(dirs: readonly string[], base: string): Promise<Set<string>> {
  const labels = new Set<string>()
  for (const dir of dirs) {
    for (const file of await walk(join(base, dir), CODE)) {
      const { program } = await parsed(file)
      visitNodes(program, (n) => {
        if (n.type === 'Property' && nameOf(n.key) === 'include') stringsIn(n.value, labels)
      })
    }
  }
  return labels
}

/** What the docs may point at: every id, and the ids of each entry by its spec. */
export interface KnownFacts {
  ids: ReadonlySet<string>
  bySpec: ReadonlyMap<string, ReadonlySet<string>>
}

const FACT_REF = /fact:(?:([@\w][\w@./-]*):)?([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*)/g

/** `fact:<id>` and `fact:<spec>:<id>` in the markdown under `dirs` that name a fact that does not exist. */
export async function docRefProblems(dirs: readonly string[], base: string, known: KnownFacts): Promise<Problem[]> {
  const problems: Problem[] = []
  for (const dir of dirs) {
    for (const file of await walk(join(base, dir), new Set(['.md', '.mdx']))) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      for (const [i, line] of lines.entries()) {
        for (const m of line.matchAll(FACT_REF)) {
          const spec = m[1]
          // A trailing "." or "-" ends the sentence, not the id.
          const id = (m[2] as string).replace(/[._-]+$/, '')
          const ids = spec === undefined ? known.ids : known.bySpec.get(spec)
          // A spec that was not loaded can not be checked.
          if (ids === undefined || ids.has(id)) continue
          problems.push({
            code: 'doc-unknown-id',
            message: `the document refers to fact "${spec !== undefined ? `${spec}:` : ''}${id}", which does not exist`,
            location: `${relative(base, file).split(sep).join('/')}:${i + 1}`,
          })
        }
      }
    }
  }
  return problems
}

const isFactsPackage = (name: unknown): boolean => typeof name === 'string' && name.endsWith('-facts')

function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Every package.json under `root`, outside node_modules and build output. */
async function packageFiles(root: string): Promise<string[]> {
  return walk(root, (name) => name === 'package.json')
}

/**
 * The implementation must not read the facts it is described by: the facts are the spec and the tests compare the
 * two. So a package that is not a facts package does not list a `-facts` package in `dependencies`, and the code in
 * `implDirs` does not import one. The package.json files are found under `root`, the directories under `base`.
 */
export async function implProblems(root: string, base: string, implDirs: readonly string[]): Promise<Problem[]> {
  const problems: Problem[] = []
  for (const file of await packageFiles(root)) {
    let pkg: { name?: unknown; dependencies?: Record<string, unknown> }
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg
    } catch {
      continue
    }
    if (isFactsPackage(pkg.name)) continue
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (isFactsPackage(name)) {
        problems.push({
          code: 'impl-depends-on-facts',
          message: `${typeof pkg.name === 'string' ? pkg.name : 'this package'} is not a facts package, but lists ${name} in dependencies. Facts go in devDependencies of the tests and docs that read them`,
          location: relative(root, file).split(sep).join('/'),
        })
      }
    }
  }
  for (const dir of implDirs) {
    for (const file of await walk(join(base, dir), CODE)) {
      const { program, source } = await parsed(file)
      visitNodes(program, (n) => {
        let specifier: unknown
        if (
          n.type === 'ImportDeclaration' ||
          n.type === 'ExportAllDeclaration' ||
          n.type === 'ExportNamedDeclaration'
        ) {
          specifier = (n.source as { value?: unknown } | null)?.value
        } else if (n.type === 'ImportExpression') {
          specifier = (n.source as { value?: unknown } | null)?.value
        } else if (n.type === 'CallExpression' && nameOf(n.callee) === 'require') {
          specifier = (n.arguments as { value?: unknown }[])[0]?.value
        }
        if (typeof specifier !== 'string') return
        const name = packageOfSpecifier(specifier)
        if (name && isFactsPackage(name)) {
          problems.push({
            code: 'impl-imports-facts',
            message: `the implementation imports ${specifier}. The facts are the spec, so only tests and docs read them`,
            location: where(base, file, source, n.start),
          })
        }
      })
    }
  }
  return problems
}

/** The directory a repository starts at: the nearest parent of `from` that holds `.git`, else `from`. */
export function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === dirname(dir)) return from
  }
}
