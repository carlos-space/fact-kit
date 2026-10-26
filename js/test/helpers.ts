import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
export const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

const created: string[] = []

/** A fresh directory under the repository's `tmp/`, removed by {@link cleanTmp}. */
export function makeTmp(name: string): string {
  const base = join(repoRoot, 'tmp', 'fact-kit-tests')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, `${name}-`))
  created.push(dir)
  return dir
}

export function cleanTmp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Writes files (path relative to `dir` -> content), creating directories. Objects are written as JSON. */
export function writeTree(dir: string, files: Record<string, unknown>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

const run = promisify(execFile)

/** Runs the real CLI in a child process. */
export async function cli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [binPath, ...args], { cwd: cwd ?? repoRoot })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}
