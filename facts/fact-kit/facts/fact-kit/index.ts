// Facts about fact-kit itself. They are the spec, and fact-kit's code does not import them. The tests in
// test/fact-kit-spec.test.ts compare each one with the implementation, so a change on either side fails there.
import { history, keyed } from '../../../../js/src/index.ts'
import type { FactDecl, FactsSource } from '../../../../js/src/index.ts'
import kit from '../../../../js/package.json' with { type: 'json' }

const published = { kind: 'published' } as const
const nonEmpty = { type: 'string', minLength: 1 }
const list = { type: 'array', items: nonEmpty }

const defs = {
  Since: {
    description:
      'When a row starts to apply: a version (a pre-release such as `0.49.0-alpha.1` is fine), `"next"` for the release that is not out yet, or an array with one version per release line `X.Y`. The array may end in `"next"`, which only a reader on `head` uses.',
    oneOf: [nonEmpty, { type: 'array', minItems: 1, items: nonEmpty }],
  },
  Text: {
    description: 'A string, or one string per language. Prompts take `zh-TW` and fall back to `en`.',
    oneOf: [
      nonEmpty,
      {
        type: 'object',
        properties: { en: nonEmpty, 'zh-TW': nonEmpty },
        additionalProperties: false,
        minProperties: 1,
      },
    ],
  },
  JsonSchema: {
    description: 'A JSON Schema 2020-12 document or subschema. Only the registered `x-` keywords are allowed.',
    type: ['object', 'boolean'],
  },
  Probe: {
    description: 'How an observed fact is re-checked without a model.',
    oneOf: [
      {
        type: 'object',
        required: ['kind', 'anchor', 'hash'],
        additionalProperties: false,
        properties: { kind: { const: 'hash' }, anchor: nonEmpty, hash: nonEmpty, url: nonEmpty },
      },
      {
        type: 'object',
        required: ['kind', 'path'],
        additionalProperties: false,
        properties: { kind: { const: 'sample' }, path: nonEmpty },
      },
      {
        type: 'object',
        required: ['kind', 'reason'],
        additionalProperties: false,
        properties: { kind: { const: 'manual' }, reason: nonEmpty },
      },
    ],
  },
  Source: {
    description:
      'Where the fact comes from. `published` is written by the tool itself, `converted` is generated from an upstream file, `observed` is read from documentation or measured, `derived` is computed from a fact of another fact package.',
    oneOf: [
      { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'published' } } },
      {
        type: 'object',
        required: ['kind', 'from', 'converter', 'upstream'],
        additionalProperties: false,
        properties: {
          kind: { const: 'converted' },
          from: { ...nonEmpty, description: 'The upstream file the fact was converted from.' },
          converter: { ...nonEmpty, description: 'The script that did the conversion.' },
          upstream: { ...nonEmpty, description: 'The upstream version or commit the conversion read.' },
        },
      },
      {
        type: 'object',
        required: ['kind', 'from', 'version'],
        additionalProperties: false,
        properties: {
          kind: { const: 'derived' },
          from: {
            ...nonEmpty,
            description: 'The spec of the upstream index: `<package>` or `<package>/<path>`.',
          },
          version: {
            ...nonEmpty,
            description:
              'The version of the upstream fact package that was installed when the fact was built. The fact it was computed from is in `derivedFrom`.',
          },
        },
      },
      {
        type: 'object',
        required: ['kind', 'basis'],
        additionalProperties: false,
        properties: {
          kind: { const: 'observed' },
          basis: { enum: ['doc', 'measured', 'spike'] },
          url: nonEmpty,
          fetched: {
            ...nonEmpty,
            description:
              'Date the source was read. It differs from `verify.verifiedOn` when a later check kept the fact.',
          },
          note: {
            $ref: '#/$defs/Text',
            description:
              'What was observed on: environment, version and sample size of a measurement, or the sources of a document.',
          },
        },
      },
    ],
  },
}

const factSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:fact-kit:fact',
  title: 'Fact',
  type: 'object',
  required: ['id', 'tool', 'topics', 'title', 'content', 'source'],
  // Fields this version does not know are allowed. A reader skips them.
  $defs: defs,
  properties: {
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9._-]*$',
      description: '`<tool>.<name>`, unique across all sources. It must start with `tool` and a dot.',
    },
    tool: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    topics: list,
    title: { $ref: '#/$defs/Text' },
    description: { $ref: '#/$defs/Text', description: 'What the fact does. Rationale stays in the spec docs.' },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { description: 'Lists, constants and lookup tables.' },
        schema: { $ref: '#/$defs/JsonSchema', description: 'A field shape. It may `$ref` a file under `schemas/`.' },
        statement: { $ref: '#/$defs/Text', description: 'One sentence of behavior.' },
      },
      oneOf: [{ required: ['value'] }, { required: ['schema'] }, { required: ['statement'] }],
    },
    variants: {
      description:
        'Rows of a fact whose content changes by version or differs by platform. `content` then holds the latest published row, for readers of index format 1.0. Without `variants` the whole fact is one row that starts at `when.since` and has the conditions `when.platforms` and `when.os`.',
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['since', 'content'],
        additionalProperties: false,
        properties: {
          since: { $ref: '#/$defs/Since' },
          content: { $ref: '#/properties/content' },
          pending: {
            ...nonEmpty,
            description: 'Label of planned content. Only a reader on `head` that includes the label gets the row.',
          },
          stability: {
            enum: ['experimental'],
            description: 'Experimental rows are read by default and carry the mark.',
          },
          platforms: {
            ...list,
            description: 'Platforms the row applies to. A reader that names none does not get it.',
          },
          os: {
            type: 'array',
            items: { enum: ['macos', 'linux', 'windows'] },
            description: 'Operating systems the row applies to. A reader that names none does not get it.',
          },
        },
      },
    },
    derivedFrom: {
      ...list,
      description:
        'Locations of the facts this one is computed from: `<id>` in the same entry, `<spec>:<id>` in another entry or package. The build writes them from `relates`, `factLink` and `derive`.',
    },
    when: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platforms: list,
        os: { type: 'array', items: { enum: ['macos', 'linux', 'windows'] } },
        since: { $ref: '#/$defs/Since' },
        deprecatedIn: nonEmpty,
        removeIn: nonEmpty,
        replacement: {
          description: 'Id, or ids, of the facts that replace this one.',
          oneOf: [nonEmpty, { type: 'array', minItems: 1, items: nonEmpty }],
        },
        movedTo: {
          type: 'string',
          pattern: '^(?:[^:\\s]+:)?[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9._-]*$',
          description:
            'Where the fact lives now: `<id>` in the same entry, or `<spec>:<id>` in another package or entry.',
        },
      },
    },
    source: { $ref: '#/$defs/Source' },
    verify: {
      description: 'Observed facts only.',
      type: 'object',
      required: ['probe', 'verifiedOn'],
      additionalProperties: false,
      properties: {
        probe: { $ref: '#/$defs/Probe' },
        verifiedOn: nonEmpty,
        screenedThrough: nonEmpty,
      },
    },
  },
}

const indexSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Fact index (dist/<entry>/index.json)',
  type: 'object',
  required: ['package', 'entry', 'describes', 'facts'],
  // Fields this version does not know are allowed. A reader skips them.
  properties: {
    indexFormat: {
      type: 'string',
      pattern: '^[0-9]+\\.[0-9]+$',
      description: '`1.1` for what this version builds. A missing field reads as `1.0`. Readers take any `1.x`.',
    },
    package: nonEmpty,
    entry: {
      ...nonEmpty,
      description:
        'Sub-path of the entry, e.g. `claude-code`. In an aggregate package it is the path of the index in that package, and `.` for the root.',
    },
    component: {
      ...nonEmpty,
      description: 'Aggregate package only: the name of the component package the index was built in.',
    },
    formatVersion: nonEmpty,
    describes: {
      description:
        'The component this entry describes and the latest published version it covers, e.g. `{ "claude-code": "2.1.308" }`. `{}` means the described thing has no version. `check` rejects an entry with several keys, and entries of one package that disagree (different components, or `{}` mixed with a component).',
      type: 'object',
      additionalProperties: nonEmpty,
    },
    facts: { type: 'array', items: { $ref: 'urn:fact-kit:fact' } },
  },
}

const entryModuleSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Default export of facts/<entry>/index.ts',
  type: 'object',
  required: ['describes', 'facts'],
  additionalProperties: false,
  properties: {
    describes: { type: 'object', additionalProperties: nonEmpty },
    formatVersion: nonEmpty,
    facts: {
      description:
        'Facts as they appear in the index, with three differences that the build resolves. `variants` may be the result of `history(...)`, and `content` may then be left out. `relates` lists other fact objects of this package, which become `derivedFrom`. An item may be `derive(upstreamSpec, id, map?)`, a fact computed from an installed upstream package.',
      type: 'array',
      items: { $ref: 'urn:fact-kit:fact' },
    },
  },
}

const configSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'fact-kit.config.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    factsDir: { type: 'string', default: 'facts', description: 'Directory of fact sources, relative to the package.' },
    examplesDir: {
      type: 'string',
      default: 'examples',
      description: 'Directory of example files, relative to the package.',
    },
    indexFiles: {
      ...list,
      description: 'Built `index.json` files (or directories holding one) that `check` reads as well.',
    },
    allowedDomains: {
      ...list,
      description: 'Hosts URLs in facts may point at. A subdomain of an entry is allowed too.',
    },
    aggregate: {
      type: 'object',
      additionalProperties: nonEmpty,
      description:
        'Aggregate package only: sub-path (`.` for the root) -> the component package whose built indexes `build` copies there. See `fact-kit.aggregate-layout`.',
    },
    repoRoot: {
      type: 'string',
      default: 'the nearest parent that holds .git',
      description:
        'Root of the repository, relative to the package. `check` reads every package.json under it and reports a package that is not a facts package but lists a `-facts` package in `dependencies`.',
    },
    testDirs: {
      ...list,
      description:
        'Directories of tests, relative to the package. A `pending` label must be passed as `include` by a test there.',
    },
    docsDirs: {
      ...list,
      description:
        'Directories, relative to the package. `check` reports a `fact:<id>` or `fact:<spec>:<id>` in the markdown there that names no fact. `diff --impact` searches them for references to a fact: markdown, and `get`, `value` and `has` calls in TypeScript.',
    },
    implDirs: {
      ...list,
      description:
        'Directories of the implementation, relative to the package. Code there must not import a `-facts` package.',
    },
  },
}

/** The `x-` keywords a schema may use, with the shape of each value. */
const xKeywords = {
  'x-since': { type: 'string' },
  'x-deprecatedIn': { type: 'string' },
  'x-removeIn': { type: 'string' },
  'x-replacement': { type: 'string' },
  'x-platforms': { type: 'array', items: { type: 'string' } },
  'x-diagnostic': { type: 'string' },
  'x-defaultRule': { type: 'string' },
}

const dirOption = (flag: string, value: string, defaultValue: string, summary: string) => ({
  flag,
  value,
  default: defaultValue,
  summary,
})

const commands = {
  global: {
    options: [
      { flag: '-h', alias: '--help', summary: 'Show the help text and exit with 0.' },
      { flag: '-v', alias: '--version', summary: 'Print the fact-kit version.' },
    ],
    exitCodes: {
      '0': 'No problem found.',
      '1': 'A problem was found, or the command failed. For `merge-since`: a conflict is left.',
      '2': 'Wrong usage or input: no command, an unknown command or option, the wrong number of arguments, a `--train` that is not `<component>=<version>`, a `pin` with no `--version`, with more than one, or with one that is not semver, a config or index file that can not be read, a source file that can not be parsed, `oxc-parser` that is not installed, or a `merge-since` outside a git merge.',
    },
  },
  check: {
    summary: 'Validate facts, examples and what must not ship (local paths, unregistered domains).',
    arguments: [],
    options: [
      dirOption('--cwd', '<dir>', 'the current directory', 'Package directory.'),
      dirOption('--config', '<file>', 'fact-kit.config.json when present', 'Config file.'),
      dirOption('--facts-dir', '<dir>', 'facts', 'Fact sources, relative to --cwd.'),
      dirOption('--examples-dir', '<dir>', 'examples', 'Example files, relative to --cwd.'),
      {
        ...dirOption('--index', '<path>', 'none', 'A built index.json (or its directory) to check too.'),
        repeatable: true,
      },
      {
        ...dirOption('--allow-domain', '<host>', 'none', 'Host URLs may point at, subdomains included.'),
        repeatable: true,
      },
      {
        ...dirOption(
          '--train',
          '<component>=<version>',
          'none',
          'A component being released at that version: its `since` may be as new as the version, and no row but a pending one may still say `next`.',
        ),
        repeatable: true,
      },
      {
        flag: '--json',
        summary: 'Print `{ problems: [{ code, message, location }] }` on stdout instead of the text on stderr.',
      },
    ],
  },
  build: {
    summary:
      'Build facts/<entry>/index.ts into dist/<entry>/index.json and schemas/. In an aggregate package (`aggregate` in the config) copy the built indexes of its component packages into dist/ instead.',
    arguments: [],
    options: [
      dirOption('--cwd', '<dir>', 'the current directory', 'Package directory.'),
      dirOption('--facts-dir', '<dir>', 'facts', 'Fact sources.'),
      dirOption('--out-dir', '<dir>', 'dist', 'Output directory.'),
      { flag: '--write-exports', summary: 'Add the missing "exports" entries to package.json.' },
      {
        flag: '--accept-upstream',
        summary:
          'Build facts derived from another upstream version than `derived.lock.json` records, and rewrite the lock. Without it the build fails and names both versions.',
      },
    ],
  },
  diff: {
    summary:
      'List the fact ids added, removed and changed between two index.json files. With --impact, list instead what a change to one fact reaches.',
    arguments: ['<old>', '<new>'],
    options: [
      {
        flag: '--json',
        summary:
          'Print the result as JSON: { added, removed, changed }, or with --impact { id, facts: [{ id, depth, via }], docs: [{ file, line, id }] }.',
      },
      {
        flag: '--impact',
        value: '<id>',
        summary:
          'Take no files. Read the built indexes of the components in the aggregate config, follow derivedFrom downstream, and search docsDirs for references. Needs oxc-parser when docsDirs hold TypeScript.',
      },
      dirOption('--cwd', '<dir>', 'the current directory', 'With --impact: the aggregate package directory.'),
    ],
  },
  pin: {
    summary:
      'Turn every `next` in the `since` of the rows under the facts directory into one version: a `since` that is `next`, or an array that ends in `next`. A row with a `pending` label stays, so do `describes` and `<facts-dir>/_lib`. Only the text of the literal changes, so a second run changes nothing. Needs oxc-parser.',
    arguments: [],
    options: [
      {
        flag: '--version',
        value: '<v>',
        default: 'none',
        summary:
          'The version `next` becomes. Required, and given once. It must be semver 2.0.0, and a pre-release such as `0.49.0-alpha.1` is written whole.',
      },
      dirOption('--cwd', '<dir>', 'the current directory', 'Package directory.'),
      dirOption('--config', '<file>', 'fact-kit.config.json when present', 'Config file.'),
      dirOption('--facts-dir', '<dir>', 'facts', 'Fact sources, relative to --cwd.'),
    ],
  },
  'merge-since': {
    summary:
      'Run after `git merge`. In the files that `git diff --name-only --diff-filter=U` lists under --cwd, settle each conflict block whose two sides differ only in `since` (normal, `diff3` and `zdiff3` markers): the union of the versions, the smaller one when two are on one release line, ordered by release line with `next` last. Then rewrite a row that only the merged-in side has (the same fact has no row with that `since` in HEAD) whose `since` is one patch version `X.Y.Z` (`Z` above 0, no pre-release) and has no `pending` into `["X.Y.Z", "next"]`. It writes what it settled, stages nothing, and prints each conflict left as `<file>:<line> <reason>`. A second run changes nothing. Needs oxc-parser.',
    arguments: [],
    options: [
      dirOption(
        '--cwd',
        '<dir>',
        'the current directory',
        'A directory in the repository. Only files under it are read.',
      ),
    ],
  },
}

/** Where `build` puts a component's indexes in an aggregate package, by the shape of the component. */
const aggregateLayout = {
  config: { aggregate: { '.': '<component package>', '<sub-path>': '<component package>' } },
  componentPackage: {
    name: '@component/<directory name>',
    private: true,
    dependedOnBy: 'devDependencies of the aggregate, "workspace:*"',
  },
  placement: [
    { component: 'root, one entry', dir: '.', spec: '<aggregate>' },
    {
      component: 'root, several entries',
      dir: '<entry>',
      spec: '<aggregate>/<entry>',
      conflict: 'the entry has the name of another sub-path',
    },
    { component: 'sub-path, one entry', dir: '<sub-path>', spec: '<aggregate>/<sub-path>' },
    { component: 'sub-path, several entries', dir: '<sub-path>/<entry>', spec: '<aggregate>/<sub-path>/<entry>' },
  ],
  exports: ['./<dir>/index.json', './<dir>/schemas/*'],
  rewrittenInIndex: {
    package: 'the aggregate package name',
    entry: 'the path of <dir>, `.` for the root',
    component: 'the component package name',
  },
  rewrittenInFacts: 'derivedFrom and movedTo that name a component package become the published spec',
}

const readFactsSpec = {
  module: 'fact-kit',
  export: 'readFacts',
  signature: 'readFacts(spec, options?) => FactReader',
  parameters: [
    {
      name: 'spec',
      type: 'string',
      required: true,
      summary:
        '`<package>` or `<package>/<path>`, scoped names included, and the path may have several segments. The package must export `./index.json` or `./<path>/index.json`.',
    },
    {
      name: 'options.root',
      type: 'string',
      required: false,
      default: 'process.cwd()',
      summary: 'Directory the package is resolved from, normally the hub being built.',
    },
    {
      name: 'options.version',
      type: 'string',
      required: false,
      default: 'the installed version of the described component, else the latest published',
      summary:
        'Version of the described component the reader runs, or `head` for the unreleased state. Without it, an installed described component sets the version, and one that is not installed leaves the latest published facts.',
    },
    {
      name: 'options.include',
      type: 'string[]',
      required: false,
      default: '[]',
      summary: 'Labels of `pending` rows that a reader on `head` also gets.',
    },
    {
      name: 'options.platform',
      type: 'string',
      required: false,
      summary: 'Platform of the reader. A row with a `platforms` condition applies only when it lists this one.',
    },
    {
      name: 'options.os',
      type: '"macos" | "linux" | "windows"',
      required: false,
      summary: 'Operating system of the reader. A row with an `os` condition applies only when it lists this one.',
    },
    {
      name: 'options.onRead',
      type: '(read: { package, version, entry, id, since }) => void',
      required: false,
      summary:
        'Called synchronously once per `get`, `value` and `has` that finds the fact, and once per read of a field other than `id` on an element of `facts`. Filtering `facts` by `id` does not call it.',
    },
  ],
  returns: {
    members: [
      { name: 'package', type: 'string' },
      { name: 'version', type: 'string', summary: 'Version of the installed fact package, from its `package.json`.' },
      { name: 'entry', type: 'string' },
      { name: 'describes', type: 'Record<string, string>' },
      { name: 'facts', type: 'SelectedFact[]', summary: 'The facts this reader sees, each flattened to its row.' },
      { name: 'has', type: '(id: string) => boolean' },
      { name: 'get', type: '(id: string) => SelectedFact', summary: 'Throws when there is no such fact.' },
      {
        name: 'value',
        type: '<T>(id: string) => T',
        summary: 'The `content.value` of the fact. Throws when the fact has no value content.',
      },
    ],
  },
  throws: [
    'The spec is not of the form `<package>` or `<package>/<path>` (`not-found`).',
    'The package cannot be resolved from `root` (`not-found`).',
    'The resolved file is not a fact index (`not-an-index`) or has an index format other than 1.x (`unsupported-index-format`).',
    'A version is not semver (`invalid-version`).',
    'No `version` is given, and the described component is installed under `root` in a newer version than the facts describe.',
  ],
}

const moduleApi = {
  module: 'fact-kit',
  exports: keyed(
    [
      {
        name: 'defineFacts',
        signature: 'defineFacts(module: FactsModule) => FactsModule',
        summary: 'Identity helper that types the default export of `facts/<entry>/index.ts`.',
      },
      {
        name: 'history',
        signature: 'history(...rows: HistoryRow[]) => FactVariant[]',
        summary:
          "Expands the rows of a fact into `variants`: `variants: history(...)`. Row fields are in `fact-kit.history-row`. Targets are JSON Pointers (RFC 6901) into the content, and `''` is the root. A row that does not fit throws an error that names the key, and `check` reports it as `history`.",
      },
      {
        name: 'keyed',
        signature: 'keyed<T>(items: T[], keys?: string[]) => T[]',
        summary:
          'Declares the fields that identify an item of an array, so `history` can `add`, `remove` and `replace` items by key. Several fields make a key written as an array in that order. Without `keys` the items are scalars and identify themselves. An array that is not keyed can only be replaced whole.',
      },
      {
        name: 'factLink',
        signature: 'factLink(fact: Fact) => string',
        summary:
          'The location of another fact of this package, to write inside a sentence of `content`: `<id>` in the same entry, `<spec>:<id>` in another. The build adds the fact to `derivedFrom`. `relates: [fact]` adds it without text. A fact object that is not one of this package fails `check` with `relates-foreign`.',
      },
      {
        name: 'derive',
        signature: 'derive(upstreamSpec: string, id: string, map?: (upstream: Fact) => Partial<Fact>) => DerivedFact',
        summary:
          "A fact computed from a fact of another package, listed in `facts`. The build reads the installed index of `upstreamSpec`, copies the fact `id`, lets `map` change the copy, and sets `source` to `{ kind: 'derived', from: upstreamSpec, version }` with the upstream version installed, and `derivedFrom` to `<upstreamSpec>:<id>`. The build records each upstream spec and version in `derived.lock.json`, which goes into version control. Building with another upstream version installed fails with `derive-version` until `--accept-upstream` rewrites the lock.",
      },
      {
        name: 'defineExamples',
        signature: 'defineExamples(examples: ExampleGroup | ExampleGroup[]) => typeof examples',
        summary: 'Identity helper that types an example file. Each group follows `fact-kit.example-group`.',
      },
      {
        name: 'exampleFactRefs',
        signature: 'exampleFactRefs(group: ExampleGroup) => { id: string; location: string }[]',
        summary: 'Every fact id an example group references, with the JSON pointer where it is referenced.',
      },
      {
        name: 'flattenSchema',
        signature: 'flattenSchema(schema: JsonSchema) => SchemaRow[]',
        summary:
          'One row per field of a JSON Schema, for rendering field tables in docs and prompts. Fields of `anyOf` / `oneOf` branches are merged by name: values are the union, required when every branch requires it.',
      },
      {
        name: 'schemaRowsToMarkdown',
        signature: 'schemaRowsToMarkdown(rows: SchemaRow[]) => string',
        summary: 'A Markdown table of the rows, with Field, Type, Required, Description and Extensions columns.',
      },
      {
        name: 'valueListToMarkdown',
        signature: 'valueListToMarkdown(fact: Fact, options?: { columns?: string[] }) => string',
        summary:
          'Renders a fact whose `content.value` is an array: one `- item` line per string, or a table for objects (columns default to the keys). Throws an error naming the fact id when the value is not an array.',
      },
      {
        name: 'replaceFactBlocks',
        signature:
          'replaceFactBlocks(text: string, blocks: Record<string, string>) => { text: string; changed: boolean }',
        summary:
          'Replaces the text between `<!-- facts:begin NAME -->` and `<!-- facts:end NAME -->` with `blocks[NAME]`. `changed` is false when the document is already current, which is what a `--check` exits on. Throws an error naming the block on a missing end, a repeated name, or a name the document lacks.',
      },
      {
        name: 'readFacts',
        signature: 'readFacts(spec, options?) => FactReader',
        summary: 'Reads an installed fact package. Parameters and members are in `fact-kit.read-facts`.',
      },
      {
        name: 'selectFacts',
        signature: 'selectFacts(index, { version?, include?, platform?, os? }) => SelectedFact[]',
        summary:
          'The facts one reader sees in a parsed index of format 1.0 or 1.1. A pure function; `readFacts` is built on it.',
      },
    ],
    ['name'],
  ),
  schemaRow: [
    {
      name: 'path',
      type: 'string',
      summary: '`a.b` for a property, `a[]` for array items, `a.*` for additional properties.',
    },
    { name: 'type', type: 'string', summary: 'Empty when the schema says nothing.' },
    { name: 'required', type: 'boolean' },
    { name: 'description', type: 'string' },
    {
      name: 'values',
      type: 'unknown[]',
      summary: 'Present only when the field lists `enum` or `const` values, merged over `anyOf` / `oneOf` branches.',
    },
    { name: 'extensions', type: 'Record<string, unknown>', summary: 'The `x-` keywords of the field.' },
    {
      name: 'requiredWhen',
      type: '{ path: string; values: unknown[] }',
      summary:
        'Present when only some branches require the field and the branches are told apart by a `const` property: required when that property takes one of `values`.',
    },
  ],
}

const converters = {
  requires: {
    peerDependency: 'typescript',
    range: '>=7.1.0-beta',
    optional: true,
    install: 'pnpm add -D typescript@7.1.0-beta',
  },
  exports: [
    {
      name: 'readStringTuples',
      signature: 'readStringTuples(source: string) => Promise<Record<string, string[]>>',
      summary:
        'The string literal tuples exported by a TypeScript source, by name: `export declare const X: readonly [...]` and `export const X = [...] as const`. Parses only, so imports do not have to resolve.',
    },
    {
      name: 'readStringTuplesFromFile',
      signature: 'readStringTuplesFromFile(path: string) => Promise<Record<string, string[]>>',
      summary: 'Reads the file and returns `readStringTuples` of it.',
    },
    {
      name: 'interfaceToJsonSchema',
      signature:
        'interfaceToJsonSchema({ path, type, tsconfig?, additionalProperties?, descriptions? }) => Promise<JsonSchema>',
      summary:
        'An interface or type alias as a JSON Schema 2020-12 document. Referenced types become `$defs`. Union members and enum values keep the order of the source, `0 | number` keeps both members, and a tuple becomes `prefixItems`. JSDoc becomes `description`, and `descriptions: false` removes every `description`. Type errors in the input are not reported.',
    },
    {
      name: 'readJsonSchemaFile',
      signature: 'readJsonSchemaFile(path: string) => Promise<JsonSchema>',
      summary: 'Reads a JSON Schema file. Does not need TypeScript.',
    },
  ],
}

const historyRowSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Row of history(...)',
  description:
    'The first row gives the content with one of `value`, `schema` and `statement`. Each later row rewrites the content whole with one of those, or changes the content of the row before it with `remove`, `replace`, `add` and `set`, applied in that order. A row with none of them keeps the content and changes only the conditions.',
  type: 'object',
  required: ['since'],
  additionalProperties: false,
  properties: {
    since: defs.Since,
    value: { description: 'The content, or a full rewrite of it.' },
    schema: defs.JsonSchema,
    statement: defs.Text,
    remove: {
      description:
        'JSON Pointer to a keyed array -> the keys of the items to drop. One key field is written as its value, several as an array in the declared order.',
      type: 'object',
      additionalProperties: { type: 'array' },
    },
    replace: {
      description:
        'JSON Pointer -> the new value. For a keyed array and a list of items, the items are swapped in by key. Otherwise the value there is replaced, and it must exist.',
      type: 'object',
    },
    add: {
      description: 'JSON Pointer to a keyed array -> the items to append. An item whose key is already there fails.',
      type: 'object',
      additionalProperties: { type: 'array' },
    },
    set: { description: 'JSON Pointer -> the value to put there. The last member may be new.', type: 'object' },
    pending: nonEmpty,
    stability: { enum: ['experimental'] },
    platforms: list,
    os: { type: 'array', items: { enum: ['macos', 'linux', 'windows'] } },
  },
}

const exampleGroupSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:fact-kit:example-group',
  title: 'Example group',
  type: 'object',
  required: ['id', 'name', 'situation', 'claim', 'scenarios'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: nonEmpty,
    situation: { ...nonEmpty, description: 'The situation the group answers.' },
    claim: { ...nonEmpty, description: 'What the group shows, one sentence.' },
    facts: { ...list, description: 'Fact ids the whole group demonstrates, on top of those of its scenarios.' },
    scenarios: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title', 'situation', 'code', 'outcome', 'points', 'facts'],
        additionalProperties: false,
        properties: {
          title: nonEmpty,
          situation: { ...nonEmpty, description: 'What the reader is trying to do, one sentence.' },
          code: {
            type: 'array',
            description: 'Run by the tool’s own tests, not by fact-kit.',
            items: {
              type: 'object',
              required: ['caption', 'lang', 'source'],
              additionalProperties: false,
              properties: { caption: nonEmpty, lang: nonEmpty, source: { type: 'string' } },
            },
          },
          outcome: { ...list, description: 'What appears on disk or in the terminal after running the code.' },
          points: list,
          facts: {
            type: 'array',
            minItems: 1,
            items: nonEmpty,
            description: 'Ids of the facts the scenario demonstrates. Every id must exist.',
          },
        },
      },
    },
  },
}

const problemCodes = keyed([
  'format',
  'duplicate-id',
  'id-prefix',
  'local-path',
  'unregistered-domain',
  'unknown-fact-id',
  'missing-schema-file',
  'describes',
  'since-format',
  'ambiguous-rows',
  'top-level-content',
  'load',
  'history',
  'relates-foreign',
  'derive',
  'derive-version',
  'same-line',
  'relation-cycle',
  'lib-rows',
  'since-ahead',
  'train-next',
  'pending-untested',
  'doc-unknown-id',
  'impl-imports-facts',
  'impl-reads-facts-dist',
  'impl-depends-on-facts',
])

/** What each problem code stands for, and what the rule reads. `check` runs all of them, `build` the first group. */
const checkRules = keyed(
  [
    {
      code: 'format',
      rule: 'A fact, index, schema file or example does not fit its meta-schema.',
      reads: 'sources and built indexes',
    },
    { code: 'duplicate-id', rule: 'Two facts have one id.', reads: 'sources and built indexes' },
    {
      code: 'id-prefix',
      rule: 'A fact id does not start with its tool and a dot.',
      reads: 'sources and built indexes',
    },
    { code: 'local-path', rule: 'A fact holds a local absolute path.', reads: 'sources and built indexes' },
    {
      code: 'unregistered-domain',
      rule: 'A fact holds a URL whose host is not in `allowedDomains`.',
      reads: 'sources and built indexes',
    },
    {
      code: 'unknown-fact-id',
      rule: '`replacement`, `derivedFrom` or an example names a fact that does not exist.',
      reads: 'sources and built indexes',
    },
    {
      code: 'missing-schema-file',
      rule: 'A `$ref` points at a file under `schemas/` that is not there.',
      reads: 'sources and built indexes',
    },
    {
      code: 'describes',
      rule: '`describes` names more than one component, or the entries of one package disagree (different components, or `{}` mixed with one).',
      reads: 'sources',
    },
    {
      code: 'since-format',
      rule: 'A `since` is not a version, `next`, or an array of versions that may end in `next`.',
      reads: 'sources and built indexes',
    },
    {
      code: 'same-line',
      rule: 'A `since` array has two versions on one release line.',
      reads: 'sources and built indexes',
    },
    {
      code: 'ambiguous-rows',
      rule: 'Two rows apply to the same readers with the same bound, so a reader can not choose.',
      reads: 'sources and built indexes',
    },
    {
      code: 'relation-cycle',
      rule: 'Facts are derived from each other in a loop through `derivedFrom`.',
      reads: 'sources and built indexes',
    },
    {
      code: 'relates-foreign',
      rule: '`relates` or `factLink` holds a fact object that is not a fact of this package, such as one imported from another package.',
      reads: 'sources',
    },
    {
      code: 'history',
      rule: 'A `history` row does not fit: a key that matches no item, a key that is already there, an array that is not keyed, a bad pointer.',
      reads: 'sources',
    },
    {
      code: 'derive',
      rule: '`derive` finds no installed upstream package, no such fact in it, or `map` returns something that is not an object.',
      reads: 'the installed upstream package',
    },
    {
      code: 'derive-version',
      rule: '`derived.lock.json`, or a built index passed with `--index`, records another upstream version than the one installed.',
      reads: 'the installed upstream package, `derived.lock.json`',
    },
    {
      code: 'lib-rows',
      rule: 'A row with `since` in `facts/_lib`, which holds only functions and constants.',
      reads: 'source code, parsed with oxc',
    },
    {
      code: 'since-ahead',
      rule: 'A `since` is newer than `describes`, or than the `--train` version of its component when one is given.',
      reads: 'sources, `--train`',
    },
    {
      code: 'train-next',
      rule: 'A component named by `--train` still has a row that says `next` and is not pending.',
      reads: 'sources, `--train`',
    },
    {
      code: 'pending-untested',
      rule: 'A `pending` label is not passed as `include` by any test in `testDirs`.',
      reads: '`testDirs`, parsed with oxc',
    },
    {
      code: 'doc-unknown-id',
      rule: 'A `fact:<id>` or `fact:<spec>:<id>` in `docsDirs` names a fact that does not exist.',
      reads: '`docsDirs`',
    },
    {
      code: 'impl-imports-facts',
      rule: 'Code in `implDirs` imports a `-facts` package.',
      reads: '`implDirs`, parsed with oxc',
    },
    {
      code: 'impl-reads-facts-dist',
      rule: "A string in `implDirs` code, or a fixed part of a template, holds `facts/dist` as a path part (bounded by the start, the end, `/` or `\\`). It covers an import, `require`, `readFileSync` and `new URL`. It matches the literal text, so a path built as `join('facts', 'dist')` is not found, and implementations in other languages are out of scope.",
      reads: '`implDirs`, parsed with oxc',
    },
    {
      code: 'impl-depends-on-facts',
      rule: 'A package that is not a facts package lists a `-facts` package in `dependencies`.',
      reads: 'every package.json under `repoRoot`',
    },
    {
      code: 'top-level-content',
      rule: 'A warning. No row applies to a reader that names no platform, so the top-level content is a guess.',
      reads: 'sources and built indexes',
    },
    { code: 'load', rule: 'A source module, example or index file can not be run or parsed.', reads: 'sources' },
  ],
  ['code'],
)

const fact = (f: Omit<FactDecl, 'tool' | 'source'>): FactDecl => ({ ...f, tool: 'fact-kit', source: published })

/**
 * The first row of a fact that changed after 0.7.0: the content that was checked against 0.7.0. A fact has at most
 * one \`next\` row and a later change goes into it, because two rows with the same bound leave a reader on \`head\`
 * nothing to choose between (\`ambiguous-rows\`).
 */
const since070 = '0.7.0'

const newApi = [
  {
    name: 'factsOf',
    signature: 'factsOf({ tool, source, prefix?, topics? }) => FactsFactory',
    summary:
      'Writes facts with the repeated fields filled in: `const mf = factsOf({ tool, source })`, then `mf.value(name, value)`, `mf.schema(name, schema)` and `mf.statement(name, text)` return a fact whose id is `<tool>.<prefix>.<name>` (`<tool>.<name>` without a prefix) and whose title is `name`. Each takes a value, a function that returns it, or the rows of `history(...)` as the second argument, and `{ title?, topics?, description?, when?, relates?, verify?, source?, note? }` as the third. The topics are those of `factsOf` and then those of the call. A fact written with one content exposes the fields of an object value as read-only getters that give a tagged copy, so the build adds the fact read to `derivedFrom`. A scalar, or a value built from scalars, carries no tag, so write it as a function (`mf.value(name, () => ...)`): every read of another fact while the function runs goes into `relates`. A fact written with `history(...)` has no getters, so read it with `contentOf`. Throws `BuilderError` for a name that is empty or starts or ends with a dot, and for rows whose first row is not the kind of the method.',
  },
  {
    name: 'observedDoc',
    signature: 'observedDoc({ url: string, fetched: string }) => FactSource',
    summary:
      "The source `{ kind: 'observed', basis: 'doc', url, fetched }` of a fact read from a page of the documentation.",
  },
  {
    name: 'observedSpike',
    signature: 'observedSpike({ fetched: string, url?: string }) => FactSource',
    summary:
      "The source `{ kind: 'observed', basis: 'spike', fetched }` of a fact seen in a trial run, with `url` when a page led to it.",
  },
  {
    name: 'contentOf',
    signature: 'contentOf(fact: Fact, since?: string) => unknown',
    summary:
      'A copy of the value or the schema of one row of a fact, tagged so the build adds the fact to `derivedFrom` where the copy is embedded. A fact with several rows needs `since`, the `since` of the row to read (any one version of a row written as an array). Throws `BuilderError` when there is no such row or no content.',
  },
  {
    name: 'statementFrom',
    signature: 'statementFrom(fact: Fact, render: (value) => Text, options?: { since?: string }) => BuiltStatement',
    summary:
      'A statement written from the content of another fact: `render` gets the copy that `contentOf` makes and returns the text. Give the result to `mf.statement` or to the `statement` of a `history` row. The fact goes into `relates`, so `derivedFrom` follows it.',
  },
  {
    name: 'subsetOf',
    signature: 'subsetOf(parent: Fact, items: T[]) => T[]',
    summary:
      "A list that must stay inside the list of `parent`, a fact object. When the parent is a typed list (`mf.value('x', ['A', 'B'])`) the type checker rejects an item it does not have. A parent that comes from a conversion has no type, so `check` and `build` test the list again at every version boundary of the two facts and report `subset-of` with the version. The parent goes into `derivedFrom`. Throws `BuilderError` when `parent` is not a fact object.",
  },
]

const facts: FactDecl[] = [
  fact({
    id: 'fact-kit.fact',
    topics: ['fact', 'schema'],
    title: { en: 'Fields of a fact' },
    description: { en: 'The shape of one fact in an `index.json`.' },
    content: { schema: factSchema },
  }),
  fact({
    id: 'fact-kit.check-rules',
    topics: ['check'],
    title: { en: 'What each problem code of check stands for' },
    description: {
      en: 'One entry per code of `fact-kit.problem-codes`, with the rule and the input it reads. `check` exits with 0 when it finds no problem, 1 when it finds one, and 2 when it can not run because of bad settings or input.',
    },
    variants: history(
      { since: since070, value: checkRules },
      {
        since: 'next',
        add: {
          '': [
            {
              code: 'builder',
              rule: 'A builder, `mf.*`, `contentOf` or `subsetOf` got input that does not fit, such as a name with a leading dot, rows whose first row is not the kind of the method, or a subset whose parent is not a fact object. `history` also raises it when a row makes what a builder checked invalid. The message names the row and the key. Only `check` prints the code. `build` stops with the message.',
              reads: 'sources',
            },
            {
              code: 'subset-of',
              rule: 'A list declared with `subsetOf` has, at some version boundary, a value that the list of its parent lacks, or the parent has no row that applies there. The boundaries are those of `ambiguous-rows`, taken over the rows of both facts. The message names the oldest version where it happens and the value. `build` runs this rule too.',
              reads: 'sources',
            },
          ],
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.history-row',
    topics: ['authoring'],
    title: { en: 'Fields of a row of history(...)' },
    variants: history(
      { since: since070, schema: historyRowSchema },
      {
        since: 'next',
        set: {
          '/description':
            'The first row gives the content with one of `value`, `schema` and `statement`. Each later row rewrites the content whole with one of those, or changes the content of the row before it with `remove`, `replace`, `add` and `set`, applied in that order. A row with none of them keeps the content and changes only the conditions. After each row, the check of the builder that made the content runs again, and a row that breaks it fails with `BuilderError`.',
          '/properties/statement': {
            description:
              'The text, or what `statementFrom` returns. The facts a built statement relates to go into `relates` of the fact.',
            oneOf: defs.Text.oneOf,
          },
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.index',
    topics: ['fact', 'build'],
    title: { en: 'Fields of a built index.json' },
    content: { schema: indexSchema },
  }),
  fact({
    id: 'fact-kit.entry-module',
    topics: ['fact', 'authoring'],
    title: { en: 'Default export of facts/<entry>/index.ts' },
    description: {
      en: 'Run with Node type stripping, so only erasable syntax is allowed and relative imports end in `.ts`.',
    },
    content: { schema: entryModuleSchema },
  }),
  fact({
    id: 'fact-kit.config-file',
    topics: ['check', 'config'],
    title: { en: 'Settings in fact-kit.config.json' },
    description: { en: 'Command-line options override the file.' },
    content: { schema: configSchema },
  }),
  fact({
    id: 'fact-kit.x-keywords',
    topics: ['schema'],
    title: { en: 'Registered x- keywords' },
    description: {
      en: 'The only `x-` keywords a schema in a fact may use, each with the shape of its value. Any other `x-` keyword fails `check`.',
    },
    content: { value: xKeywords },
  }),
  fact({
    id: 'fact-kit.cli',
    topics: ['cli', 'check', 'build', 'diff', 'pin', 'merge-since'],
    title: { en: 'fact-kit commands and options' },
    content: { value: commands },
  }),
  fact({
    id: 'fact-kit.problem-codes',
    topics: ['check'],
    title: { en: 'Problem codes of check and build' },
    description: { en: 'The stable `code` of each problem. The message is for people and can change.' },
    variants: history(
      { since: since070, value: problemCodes },
      { since: 'next', add: { '': ['builder', 'subset-of'] } },
    ),
  }),
  fact({
    id: 'fact-kit.aggregate-layout',
    topics: ['build', 'config'],
    title: { en: 'Layout of an aggregate package' },
    description: {
      en: 'How `build` places the indexes of component packages in the published package, and what it rewrites in them.',
    },
    content: { value: aggregateLayout },
  }),
  fact({
    id: 'fact-kit.read-facts',
    topics: ['read'],
    title: { en: 'readFacts parameters and return value' },
    content: { value: readFactsSpec },
  }),
  fact({
    id: 'fact-kit.module-api',
    topics: ['authoring', 'read', 'docs'],
    title: { en: 'Functions fact-kit exports for authoring and rendering' },
    description: { en: 'The exports a facts package, its docs and its examples call, and the fields of `SchemaRow`.' },
    variants: history(
      { since: since070, value: moduleApi },
      {
        since: 'next',
        replace: {
          '/exports': [
            {
              name: 'history',
              signature: 'history(...rows: HistoryRow[]) => HistoryVariants',
              summary:
                "Expands the rows of a fact into `variants`: `variants: history(...)`. Row fields are in `fact-kit.history-row`. Targets are JSON Pointers (RFC 6901) into the content, and `''` is the root. A row that does not fit throws an error that names the key, and `check` reports it as `history`. The result is still an array of variants, and `mf.value(name, history(...))` takes it. After each row, the check of the builder that made the content runs again, and a row that breaks it throws `BuilderError`, which `check` reports as `builder`.",
            },
          ],
        },
        add: { '/exports': newApi },
      },
    ),
  }),
  fact({
    id: 'fact-kit.converters',
    topics: ['convert', 'authoring'],
    title: { en: 'Converters and the optional TypeScript peer dependency' },
    description: {
      en: 'The converters read TypeScript with the TypeScript 7.1 API, which starts a native compiler process. `typescript` is an optional peer dependency that is loaded when a converter runs, and a converter throws an error that names the package to install when it is missing.',
    },
    content: { value: converters },
  }),
  fact({
    id: 'fact-kit.example-group',
    topics: ['examples', 'schema'],
    title: { en: 'Fields of an example group' },
    description: { en: 'One group in an example package, checked by `check`.' },
    content: { schema: exampleGroupSchema },
  }),
]

const entry: FactsSource = { describes: { 'fact-kit': kit.version }, facts }

export default entry
