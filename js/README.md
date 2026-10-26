# fact-kit

Tooling to declare, check, build and read facts. Facts are published as plain JSON and JSON Schema, so
reading them needs no fact-kit. This package helps with writing, checking, building and reading.

## Install

Add it as a dev dependency of the package that declares facts, and as a dependency where code reads them:

```sh
pnpm add -D fact-kit
```

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
               [--index path]... [--allow-domain host]...
fact-kit build [--cwd dir] [--facts-dir dir] [--out-dir dir] [--write-exports]
fact-kit diff <old> <new> [--json]
```

`check` validates every fact against the meta-schema, rejects duplicate ids, local absolute paths and
domains that are not in the allowed list, and checks that examples only reference existing fact ids.
Settings can live in `fact-kit.config.json` (`factsDir`, `examplesDir`, `indexFiles`, `allowedDomains`).

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

Converters turn machine-readable upstream resources into fact content. The TypeScript ones load
TypeScript 5 on demand, so `readFacts` and `check` do not pull it in.

| Function                                                                                 | Reads                                                      | Returns                                                                                                                                         |
| :--------------------------------------------------------------------------------------- | :--------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| `readStringTuplesFromFile(path)`, `readStringTuples(source)`                             | `export declare const X: readonly ['a', 'b']` in a `.d.ts` | Each tuple's name and values                                                                                                                    |
| `interfaceToJsonSchema({ path, type, tsconfig?, additionalProperties?, descriptions? })` | An interface or type alias in a `.d.ts`                    | A JSON Schema 2020-12 document; referenced types become `$defs`. JSDoc becomes `description`; `descriptions: false` removes every `description` |
| `readJsonSchemaFile(path)`                                                               | A JSON Schema file                                         | The parsed schema                                                                                                                               |

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
