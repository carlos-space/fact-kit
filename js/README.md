# fact-kit

Tooling to declare, check, build and read facts. Facts are published as plain JSON and JSON Schema, so
reading them needs no fact-kit. This package helps with writing, checking, building and reading.

## Install

Add it as a dev dependency of the package that declares facts, and as a dependency where code reads them:

```sh
pnpm add -D fact-kit
```

`typescript` (7.1.0-beta or later) and `oxc-parser` are optional peer dependencies. They are not installed
with fact-kit. Install `typescript` to use the converters (see Converting). `oxc-parser` is loaded by `diff --impact`
when it scans TypeScript source.

## Authoring

A package holds one directory per entry: `facts/<entry>/index.ts`, which default-exports
`{ describes, facts }`. `describes` names at most one component, such as `{ mainflow: '1.2.0' }`, or is `{}` when the described thing has no version. `check`
rejects an entry that names several, and entries of one package that disagree: different components, or `{}` mixed with a component. Optional `facts/<entry>/schemas/*.schema.json` hold field shapes that facts `$ref`.
Directories starting with `_` are helpers, not entries.

The TypeScript runs with Node's built-in type stripping (Node 24 or later). Use erasable syntax only
(no `enum`, no parameter properties) and give relative imports the `.ts` extension. The package.json needs
`"type": "module"`.

## Commands

```text
fact-kit check [--cwd dir] [--config file] [--facts-dir dir] [--examples-dir dir]
               [--index path]... [--allow-domain host]... [--train component=version]... [--json]
fact-kit build [--cwd dir] [--facts-dir dir] [--out-dir dir] [--write-exports] [--accept-upstream]
fact-kit diff <old> <new> [--json]
fact-kit diff --impact <id> [--cwd dir] [--json]
```

`check` validates every fact against the meta-schema, rejects duplicate ids, local absolute paths and
domains that are not in the allowed list, and checks that examples only reference existing fact ids. The other
rules are in [Check rules](#check-rules). Settings can live in `fact-kit.config.json` (`factsDir`, `examplesDir`,
`indexFiles`, `allowedDomains`, `repoRoot`, `testDirs`, `docsDirs`, `implDirs`, and for the aggregate package below, `aggregate`). The three directory lists are
relative to the package, and `repoRoot` defaults to the nearest parent that holds `.git`.

A fact whose content changes over versions, or differs by platform, lists rows in `variants`
(`{ since, content, pending?, stability?, platforms?, os? }`). `since` is a version, `'next'`, or one version per
release line (`['0.48.1', '0.49.1']`, which may end in `'next'`). `when.replacement` takes one id or several,
`when.movedTo` is a fact location (`<id>`, or `<spec>:<id>` in another package or entry), and `derivedFrom` lists
the fact locations a fact is computed from.
`check` also rejects a `since` that is not a version, and rows that a reader can not tell apart; it warns when
the top-level `content` has to be a guess. The rules are in [`conformance/README.md`](../conformance/README.md).

`build` writes `dist/<entry>/index.json` and `dist/<entry>/schemas/`, and reports the `exports` entries
package.json needs (`--write-exports` adds them). The index has `indexFormat: "1.1"`, and a fact with `variants`
gets the latest published row as its top-level `content`, which is what a reader of format 1.0 uses. `build` validates format and ids only; it does not scan
for local paths or domains, so run `check` before publishing.

### Two-layer packages

A repository can keep its facts in private component packages (named `@component/<directory>`, `"private": true`)
and publish one aggregate package that holds all their indexes. The aggregate lists the components in
`devDependencies` (`"workspace:*"`) and in `fact-kit.config.json`:

```json
{ "aggregate": { ".": "@component/fact-kit", "git": "@component/git" } }
```

`fact-kit build` in the aggregate package copies the built indexes of the components (build them first; with pnpm,
`pnpm -r build` orders them) into `dist/` and clears `dist/` before it writes. A component with one entry goes to
`dist/<sub-path>/`, the root component (`.`) to `dist/`. A component with several entries goes to
`dist/<sub-path>/<entry>/`, or `dist/<entry>/` for the root, and the build fails when that name is also another
sub-path. `schemas/` is copied along, and each index gets `./<dir>/index.json` and `./<dir>/schemas/*` in `exports`.
In the copied index, `package` is the aggregate name, `entry` is the path of the index in the aggregate (`.` for the
root), `component` is the component package, and `derivedFrom` and `movedTo` that name a component package become the published spec.
`readFacts('<aggregate>')`, `readFacts('<aggregate>/<sub-path>')` and `readFacts('<aggregate>/<sub-path>/<entry>')`
read them.

### Impact of a change

`fact-kit diff --impact <id>` runs in an aggregate package. It reads the built indexes of the components, follows
`derivedFrom` downstream and prints `{ id, facts: [{ id, depth, via }], docs: [{ file, line, id }] }` with `--json`.
`docs` come from `docsDirs` (relative to the config file): markdown lines with `fact:<id>` or `fact:<spec>:<id>`, and
in TypeScript the string argument of `get`, `value` and `has` calls and imports of a fact object. An import counts when its relative module, loaded the way `build` loads fact sources,
exports a fact object with the id, whatever name it is imported under; a module that fails to load is skipped. Scanning TypeScript needs the optional peer dependency `oxc-parser`, which is
loaded only then.

### History, keys and relations

A fact with several versions writes `variants: history(...rows)`. The first row gives the content (`value`,
`schema` or `statement`). Each later row either rewrites it whole, or changes the content of the row before it
with `remove`, `replace`, `add` and `set`, applied in that order. Targets are JSON Pointers (RFC 6901, `~0` and `~1`
escape, `''` is the root). `since`, `pending`, `stability`, `platforms` and `os` go to the variant as written.
`content` may be left out, and the build fills it with the latest published row.

```ts
import { defineFacts, history, keyed } from 'fact-kit'

const edge = (from: string, to: string) => ({ from, to })

export default defineFacts({
  describes: { demo: '1.2.0' },
  facts: [
    {
      id: 'demo.flow',
      tool: 'demo',
      topics: ['flow'],
      title: 'Flow',
      source: { kind: 'published' },
      variants: history(
        { since: '1.0.0', value: { transitions: keyed([edge('draft', 'active')], ['from', 'to']), max: 10 } },
        { since: '1.1.0', add: { '/transitions': [edge('active', 'done')] }, set: { '/max': 40 } },
        { since: 'next', remove: { '/transitions': [['draft', 'active']] } },
      ),
    },
  ],
})
```

`keyed(items, keys)` declares which fields identify an item, so `add`, `remove` and `replace` can name items. One
key field is written as its value, several as an array in the declared order (`['draft', 'active']`), so no field
value is ambiguous. Without `keys` the items are scalars and identify themselves. An array that is not keyed can
only be replaced whole, and `add` or `remove` on it fails. `replace` on a keyed array with a list of items swaps
them in by key. Anywhere else it replaces the value at the pointer, which must exist, and `set` puts a value there
even when the last member is new. A row that does not fit fails the build and names the key. `check` reports it as
`history`.

To relate facts, import the other fact object and put it in `relates: [fact]`, or write `factLink(fact)` inside
the content, which becomes the fact location (`<id>` in the same entry, `<spec>:<id>` in another). The build
lists them in `derivedFrom` by object identity, so renaming an id or moving a file does not break the link. A fact
object that is not one of this package's facts, such as one imported from another package, fails `check` with
`relates-foreign`.

A fact of another package is brought in with `derive(upstreamSpec, id, map?)` as an item of `facts`:

```ts
import { derive } from 'fact-kit'

derive('@scope/tool-facts/cli', 'tool.limits', (up) => ({ id: 'mine.limits', tool: 'mine', title: up.title }))
```

The build reads the installed index of `upstreamSpec`, copies the fact, lets `map` return the fields to change, and
writes `source: { kind: 'derived', from, version }` with the version of the installed upstream package, and
`derivedFrom: ['<upstreamSpec>:<id>']`.

The build also writes `derived.lock.json` next to package.json, which maps each upstream spec to the version it
used (`{ "@scope/tool-facts/cli": "1.2.0" }`). Commit it. When the installed upstream version differs from the
lock, the build fails with `derive-version` and names both versions. Look at what changed upstream, then build with
`--accept-upstream`, which rewrites the lock. A missing lock is written from the installed versions and is not a
failure, and a package without derived facts gets none. `check` makes the same comparison, and
`check --index dist/<entry>` compares the version a built index records with the installed upstream.

## Check rules

`check` exits with 0 when it finds no problem, 1 when it finds problems and 2 when it can not run: an unknown
option, a `--train` that is not `<component>=<version>`, a config or `--index` file that can not be read. `--json`
prints `{ problems: [{ code, message, location }] }` on stdout. `build` runs the first group only, because it must
work on a release branch.

| Code                                                                                                                 | Rule                                                                                                                                                                                                                                                                                | Reads                                           |
| :------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| `format`, `duplicate-id`, `id-prefix`, `missing-schema-file`, `unknown-fact-id`, `local-path`, `unregistered-domain` | The fact format, ids, `$ref` files, references, paths and domains                                                                                                                                                                                                                   | sources, built indexes                          |
| `since-format`, `same-line`, `ambiguous-rows`, `describes`                                                           | `since` is a version, `next` or an array of versions on different release lines. Rows are not a tie. `describes` names at most one component and the entries agree                                                                                                                  | sources, built indexes                          |
| `relation-cycle`, `relates-foreign`, `history`, `derive`                                                             | `derivedFrom` is a DAG. Relations stay in the package. `history` rows fit. `derive` finds its upstream fact                                                                                                                                                                         | sources, installed upstream                     |
| `derive-version`                                                                                                     | `derived.lock.json` and a built index record the installed upstream version                                                                                                                                                                                                         | installed upstream, `derived.lock.json`         |
| `lib-rows`                                                                                                           | `facts/_lib` holds functions and constants, no row with `since`                                                                                                                                                                                                                     | `facts/_lib`, parsed with oxc                   |
| `since-ahead`                                                                                                        | `since` is not newer than `describes`, or than `--train <component>=<version>`                                                                                                                                                                                                      | sources, `--train`                              |
| `train-next`                                                                                                         | A component named by `--train` has no `next` left, except in a `pending` row                                                                                                                                                                                                        | sources, `--train`                              |
| `pending-untested`                                                                                                   | A `pending` label is passed as `include` by a test in `testDirs`                                                                                                                                                                                                                    | `testDirs`, parsed with oxc                     |
| `doc-unknown-id`                                                                                                     | `fact:<id>` and `fact:<spec>:<id>` in the markdown of `docsDirs` name facts that exist                                                                                                                                                                                              | `docsDirs`                                      |
| `impl-imports-facts`, `impl-reads-facts-dist`, `impl-depends-on-facts`                                               | The implementation does not import a `-facts` package or name a `facts/dist` path in `implDirs` (a literal string match: `join('facts', 'dist')` is not found, and other languages are out of scope), and a package that is not a facts package does not list one in `dependencies` | `implDirs`, every package.json under `repoRoot` |

The rules that read code use `oxc-parser`, an optional peer dependency. Add it (`pnpm add -D oxc-parser`) to a
package whose `check` uses `testDirs`, `implDirs` or `facts/_lib`. `--train` is for the release flow: a component
being released as `X.Y.Z` allows `since` up to `X.Y.Z` even though `describes` still names the last release.

## Reading

```ts
import { readFacts } from 'fact-kit'

// Resolved from `root` (default: process.cwd()), so each hub reads the version its lockfile pins.
const facts = readFacts('@scope/some-facts/cli', { root: hubRoot, version: '0.48.0', platform: 'claude-code' })
facts.value('tool.some-fact')
```

`spec` is `<package>` or `<package>/<path>`, and the path may have several segments. The package must export
`./index.json` or `./<path>/index.json`. Both index format 1.0 and 1.1 are read.

| Option     | Meaning                                                                                                          |
| :--------- | :--------------------------------------------------------------------------------------------------------------- |
| `root`     | Directory the package is resolved from                                                                           |
| `version`  | Version of the described component the reader runs, or `'head'`. Rows that start later are not read              |
| `include`  | Labels of `pending` rows that a reader on `head` also gets                                                       |
| `platform` | Platform of the reader. A row with a `platforms` condition is read only when it lists this one                   |
| `os`       | `'macos'`, `'linux'` or `'windows'`, same idea for `os` conditions                                               |
| `onRead`   | Called synchronously once per `get`, `value` and found `has`, and once per field other than `id` read on `facts` |

Without `version`, a described component that is installed under `root` sets it: the facts of the installed
version are read, and facts for an older version than `describes` names work too. An installed component that is
newer than `describes` makes `readFacts` throw, because the facts do not cover that version yet. When the
component is not installed (a CLI or a service), the reader gets the latest published rows.

`selectFacts(index, { version, include, platform, os })` is the same selection as a pure function over a parsed
`index.json`. Each fact in the result is flattened to the row that applies, with that row's `since` and
`stability`. Errors are `FactReadError` with a stable `code`: `not-an-index`, `unsupported-index-format`,
`not-found` and `invalid-version`.

`get(id)` and `value(id)` throw for an unknown id, so a misspelled id fails the build; `has(id)` tests for
one. `version` is the installed fact package's version, for citing where a fact came from.

`diffIndexFiles(oldPath, newPath)` and `diffIndexes(old, new)` list the added, removed and changed ids
between two builds, the same as `fact-kit diff`.

## Converting

Converters turn machine-readable upstream resources into fact content. The TypeScript ones need the
optional peer dependency `typescript` 7.1.0-beta or later (`pnpm add -D typescript@7.1.0-beta`). It is
loaded when a converter runs, so `readFacts` and `check` never pull it in, and a project that does not
convert does not install it. Without it, a converter throws an error that names the package to install.

TypeScript 7 runs its compiler as a native process, which `interfaceToJsonSchema` starts and closes
before it returns. Install the `typescript` package on the platform that runs the conversion, because
the native binary comes as a platform package.

| Function                                                                                 | Reads                                                      | Returns                                                                                                                                                                                                                                        |
| :--------------------------------------------------------------------------------------- | :--------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readStringTuplesFromFile(path)`, `readStringTuples(source)`                             | `export declare const X: readonly ['a', 'b']` in a `.d.ts` | Each tuple's name and values                                                                                                                                                                                                                   |
| `interfaceToJsonSchema({ path, type, tsconfig?, additionalProperties?, descriptions? })` | An interface or type alias in a `.d.ts`                    | A JSON Schema 2020-12 document; referenced types become `$defs`. JSDoc becomes `description`; `descriptions: false` removes every `description`. Union members and enum values keep the order of the source, and a tuple becomes `prefixItems` |
| `readJsonSchemaFile(path)`                                                               | A JSON Schema file                                         | The parsed schema                                                                                                                                                                                                                              |

## Tables

`flattenSchema(schema)` flattens a JSON Schema into rows of field path, type, required, description and
`x-` keywords, merging `allOf`. `schemaRowsToMarkdown(rows)` renders those rows as a Markdown table, for
docs that list fields from a fact instead of copying them.

## Value lists and generated doc blocks

`valueListToMarkdown(fact, { columns? })` renders a fact whose `content.value` is an array. An array of strings
gives one `- item` line each. An array of objects gives a table, with the keys as columns unless `columns`
picks them. It throws an error that names the fact id when the value is not an array.

`replaceFactBlocks(text, blocks)` rewrites the text between `<!-- facts:begin NAME -->` and
`<!-- facts:end NAME -->` with `blocks[NAME]` and returns `{ text, changed }`. It throws an error that names the
block when a `begin` has no `end`, a name appears twice, or `blocks` names a block the document does not have.
Blocks the document has but `blocks` does not name stay as they are.

`changed` is what a `--check` needs: write the file when it is true, and exit non-zero instead of writing when
the check flag is set. This script generates a README block from the built facts and checks it:

```js docs-example
// scripts/generate-docs.mjs: node scripts/generate-docs.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { replaceFactBlocks, valueListToMarkdown } from 'fact-kit'

const index = JSON.parse(readFileSync('dist/sdk/index.json', 'utf8'))
const kinds = index.facts.find((f) => f.id === 'demo.sdk.kinds')
const { text, changed } = replaceFactBlocks(readFileSync('README.md', 'utf8'), {
  kinds: valueListToMarkdown(kinds),
})

if (process.argv.includes('--check')) {
  console.log(changed ? 'README.md is out of date. Run: node scripts/generate-docs.mjs' : 'up to date')
  process.exit(changed ? 1 : 0)
}
if (changed) writeFileSync('README.md', text)
console.log(changed ? 'wrote README.md' : 'up to date')
```

## Examples

An example group shows how several facts are used together. `defineExamples` types one group or an array of them:

```ts
import { defineExamples } from 'fact-kit'

export default defineExamples({
  id: 'first-build',
  name: 'First build',
  situation: 'Starting from nothing',
  claim: 'One config file is enough for a first build',
  scenarios: [
    {
      title: 'One skill',
      situation: 'I only want a single skill',
      code: [{ caption: 'config', lang: 'ts', source: '...' }],
      outcome: ['One skill file is written'],
      points: ['No other declaration is needed'],
      facts: ['tool.some-fact'],
    },
  ],
})
```

`check` loads groups from the examples directory (`.ts` or `.json`) and rejects a group or scenario that
names a fact id not in the indexes it checks. `exampleFactRefs(group)` lists the ids a group names.
