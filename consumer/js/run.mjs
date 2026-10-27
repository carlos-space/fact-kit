// Consumer harness for the JS reader: runs the shared samples of conformance/ against an installed fact-kit.
//
// It imports only what the installed package exports. run.sh copies it into a new npm project, so `fact-kit`
// can only resolve to that project's node_modules. It prints where the package was loaded from, and exits 1
// when a sample fails or the package was not loaded from node_modules/fact-kit/.
//
// usage: node run.mjs [--expect-version X.Y.Z[-pre.N]]      env: FACT_KIT_CONFORMANCE  the conformance/ directory
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FactReadError, compareVersions, readFacts, releaseLine, selectFacts } from 'fact-kit'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const dirs = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

/** What a reader returns, in the shape of expected.json, or the error code it threw. */
function outcome(run) {
  try {
    const facts = run()
      .map((f) => ({
        id: f.id,
        content: f.content,
        since: f.since,
        ...(f.stability !== undefined ? { stability: f.stability } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { facts }
  } catch (error) {
    if (error instanceof FactReadError) return { error: error.code }
    throw error
  }
}

const args = process.argv.slice(2)
const at = args.indexOf('--expect-version')
const expectVersion = at >= 0 ? args[at + 1] : undefined

if (!process.env.FACT_KIT_CONFORMANCE) {
  console.error('FACT_KIT_CONFORMANCE is not set')
  process.exit(1)
}
const root = resolve(process.env.FACT_KIT_CONFORMANCE)
const failures = []
const check = (name, got, want) => {
  // JSON round trip drops undefined fields, as expected.json cannot hold them
  if (!isDeepStrictEqual(JSON.parse(JSON.stringify(got)), want)) {
    failures.push(`${name}\n  got      ${JSON.stringify(got)}\n  expected ${JSON.stringify(want)}`)
  }
}

const cases = dirs(join(root, 'cases'))
for (const name of cases) {
  const dir = join(root, 'cases', name)
  const query = readJson(join(dir, 'query.json'))
  check(
    `cases/${name}`,
    outcome(() => selectFacts(readJson(join(dir, 'index.json')), query)),
    readJson(join(dir, 'expected.json')),
  )
}

const resolves = dirs(join(root, 'resolve'))
for (const name of resolves) {
  const dir = join(root, 'resolve', name)
  const { spec, ...query } = readJson(join(dir, 'query.json'))
  check(
    `resolve/${name}`,
    outcome(() => readFacts(spec, { root: join(dir, 'root'), ...query }).facts),
    readJson(join(dir, 'expected.json')),
  )
}

let compares = 0
let lines = 0
for (const entry of readJson(join(root, 'semver.json'))) {
  if ('a' in entry) {
    compares++
    check(`semver/${entry.a} vs ${entry.b}`, compareVersions(entry.a, entry.b), entry.expected)
  } else {
    lines++
    check(`semver/line ${entry.version}`, releaseLine(entry.version), entry.line)
  }
}

// a harness that read nothing proves nothing
if (cases.length < 80 || resolves.length < 15 || compares <= 50 || lines <= 5) {
  failures.push(
    `too few samples in ${root}: ${cases.length} cases, ${resolves.length} resolve, ${compares} compares, ${lines} lines`,
  )
}

const entry = realpathSync(fileURLToPath(import.meta.resolve('fact-kit')))
const manifest = join(dirname(entry), '..', 'package.json')
const version = existsSync(manifest) ? readJson(manifest).version : undefined
console.log(`node: ${process.version} at ${process.execPath}`)
console.log(`conformance: ${root}`)
console.log(
  `samples: ${cases.length} cases, ${resolves.length} resolve, ${compares} version comparisons, ${lines} release lines`,
)
console.log(`source: module fact-kit loaded from ${entry}`)
console.log(`source: package fact-kit ${version}`)
if (!entry.includes(`${sep}node_modules${sep}fact-kit${sep}`)) {
  failures.push(`fact-kit was loaded from ${entry}, which is not an installed copy`)
}
if (expectVersion && version !== expectVersion) {
  failures.push(`installed fact-kit ${version}, expected ${expectVersion}`)
}

if (failures.length > 0) {
  console.error(`FAILED: ${failures.length}`)
  for (const f of failures) console.error(f)
  process.exit(1)
}
console.log('ok: every sample matches expected.json')
