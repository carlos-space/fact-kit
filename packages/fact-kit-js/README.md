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
fact-kit pin --version <v> [--cwd dir] [--config file] [--facts-dir dir]
fact-kit merge-since [--cwd dir]
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
package.json needs (`--write-exports` adds them). The index has `indexFormat: "1.2"`, and a fact with `variants`
gets the latest published row as its top-level `content`, which is what a reader of format 1.0 uses. `build` validates format and ids only; it does not scan
for local paths or domains, so run `check` before publishing.

### Pinning `next` and merging `since`

Both commands read the TypeScript sources with `oxc-parser` (an optional peer dependency; without it they print
what to install and exit with 2) and change only the text of a `since` literal, so nothing else in a file moves.

`fact-kit pin --version <v>` runs in a component package. In the rows under the facts directory it turns a `since`
that is `'next'`, or an array that ends in `'next'`, into `<v>`. A row with a `pending` label stays, and so do
`describes` and `<facts-dir>/_lib`. `<v>` is a semver 2.0.0 version, and a pre-release such as `0.49.0-alpha.1` is
written whole. It takes `--version` once: none, two, or a value that is not semver exits with 2 and changes nothing.
A second run changes nothing, because a pinned `since` is no longer `next`. A row that spreads another object
(`{ ...shared, since: 'next' }`) may get its `pending` from it, so `pin` leaves it and warns on stderr. Only objects
that are not fact content count as rows, so an object inside `content`, `value`, `schema`, `statement`, `add`,
`replace`, `remove` or `set` is data and is not changed.

`fact-kit merge-since` runs after `git merge` (while the merge is open, or once it is committed), in a directory of
the repository. Only files under that directory are read.

1. In each file that `git diff --name-only --diff-filter=U` lists, a conflict block whose two sides differ only in
   the `since` values is settled: the union of the versions, the smaller one when two are on one release line,
   ordered by release line with `next` last. Normal, `diff3` and `zdiff3` markers are read, and the base side is not
   used. A `since` written over several lines is not recognized, and neither is any other difference.
2. A row that only the merged-in side has (the same fact has no row with that `since` in `HEAD`), whose `since` is one
   patch version `X.Y.Z` (`Z` above 0, no pre-release) and that has no `pending`, becomes `['X.Y.Z', 'next']`. A row
   `HEAD` already had, such as a `'0.7.1'` that `pin` wrote on main, stays.

It writes what it settled, stages nothing, and prints each conflict left as `<file>:<line> <reason>`. Exit code: 0 all
settled, 1 conflicts left, 2 no merge to read, or bad input. A second run changes nothing.

### Two-layer packages

A repository can keep its facts in private component packages (named `@<publish target>/<publish name>-facts`, for example `@npm/git-facts`, `"private": true`)
and publish one aggregate package that holds all their indexes. The aggregate lists the components in
`devDependencies` (`"workspace:*"`) and in `fact-kit.config.json`:

```json
{ "aggregate": { ".": "@npm/fact-kit-facts", "fact-kit-py": "@pypi/fact-kit-facts" } }
```

`fact-kit build` in the aggregate package copies the built indexes of the components (build them first; with pnpm,
`pnpm -r build` orders them) into `dist/` and clears `dist/` before it writes. A component with one entry goes to
`dist/<sub-path>/`, the root component (`.`) to `dist/`. A component with several entries goes to
`dist/<sub-path>/<entry>/`, or `dist/<entry>/` for the root, and the build fails when that name is also another
sub-path. `schemas/` is copied along, and each index gets `./<dir>/index.json` and `./<dir>/schemas/*` in `exports`.
In the copied index, `package` is the aggregate name, `entry` is the path of the index in the aggregate (`.` for the
root), `component` is the component package, and `derivedFrom` and `movedTo` that name a component package become the published spec.
`readFacts('<aggregate>')`, `readFacts('<aggregate>/<sub-path>')` and `readFacts('<aggregate>/<sub-path>/<entry>')`
read them. Each component's `dist/examples.json` (see [Examples](#examples)) is copied to `dist/<sub-path>/examples.json`
(`dist/examples.json` for the root) with `package` set to the aggregate name, and `./<sub-path>/examples.json`
(`./examples.json`) is added to `exports`.

### Impact of a change

`fact-kit diff --impact <id>` runs in an aggregate package. It reads the built indexes of the components, follows
`derivedFrom` downstream and prints `{ id, facts: [{ id, depth, via }], docs: [{ file, line, id }], examples: [{ spec, group, scenario, id, in }] }` with `--json`.
`examples` lists the scenarios of the `examples.json` files that name the fact or a fact computed from it: `spec` is
the aggregate spec the file is published under, `group` the id of the example group, `scenario` its title, `id` the
fact named, and `in` is `facts` for `facts` of the scenario or its group, `outcome` for a reference in the outcome.
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

`remove` and `add` also work on an object, by property name. `remove: { '/properties': ['status'] }` drops the
property `status` and fails when there is none. `add: { '/properties': { note: { type: 'string' } } }` puts a new
property at the end and fails when the name is already there. `replace: { '/properties/status': {...} }` swaps one.
The `properties` of `entity`, `valueObject` and `domainEvent` are changed this way (see [DDD builders](#ddd-builders)).

A pointer never goes into an array by index. `'/steps/2/action'`, `'/list/-'` and `'/plain/1'` fail with `history`,
because a position changes when an item before it is added or removed. Name an item by its key (`remove`,
`replace` and `add` on a keyed array), or replace the whole array: an array that is not keyed is changed only by
`replace: { '/names': [...] }` or `set`. A pointer to the array itself, to a key of an object, or the empty root
pointer is fine.

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

### Writing facts with `factsOf`

`factsOf({ tool, source, prefix?, topics? })` returns `mf`, which writes the fields every fact of a file repeats. A
call such as `mf.value(name, value)` builds the fact with the id `<tool>.<prefix>.<name>` (`<tool>.<name>` without
`prefix`), the title `name`, the topics of `factsOf` followed by those of the call, and the source of `factsOf`.
`mf.schema(name, schema)` and `mf.statement(name, text)` do the same for the other two kinds of content. The
optional third argument is `{ title?, topics?, description?, when?, relates?, verify?, source?, note? }`. `note` is
merged into an observed source, and `source` replaces the source of `factsOf` for that fact. The result goes into
`facts` as it is.

```ts
import { factsOf, observedDoc, observedSpike, statementFrom, subsetOf } from 'fact-kit'

const doc = factsOf({
  tool: 'claude-code',
  source: observedDoc({ url: 'https://code.claude.com/docs/en/hooks.md', fetched: '2026-10-02' }),
  topics: ['hook'],
})
const trial = factsOf({ tool: 'claude-code', source: observedSpike({ fetched: '2026-10-03' }) })

const events = doc.value('hook-events', ['PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'])
const blocking = doc.value('hook-blocking-event-names', subsetOf(events, ['PreToolUse', 'Stop']))
const said = doc.statement(
  'hook-blocking-events',
  statementFrom(blocking, (names) => `A hook can block ${names.length} events: ${names.join(', ')}.`),
  { topics: ['blocking'], verify: { probe: { kind: 'manual', reason: 'Read the page.' }, verifiedOn: '2.1.285' } },
)
const compact = trial.statement('precompact-order', 'The hooks ran in the reverse order.', {
  note: 'One headless run.',
})
```

- `observedDoc({ url, fetched })` gives `{ kind: 'observed', basis: 'doc', url, fetched }`, and
  `observedSpike({ fetched, url? })` gives the same with `basis: 'spike'`. A measured source is written by hand.
  One `factsOf` has one source, so facts read on different dates come from different `factsOf` calls, or take
  `source` in the options.
- A method takes the content, the rows of `history(...)`, or a function that returns either. The rows must start
  with the kind of the method, and a mismatch throws `BuilderError` (`builder` in `check`). A name that is empty or
  starts or ends with a dot also throws it.
- A fact written with one object value has the fields of the value as read-only getters, so `status.states` reads
  the value of the fact `status`. Each getter returns a copy tagged with its origin, and the build adds the origin
  to `derivedFrom` where the copy is embedded. A field named like a fact field (`id`, `tool`, `topics`, `title`,
  `description`, `content`, `variants`, `derivedFrom`, `when`, `source`, `verify`, `relates`) has no getter. A fact
  written with `history(...)` has none either.
- A tag sticks to an object or an array, not to a scalar, so `status.initial` or `names.slice(1)` carries no tag.
  Write the value as a function, `mf.value(name, () => ({ first: status.initial }))`: every read of another fact
  while the function runs is added to `relates`, scalars included, and only reads inside that function count. An
  `mf` call inside the function collects its own reads.
- `contentOf(fact, since?)` returns a tagged copy of the value or schema of one row. A fact with several rows needs
  `since`, which names one row (any version of a row written as an array). It throws `BuilderError` when no row
  matches. This is how a fact written with `history(...)` is read.
- `statementFrom(fact, render, { since? })` calls `render` with `contentOf(fact, since)` and returns the text as a
  built statement that remembers the fact. Give it to `mf.statement` or to the `statement` of a `history` row, and
  the fact goes into `relates`, so the sentence follows the value.
- Order of `derivedFrom`: the `relates` option, the facts a built statement or a subset carries, the facts read by a
  function, then the tags and `factLink` placeholders in document order, each fact once.

`history(...)` copies the tags of fact-kit along with the values, so tagged values and `keyed` arrays survive every
row. A builder can put a check on what it makes, and `history` runs that check again after each row. A row that
breaks it throws `BuilderError` with the row, its `since` and the key.

### Subsets

`subsetOf(parent, items)` returns a keyed copy of `items` that must stay inside the list of the fact `parent`.
The parent is added to `relates`, so the subset lists it in `derivedFrom`.

- When the parent is a list with a known type, as in `doc.value('events', ['A', 'B'])`, the type checker rejects an
  item the parent does not have. `subsetOf(events, ['A', 'Z'])` fails to compile.
- When the parent comes from a conversion, its type is unknown and every item is accepted. Pass the fact object from
  the converted file, for example `(converted.facts as Fact[]).find((f) => f.id === 'claude-code.hook-events')`. It
  is the same object that `facts` lists, because Node loads the JSON once. `subsetOf` throws `BuilderError` when the
  object is missing.
- `check` and `build` test every subset at the version boundaries of the two facts: `head`, the latest published
  version, each version a row names, the next patch and the next release line, each with every platform, os and
  pending label of the rows. An item that the parent row lacks, or a boundary where the parent has no row, is a
  `subset-of` problem. The message names the oldest version where it happens and the item. Items are compared as
  JSON, so objects match whatever the order of their keys.

  ```text
  subset-of: claude-code.hook-blocking-event-names: at 2.1.300, "Setup" is not in claude-code.hook-events
  ```

- The index has no field for a subset, so only a check of the sources can run this test. `check --index` of a
  built index does not.
- A parent in another entry of the package works the same way. A parent in another package is brought in with
  `derive` first.

### Field references

`ref(fact, field?)` points at a fact of this package, or at a field of it, from the content of another fact. `fact` is
the fact object you import, not an id string. `field` is a dotted path such as `'limits.max'`: a schema is followed
through `properties`, a value through its object keys, and an array is not followed. When the type of the fact is
known, `ref(mainline, 'idd')` fails to compile. A fact written with `history(...)` or taken from a conversion accepts
any string, and `check` tests it.

```ts
import { factsOf, observedDoc, ref } from 'fact-kit'

const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }) })

const criterion = mf.schema('criterion', { type: 'object', properties: { text: { type: 'string' } } })
const mainline = mf.schema('mainline', {
  type: 'object',
  properties: { id: { type: 'string' }, criteria: { type: 'array', items: ref(criterion) } },
})
const closed = mf.schema('mainline-closed', {
  type: 'object',
  properties: { mainline: ref(mainline, 'id') },
})
const limits = mf.value('limits', { max: 3 })
const usage = mf.value('usage', { max: ref(limits, 'max'), whole: ref(limits) })
```

A `ref` is written in one of two ways, by where it stands.

| Where the `ref` stands                                                                         | Output                                                                                                                                 |
| :--------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| It is the whole value of a subschema (`properties`, `items`, `allOf`, `$defs` ...) of a schema | `{ "$ref": "#/$defs/<id>" }`, or `{ "$ref": "#/$defs/<id>/properties/a/properties/b" }` with the field `'a.b'`                         |
| Anywhere else: a value, a statement, a `const`, a longer string                                | `<location>`, or `<location>#a.b` with a field. The location is `<id>` in the same entry and `<package>/<entry>:<id>` in another entry |

For `closed` above, the build writes the `$ref` and puts the schema of the target into the `$defs` of the root:

```json
{
  "type": "object",
  "properties": { "mainline": { "$ref": "#/$defs/demo.mainline/properties/id" } },
  "$defs": {
    "demo.mainline": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "criteria": { "type": "array", "items": { "$ref": "#/$defs/demo.criterion" } }
      }
    },
    "demo.criterion": { "type": "object", "properties": { "text": { "type": "string" } } }
  }
}
```

and `usage` becomes `{ "max": "demo.limits#max", "whole": "demo.limits" }`. Both facts list what they point at in
`derivedFrom`: `demo.mainline` for `closed` and `demo.limits` for `usage`.

- `$defs` is keyed by fact id. A schema embedded by several `ref`s is there once, and the `$defs` of an embedded
  schema are moved up to the root, so the `$ref`s inside it stay valid.
- A `ref` in a subschema position must point at a schema. A `$ref` to a value or a statement is a `ref` problem,
  and so is a field of a statement.
- A fact object that no entry lists in `facts` is `relates-foreign`, and the message says to list it. An object that
  comes from another package is also `relates-foreign`, and the message says to use `derive`.
- `check` reads the rows of the fact that writes the `ref` and of the target at every version boundary of the two
  (the boundaries of `subset-of`). Where a reader gets a row that writes the `ref`, the target must have a row for
  that reader with the field, or the problem is `ref` and the message names the oldest version:

  ```text
  ref: demo.user: at 1.1.0, ref(demo.target, "old") points at nothing: it has no field "old"
  ```

- A schema that was embedded keeps working when it points at its own root. In the embedded copy, `$ref: "#"` and
  `$ref: "#/properties/x"` become `#/$defs/<id>` and `#/$defs/<id>/properties/x`. A `$ref` into its own `$defs`
  (`#/$defs/name`), a plain-name anchor (`#name`) and a `$ref` with a file or URL stay as they are, and a schema that
  has an `$id` at its top is a root of its own and is left whole. `$dynamicRef`, `$recursiveRef`, and a `#`-relative
  `$ref` inside a subschema that has its own `$id` can not be moved safely, so they are `ref` problems.
- A schema that embeds itself, or two schemas that embed each other, is a `ref` problem that lists the loop. So is a
  `$defs` key that already holds another schema, a field path with an empty part, a field whose name has a dot, and a
  schema of another entry with a file `$ref` (`schemas/x.schema.json`), because the relative path breaks once the
  schema is embedded in another entry.
- `guard` of a `stateMachine` transition takes a `ref(fact)`. The built value holds the location, and
  `stateMachineToMermaid` draws it as the label.

#### Rows of the target

When the target has several rows, the build aligns the rows of the fact that writes the `ref` with them. The fact gets
one row for each combination of its own row and the rows of the target that some reader gets together, found at every
version boundary of the two facts (the boundaries of `subset-of`). The `$defs` of each row holds the schema of the
target for that combination. A fact that wrote one row becomes a fact with `variants`, and the output is a standard
JSON Schema, so a reader changes nothing. Afterwards the build reads again the row each reader gets and compares it
with the row that reader gets from the target. A `ref` problem that names the reader is reported when they differ, and
when the rows can not be written: a `since` that is an array on one row and another `since` on the row it combines
with, or two different `pending` labels. A row keeps its `stability`, and gets the `platforms` and `os` that both
rows share.

```ts
const target = mf.schema(
  'target',
  history(
    { since: '0.7.0', schema: { type: 'object', properties: { id: { type: 'string' } } } },
    { since: 'next', schema: { type: 'object', properties: { id: { type: 'string' }, extra: { type: 'integer' } } } },
  ),
)
const user = mf.schema('user', { type: 'object', properties: { t: ref(target) } }) // one row
// built: user has two rows, `0.7.0` whose $defs holds the first schema and `next` whose $defs holds the second
```

### Entity identity

`x-identity` is a registered keyword of a schema. Its value is the name of one field, or at least two distinct names
for an identity made of several fields. A list of one name is not valid, so one identity has one way to be written.

```json
{
  "type": "object",
  "x-identity": ["mainline", "id"],
  "properties": { "mainline": { "type": "string" }, "id": { "type": "string" } }
}
```

`check` tests that every name is in the `properties` of the same schema, in every row of a fact and in every file
under `schemas/`, and reports `schema-property` with the names that are missing.

### Flows

`stateMachine`, `relations` and `sequence` make a value for `mf.value(name, ...)`. Each keeps its collections
`keyed`, so the rows of `history(...)` change them by key, and each checks its own output again after every row.

```ts
import { factsOf, history, observedDoc, relations, sequence, stateMachine } from 'fact-kit'

const mf = factsOf({ tool: 'demo', source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }) })

const lifecycle = mf.value(
  'lifecycle',
  stateMachine({
    initial: 'draft',
    states: ['draft', 'active', 'done'],
    transitions: [
      { from: 'draft', to: 'active', event: 'start' },
      { from: 'active', to: 'done', event: ['finish', 'close'], guard: 'all criteria met' },
    ],
  }),
)
const model = mf.value(
  'model',
  relations({
    nodes: ['mainline', 'task'],
    edges: [{ from: 'mainline', to: 'task', name: 'has', cardinality: 'many' }],
  }),
)
const closing = mf.value(
  'closing',
  history(
    {
      since: '1.0.0',
      value: sequence({
        participants: ['user', 'api'],
        steps: [{ from: 'user', to: 'api', action: 'close' }],
      }),
    },
    { since: '1.1.0', add: { '/steps': [{ from: 'api', to: 'user', action: 'confirm' }] } },
  ),
)
```

| Builder        | Value                              | Collection                                   | Key (how a `history` row names an item)                              |
| :------------- | :--------------------------------- | :------------------------------------------- | :------------------------------------------------------------------- |
| `stateMachine` | `{ initial, states, transitions }` | `states`                                     | the name: `remove: { '/states': ['blocked'] }`                       |
|                |                                    | `transitions` `{ from, to, event?, guard? }` | `from` and `to`: `remove: { '/transitions': [['active', 'done']] }`  |
| `relations`    | `{ nodes, edges }`                 | `nodes`                                      | the name: `remove: { '/nodes': ['b'] }`                              |
|                |                                    | `edges` `{ from, to, name, cardinality? }`   | `from`, `to` and `name`: `remove: { '/edges': [['a', 'b', 'has']] }` |
| `sequence`     | `{ participants, steps }`          | `participants`                               | the name                                                             |
|                |                                    | `steps` `{ from, to, action }`               | `action`, which no two steps share: `remove: { '/steps': ['ask'] }`  |

- Several events between the same two states are one transition whose `event` is a list. `guard` is a string and
  holds for every event of the transition.
- Each rule of `history(...)` applies to these collections: `replace` with a list of items swaps them in by key and
  fails when no item has the key, `remove` fails the same way, and `add` fails when the key is already there. A key
  that appears twice in one collection fails, when the builder is called and when a row sets the list whole.
- `add` appends at the end, so a step can only be added last. To insert a step in the middle or to rename an
  `action`, replace the list: `replace: { '/steps': keyed([...], ['action']) }`.
- Every end must be declared. `stateMachine` checks that `initial` and the `from` and `to` of each transition are
  in `states`, `relations` that the `from` and `to` of each edge are in `nodes`, and `sequence` that the `from`
  and `to` of each step are in `participants`. A violation throws `BuilderError`, the message names the key
  (`transition ["a","b"]: "to" is "b", which is not in states`), and `check` reports it as `builder`. `history`
  runs the check after each row, so a row that removes a state a transition still uses fails until it removes the
  transition too.

`stateMachineToMermaid`, `relationsToMermaid` and `sequenceToMermaid` take the value, or a fact whose content is
that value, and return mermaid text without a code fence. Every state, node and participant gets a generated id
(`s0`, `n0`, `p0`, in the order declared) and keeps its name as the label, so a name with spaces or punctuation is
safe. `#`, `"`, `;` and `|` in a name become mermaid entities.

```text
stateDiagram-v2
    state "draft" as s0
    state "active" as s1
    state "done" as s2
    [*] --> s0
    s0 --> s1: start
    s1 --> s2: finish, close [all criteria met]
```

`relationsToMermaid` draws a `flowchart LR` with `n0["mainline"]` and `n0 -->|has| n1`, and `sequenceToMermaid` a
`sequenceDiagram` with `participant p0 as user` and `p0->>p1: close`. `cardinality` is not drawn.

### DDD builders

`entity`, `valueObject`, `domainEvent`, `aggregate`, `invariant` and `useCase` write the layers of a domain as the
three kinds of content, and `mf.*` adds the `ddd:` topic and `derivedFrom` for you. The example is the domain of a
mainline that can be closed once its criteria are done.

```ts
import { domainEvent, entity, factsOf, invariant, ref, stateMachine, useCase, valueObject } from 'fact-kit'
import { published, tool } from '../_lib/product.ts'

const mf = factsOf({ tool, source: published, prefix: 'domain' })

export const criterion = mf.schema(
  'criterion',
  valueObject({ id: { type: 'string', pattern: '^r\\d{3}$' }, text: { type: 'string' }, done: { type: 'boolean' } }),
)
export const mainlineStatus = mf.value(
  'mainline.status',
  stateMachine({
    initial: 'planning',
    states: ['planning', 'active', 'blocked', 'done', 'dropped'],
    transitions: [
      { from: 'planning', to: 'active' },
      { from: 'active', to: 'done', guard: 'mainline.close-requires-criteria' },
    ],
  }),
)
export const mainline = mf.schema(
  'mainline',
  entity({
    identity: 'id',
    fields: {
      id: { type: 'string', pattern: '^m\\d{3}$' },
      status: { enum: mainlineStatus.states },
      criteria: { type: 'array', items: ref(criterion) },
    },
  }),
)
export const closeRequiresCriteria = mf.statement(
  'mainline.close-requires-criteria',
  invariant(mainline, { 'zh-TW': '解決條件全部勾選後，主脈絡才能標為 done' }),
)
export const mainlineClosed = mf.schema(
  'mainline-closed',
  domainEvent({ mainline: ref(mainline, 'id'), closedAt: { type: 'string', format: 'date-time' } }),
)
export const closeMainline = mf.value(
  'close-mainline',
  useCase({
    input: ref(mainline, 'id'),
    steps: [
      { layer: 'application', action: '讀取主脈絡' },
      { layer: 'domain', action: '檢查不變條件', rule: closeRequiresCriteria },
      { layer: 'domain', action: '發出事件', emits: mainlineClosed },
    ],
    errors: ['criteria-not-done', 'mainline-not-found'],
  }),
)
```

| Builder       | Content   | Topic              | What it makes                                                                                           |
| :------------ | :-------- | :----------------- | :------------------------------------------------------------------------------------------------------ |
| `valueObject` | schema    | `ddd:value-object` | `{ type: 'object', properties, required? }`                                                             |
| `entity`      | schema    | `ddd:entity`       | `{ type: 'object', 'x-identity', properties, required? }`. `identity` is a field name or two or more    |
| `domainEvent` | schema    | `ddd:domain-event` | the same shape as `valueObject`                                                                         |
| `aggregate`   | value     | `ddd:aggregate`    | `{ root, members }`, each member `{ entity, cardinality }`, `cardinality` `'one'` (default) or `'many'` |
| `invariant`   | statement | `ddd:invariant`    | the text you give, with the subject in `relates`                                                        |
| `useCase`     | value     | `ddd:use-case`     | `{ input?, output?, steps, errors }`, each step `{ layer, action, rule?, emits?, calls? }`              |

The topics come first, then those of `factsOf`, then those of the call. Each builder is checked against the method
it goes to, so `mf.value(name, entity(...))` fails with `BuilderError`. A fact given in `root`, `entity`, `rule`,
`emits` or `calls` is written as the fact location after the build and goes into `derivedFrom`. A property that is
a `ref(fact)` becomes a `$ref` into `$defs`, as in [Field references](#field-references). Reading a field of
another fact (`mainlineStatus.states`) puts that fact into `derivedFrom`.

A domain service, a repository and an infrastructure contract have no builder, because their content is already a
schema or a statement. Write the input and output with `mf.schema` and the behaviour with `mf.statement`, and give
them the same `ddd:` prefix by hand:

```ts
export const placeOrderInput = mf.schema(
  'place-order.input',
  { type: 'object', properties: { order: ref(order, 'id') } },
  { topics: ['ddd:domain-service'] },
)
export const orderRules = mf.statement('order-pricing', 'A discount never takes the total below zero.', {
  topics: ['ddd:domain-service'],
})
export const orderRepository = mf.schema(
  'order-repository.find',
  { type: 'object', properties: { id: { type: 'string' } } },
  { topics: ['ddd:repository'] },
)
```

Write only the operation names and their input and output schemas for a repository, and leave out the database and
the query. Use `ddd:infrastructure` for the contract of a table, an environment variable or an API path.

Write an entity as a schema, write a relation as a `relations` value, and let the side that uses them draw the diagram. fact-kit has no ER diagram. Use `relationsToMermaid` on a `relations` value for the flow of relations, and
`sequenceToMermaid` takes a `useCase` (below).

How a `history` row names an item of a DDD collection, together with the flow collections above:

| Builder                 | Collection            | Key (how a `history` row names an item)                                                                                                                                                                                                                                                                               |
| :---------------------- | :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateMachine`          | `states`              | the name: `remove: { '/states': ['blocked'] }`                                                                                                                                                                                                                                                                        |
| `stateMachine`          | `transitions`         | `from` and `to`: `remove: { '/transitions': [['active', 'done']] }`                                                                                                                                                                                                                                                   |
| `relations`             | `nodes`               | the name: `remove: { '/nodes': ['b'] }`                                                                                                                                                                                                                                                                               |
| `relations`             | `edges`               | `from`, `to` and `name`: `remove: { '/edges': [['a', 'b', 'has']] }`                                                                                                                                                                                                                                                  |
| `sequence`              | `steps`               | `action`, which no two steps share: `remove: { '/steps': ['ask'] }`                                                                                                                                                                                                                                                   |
| `entity`, `valueObject` | fields (`properties`) | the property name, not a keyed array: `remove: { '/properties': ['status'] }`, `add: { '/properties': { note: {...} } }`, `replace: { '/properties/status': {...} }`. `required` is a keyed list of names: drop the field and its name together with `remove: { '/properties': ['status'], '/required': ['status'] }` |
| `aggregate`             | `members`             | the entity position, field `entity`: `remove: { '/members': [factLink(line)] }`                                                                                                                                                                                                                                       |
| `useCase`               | `steps`               | `action`, which no two steps share: `remove: { '/steps': ['發出事件'] }`. `add` appends at the end                                                                                                                                                                                                                    |
| `useCase`               | `errors`              | the code: `add: { '/errors': ['mainline-locked'] }`                                                                                                                                                                                                                                                                   |
| `domainEvent`           | fields (`properties`) | the same as the fields of `entity`                                                                                                                                                                                                                                                                                    |
| `invariant`             | no collection         | rewrite the whole sentence: `{ since: 'next', statement: invariant(mainline, {...}) }`. `set: { '': text }` works too, but only the rewrite row carries the new `relates`                                                                                                                                             |

```ts
import { entity, factLink, history, keyed } from 'fact-kit'

const first = entity({
  identity: 'id',
  fields: { id: { type: 'string' }, status: { enum: ['open', 'closed'] } },
  required: ['id', 'status'],
})
const person = mf.schema(
  'person',
  history(
    { since: '1.0.0', schema: first },
    {
      since: '1.1.0',
      remove: { '/properties': ['status'], '/required': ['status'] },
      add: { '/properties': { note: { type: 'string' } } },
    },
  ),
)
```

Every row is checked again by the builder that made the content. A row that drops a field but leaves its name in
`required`, or in `x-identity`, fails with `BuilderError` and `check` reports `builder`. A row that adds a step
whose `layer` is not `application`, `domain` or `infrastructure` fails the same way. A key that appears twice in a
collection fails with `history`. To give an entity a `required` list in a later row, set it whole with
`set: { '/required': keyed(['id']) }`.

`sequenceToMermaid` also takes a `useCase`, or a fact whose value is one. The participants are `caller` and then each
`layer` in the order of first use, and each step is a message from the layer of the step before it (`caller` for
the first step) to its own layer.

```text
sequenceDiagram
    participant p0 as caller
    participant p1 as application
    participant p2 as domain
    p0->>p1: 讀取主脈絡
    p1->>p2: 檢查不變條件
    p2->>p2: 發出事件
```

## Check rules

`check` exits with 0 when it finds no problem, 1 when it finds problems and 2 when it can not run: an unknown
option, a `--train` that is not `<component>=<version>`, a config or `--index` file that can not be read. `--json`
prints `{ problems: [{ code, message, location }] }` on stdout. `build` runs the first group only, because it must
work on a release branch.

| Code                                                                                                                 | Rule                                                                                                                                                                                                                                                                                | Reads                                           |
| :------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| `format`, `duplicate-id`, `id-prefix`, `missing-schema-file`, `unknown-fact-id`, `local-path`, `unregistered-domain` | The fact format, ids, `$ref` files, references, paths and domains                                                                                                                                                                                                                   | sources, built indexes                          |
| `since-format`, `same-line`, `ambiguous-rows`, `describes`                                                           | `since` is a version, `next` or an array of versions on different release lines. Rows are not a tie. `describes` names at most one component and the entries agree                                                                                                                  | sources, built indexes                          |
| `subset-of`                                                                                                          | A list made with `subsetOf` has, at every version boundary, only items of the list of its parent. `build` runs it too                                                                                                                                                               | sources                                         |
| `ref`                                                                                                                | A `ref(fact, field?)` points at a field that exists in the rows the two facts share, a `$ref` points at a schema, and `$defs` has no loop or clash. `build` runs it too                                                                                                             | sources                                         |
| `schema-property`                                                                                                    | Every name in `x-identity` is in the `properties` of the same schema                                                                                                                                                                                                                | sources, built indexes, `schemas/`              |
| `relation-cycle`, `relates-foreign`, `history`, `builder`, `derive`                                                  | `derivedFrom` is a DAG. Relations stay in the package. `history` rows fit, and so do the arguments of `factsOf` and the checks of builders. `derive` finds its upstream fact                                                                                                        | sources, installed upstream                     |
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
`./index.json` or `./<path>/index.json`. Index formats 1.0, 1.1 and 1.2 are read.

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
newer than `describes` makes `readFacts` throw `FactReadError` with the code `describes-behind`, because the
facts do not cover that version yet. When the component is not installed (a CLI or a service), the reader gets the
latest published rows.

`describes` is keyed by the component name, which is not always the npm package name. An entry can say where the
component is published with `publish: { target, name }` (index format 1.2, optional), where `target` is `npm`,
`pypi`, `crates`, `go` or `swift` and `name` is the package name on that target, e.g. `{ target: 'npm', name: 'fact-kit' }`
for the component `fact-kit-js`. The check against the installed version follows `publish`:

- `target` is `npm`: `readFacts` looks for `node_modules/<publish.name>/package.json` and compares that version.
- `target` is anything else: nothing is compared, and the reader gets the latest published rows.
- No `publish` (an index before 1.2, or an entry that leaves it out): the key of `describes` is the package name, as before.

`check` reports `publish` when entries of one package disagree on it, and `reader.publish` returns the field as the index has it.

`selectFacts(index, { version, include, platform, os })` is the same selection as a pure function over a parsed
`index.json`. Each fact in the result is flattened to the row that applies, with that row's `since` and
`stability`. Errors are `FactReadError` with a stable `code`: `not-an-index`, `unsupported-index-format`,
`not-found`, `invalid-version` and `describes-behind` (the installed component is newer than `describes`).

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

An example group shows how several facts are used together. `defineExamples` types one group or an array of them.
The `outcome` of a scenario is a list of strings and references to facts, so the text next to the code follows the
facts instead of being copied from them:

```ts
import { defineExamples, ref, statementFrom } from 'fact-kit'
import { limits } from '../facts/demo/index.ts'

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
      outcome: [
        'One skill file is written',
        ref(limits, 'max'), // { fact: 'demo.limits', field: 'max' }
        statementFrom(limits, (v) => `At most ${v.max} skills`), // { fact: 'demo.limits', text: 'At most 3 skills' }
        { fact: 'demo.limits' }, // the same as ref(limits), for a .json file
      ],
      points: ['No other declaration is needed'],
      facts: ['demo.limits'],
    },
  ],
})
```

The code in `code` is text. fact-kit never runs it, so a snippet may be code that throws. `check` loads groups from the
examples directory (`.ts` or `.json`) and rejects a group or scenario that names a fact id not in the indexes it checks,
in `facts` or in an `outcome` item (`unknown-fact-id`, naming the id), and an outcome `field` that no row of the fact has
(`ref`). `build` runs the same check and writes the groups to `dist/examples.json` as `{ package, examples }`, where
`ref(fact)` and `statementFrom(fact, render)` have become `{ fact, field? }` and `{ fact, text }` (`text` is a
`Text`, so it can have one string per language). Rebuild after a fact changes and the `text` follows. It adds
`./examples.json` to `exports`, and `index.json` does not change. `fact-kit diff --impact` lists the scenarios that name a
fact. `exampleFactRefs(group)` lists the ids a group names, each with its JSON pointer, `in` (`facts` or `outcome`) and
`field`.
