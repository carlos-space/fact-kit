import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { buildFacts } from './build.ts'
import { diffIndexFiles } from './diff.ts'
import { impactOf } from './impact.ts'
import { InputError, LoadError } from './load.ts'
import { checkProject, parseTrain } from './project.ts'
import type { CheckProjectOptions } from './project.ts'

export interface CliIo {
  out(text: string): void
  err(text: string): void
}

const HELP = `fact-kit <command> [options]

Commands
  check                 Validate facts, examples and what must not ship (local paths, unregistered domains)
  build                 Build facts/<entry>/index.ts into dist/<entry>/index.json and schemas/, or in an
                        aggregate package ("aggregate" in the config) copy its components' indexes into dist/
  diff <old> <new>      List the fact ids added, removed and changed between two index.json files
  diff --impact <id>    List the facts computed from a fact, and the docs and code that read it

Options for check
  --cwd <dir>           Package directory (default: current directory)
  --config <file>       Config file (default: fact-kit.config.json when present)
  --facts-dir <dir>     Fact sources, relative to --cwd (default: facts)
  --examples-dir <dir>  Example files, relative to --cwd (default: examples)
  --index <path>        A built index.json (or its directory) to check too; repeatable
  --allow-domain <host> Host URLs may point at, subdomains included; repeatable
  --train <c>=<v>       A component being released at version <v>: its "since" may be as new as <v>,
                        and no row but a pending one may still say "next". Repeatable
  --json                Print { problems: [{ code, message, location }] } on stdout

  Exit code: 0 no problem, 1 problems found, 2 bad settings or input

Options for build
  --cwd <dir>           Package directory (default: current directory)
  --facts-dir <dir>     Fact sources (default: facts)
  --out-dir <dir>       Output directory (default: dist)
  --write-exports       Add the missing "exports" entries to package.json
  --accept-upstream     Build facts derived from another upstream version than derived.lock.json records, and rewrite it

Options for diff
  --json                Print the result as JSON
  --impact <id>         Report what a change to this fact reaches, instead of comparing two files
  --cwd <dir>           With --impact: the aggregate package directory (default: current directory)

  -h, --help            Show this help
  -v, --version         Show the version
`

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}

async function runCheck(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: 'string' },
      config: { type: 'string' },
      'facts-dir': { type: 'string' },
      'examples-dir': { type: 'string' },
      index: { type: 'string', multiple: true },
      'allow-domain': { type: 'string', multiple: true },
      train: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  })
  const options: CheckProjectOptions = {
    ...(values.train ? { train: parseTrain(values.train) } : {}),
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
    ...(values.config !== undefined ? { configFile: values.config } : {}),
    ...(values['facts-dir'] !== undefined ? { factsDir: values['facts-dir'] } : {}),
    ...(values['examples-dir'] !== undefined ? { examplesDir: values['examples-dir'] } : {}),
    ...(values.index ? { indexFiles: values.index } : {}),
    ...(values['allow-domain'] ? { allowedDomains: values['allow-domain'] } : {}),
  }
  const { problems, warnings, counts } = await checkProject(options)
  for (const w of warnings) io.err(`warning ${w.code}: ${w.message}${w.location ? `\n  at ${w.location}` : ''}\n`)
  if (values.json) {
    io.out(
      `${JSON.stringify({ problems: problems.map((p) => ({ code: p.code, message: p.message, location: p.location ?? null })) }, null, 2)}\n`,
    )
    return problems.length > 0 ? 1 : 0
  }
  if (problems.length > 0) {
    for (const p of problems) io.err(`${p.code}: ${p.message}${p.location ? `\n  at ${p.location}` : ''}\n`)
    io.err(`fact-kit check: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`)
    return 1
  }
  io.out(
    `fact-kit check: ok (${counts.facts} facts in ${counts.indexes} indexes, ${counts.schemas} schema files, ${counts.examples} example groups)\n`,
  )
  return 0
}

async function runBuild(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: 'string' },
      'facts-dir': { type: 'string' },
      'out-dir': { type: 'string' },
      'write-exports': { type: 'boolean' },
      'accept-upstream': { type: 'boolean' },
    },
  })
  const result = await buildFacts({
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
    ...(values['facts-dir'] !== undefined ? { factsDir: values['facts-dir'] } : {}),
    ...(values['out-dir'] !== undefined ? { outDir: values['out-dir'] } : {}),
    ...(values['write-exports'] ? { writeExports: true } : {}),
    ...(values['accept-upstream'] ? { acceptUpstream: true } : {}),
  })
  if (result.problems.length > 0) {
    for (const p of result.problems) io.err(`${p.code}: ${p.message}${p.location ? `\n  at ${p.location}` : ''}\n`)
    io.err(`fact-kit build: ${result.problems.length} problem(s), nothing was written\n`)
    return 1
  }
  for (const f of result.files) io.out(`wrote ${f}\n`)
  if (result.exportsUpdated) io.out(`updated package.json exports: ${result.missingExports.join(', ')}\n`)
  else if (result.missingExports.length > 0) {
    io.err(
      `package.json "exports" lacks: ${result.missingExports.join(', ')}\nAdd them, or run fact-kit build --write-exports\n`,
    )
    return 1
  }
  io.out(`fact-kit build: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}\n`)
  return 0
}

async function runDiff(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, impact: { type: 'string' }, cwd: { type: 'string' } },
    allowPositionals: true,
  })
  if (values.impact !== undefined) {
    if (positionals.length > 0) {
      io.err('fact-kit diff: --impact takes a fact id and no files\n')
      return 2
    }
    const impact = await impactOf(values.impact, values.cwd !== undefined ? { cwd: values.cwd } : {})
    if (values.json) io.out(`${JSON.stringify(impact, null, 2)}\n`)
    else {
      io.out(`impact of ${impact.id}\n`)
      for (const f of impact.facts) io.out(`fact     ${f.id}  (depth ${f.depth}, via ${f.via})\n`)
      for (const d of impact.docs) io.out(`doc      ${d.file}:${d.line}  ${d.id}\n`)
      if (impact.facts.length + impact.docs.length === 0) io.out('nothing reads or derives from it\n')
    }
    return 0
  }
  if (positionals.length !== 2) {
    io.err('fact-kit diff: expected <old> <new>, or --impact <id>\n')
    return 2
  }
  const diff = await diffIndexFiles(positionals[0] as string, positionals[1] as string)
  if (values.json) io.out(`${JSON.stringify(diff, null, 2)}\n`)
  else {
    for (const id of diff.added) io.out(`added    ${id}\n`)
    for (const id of diff.removed) io.out(`removed  ${id}\n`)
    for (const id of diff.changed) io.out(`changed  ${id}\n`)
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) io.out('no differences\n')
  }
  return 0
}

/** Runs the CLI and returns the exit code. `argv` excludes `node` and the script path. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'check':
        return await runCheck(rest, io)
      case 'build':
        return await runBuild(rest, io)
      case 'diff':
        return await runDiff(rest, io)
      case '-v':
      case '--version':
        io.out(`${version()}\n`)
        return 0
      case undefined:
      case '-h':
      case '--help':
        io.out(HELP)
        return command === undefined ? 2 : 0
      default:
        io.err(`fact-kit: unknown command "${command}"\n\n${HELP}`)
        return 2
    }
  } catch (error) {
    // Bad options and settings: the command could not run, which is not the same as finding problems.
    const code = (error as NodeJS.ErrnoException).code
    if (error instanceof InputError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      io.err(`fact-kit ${command}: ${(error as Error).message}\n`)
      return 2
    }
    if (error instanceof LoadError) io.err(`fact-kit ${command}: ${error.message}\n  at ${error.file}\n`)
    else io.err(`fact-kit ${command}: ${(error as Error).message}\n`)
    return 1
  }
}
