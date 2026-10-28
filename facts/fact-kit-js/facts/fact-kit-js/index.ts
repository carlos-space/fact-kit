// Facts about fact-kit itself. They are the spec, and fact-kit's code does not import them. The tests in
// test/fact-kit-spec.test.ts compare each one with the implementation, so a change on either side fails there.
import { history, keyed } from '../../../../packages/fact-kit-js/src/index.ts'
import type { FactDecl, FactsSource } from '../../../../packages/fact-kit-js/src/index.ts'
import kit from '../../../../packages/fact-kit-js/package.json' with { type: 'json' }

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

const publishSchema = {
  description:
    'Where the described component is published and under what name there (its PublishName), e.g. `{ "target": "npm", "name": "fact-kit" }`. `describes` is keyed by the component name, which can differ from the name on the registry. `readFacts` on the JS side uses it to find the installed package when `describes` is not keyed by an npm package name, and only when `target` is `npm`. The readers of the other languages return it and do not check any version. `check` rejects entries of one package that disagree. Left out, `readFacts` takes the `describes` key as the npm package name.',
  type: 'object',
  required: ['target', 'name'],
  additionalProperties: false,
  properties: {
    target: { enum: ['npm', 'pypi', 'crates', 'go', 'swift'] },
    name: nonEmpty,
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

/**
 * `x-identity` names the field that identifies an entity, or two or more that do together. `check` reports
 * `schema-property` when a name is not in the `properties` of the same schema.
 */
const xIdentity = {
  oneOf: [
    { type: 'string', minLength: 1 },
    { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2, uniqueItems: true },
  ],
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
    options: keyed(
      [
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
      ['flag'],
    ),
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
    name: '@<publish target>/<publish name>-facts',
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
      {
        name: 'publish',
        type: '{ target: "npm" | "pypi" | "crates" | "go" | "swift"; name: string } | undefined',
        summary: 'The `publish` field of the index, as it is. Undefined for an index that has none.',
      },
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
    'No `version` is given, and the described component is installed under `root` in a newer version than the facts describe (`describes-behind`). The component is looked up as `publish.name` when the index has `publish` with target `npm`, is not looked up when `publish` has another target, and is looked up by the `describes` key when there is no `publish`.',
  ],
}

// What readFacts documented before `publish`: no `publish` member, and the version check by the `describes` key only.
const readFactsBefore = {
  ...readFactsSpec,
  returns: { members: readFactsSpec.returns.members.filter((m) => m.name !== 'publish') },
  throws: [
    ...readFactsSpec.throws.slice(0, -1),
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
  'publish',
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
      code: 'publish',
      rule: 'The entries of one package disagree on `publish` (different targets or names, or one entry without it).',
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
  {
    name: 'stateMachine',
    signature: 'stateMachine({ initial, states, transitions }) => StateMachine',
    summary:
      "A state machine as a value: `{ initial, states, transitions }`, each transition `{ from, to, event?, guard? }`. `event` is a string, or a list of strings for several events between the same two states, and `guard` is a string that holds for all of them. `states` is keyed by name and `transitions` by `from` and `to`, so a `history` row can `add`, `remove` and `replace` them by key, for example `remove: { '/states': ['blocked'] }` and `remove: { '/transitions': [['active', 'done']] }`. Give it to `mf.value`. Throws `BuilderError` when `initial`, or the `from` or `to` of a transition, is not in `states`, and `history` checks it again after every row, so a row that drops a state a transition still uses fails. `check` reports it as `builder`.",
  },
  {
    name: 'relations',
    signature: 'relations({ nodes, edges }) => Relations',
    summary:
      "Nodes and named relations as a value: `{ nodes, edges }`, each edge `{ from, to, name, cardinality? }` with `cardinality` `'one'` or `'many'`. `nodes` is keyed by name and `edges` by `from`, `to` and `name`, for example `remove: { '/edges': [['a', 'b', 'has']] }`. Give it to `mf.value`. Throws `BuilderError` when the `from` or `to` of an edge is not in `nodes`, and `history` checks it again after every row.",
  },
  {
    name: 'sequence',
    signature: 'sequence({ participants, steps }) => Sequence',
    summary:
      "Messages between participants as a value: `{ participants, steps }`, each step `{ from, to, action }`. `participants` is keyed by name and `steps` by `action`, which no two steps share. A `history` row can `add` steps only at the end. To insert in the middle or to rename an `action`, replace the whole list: `replace: { '/steps': keyed([...], ['action']) }`. Throws `BuilderError` when the `from` or `to` of a step is not in `participants`, and `history` checks it again after every row.",
  },
  {
    name: 'stateMachineToMermaid',
    signature: 'stateMachineToMermaid(source: StateMachine | Fact) => string',
    summary:
      'A `stateDiagram-v2` of a state machine, without a code fence. `source` is the value or a fact whose content is that value. Each state is declared as `state "<name>" as s<i>` in the order of `states`, the initial state is `[*] --> s<i>`, and a transition is `s<i> --> s<j>` followed by `: <events joined by ", "> [<guard>]` when it has either. The ids are generated, so a name with spaces or punctuation is safe, and `#`, `"`, `;` and `|` in a name become mermaid entities.',
  },
  {
    name: 'relationsToMermaid',
    signature: 'relationsToMermaid(source: Relations | Fact) => string',
    summary:
      'A `flowchart LR` of nodes and relations, without a code fence. Each node is declared as `n<i>["<name>"]` and each edge is `n<i> -->|<name>| n<j>`. `cardinality` is not drawn. The ids are generated.',
  },
  {
    name: 'sequenceToMermaid',
    signature: 'sequenceToMermaid(source: Sequence | UseCase | Fact) => string',
    summary:
      'A `sequenceDiagram` of a sequence, without a code fence. Each participant is declared as `participant p<i> as <name>` and each step is `p<i>->>p<j>: <action>`. The ids are generated. A use case from `useCase` is drawn too: the participants are `caller` and then each `layer` in the order of first use, and each step is a message from the layer of the step before it (`caller` for the first) to its own layer.',
  },
  {
    name: 'ref',
    signature: 'ref(fact: Fact, field?: string) => FactRef',
    summary:
      "A reference to a fact of this package, or to a field of it written with dots such as `'limits.max'`, for the content of another fact. It returns a placeholder that the build replaces. When it is the whole value of a subschema, the build writes `{ $ref: '#/$defs/<id>' }`, or `{ $ref: '#/$defs/<id>/properties/a/properties/b' }` with a field, and puts the schema of the target into `$defs` of the root schema, flat and once per id. Anywhere else (a value, a statement, a longer string, a `const`) it writes the location of the fact, followed by `#a.b` with a field. A `$ref` inside the embedded schema that points to its own root (`#`, `#/properties/x`) is rewritten to `#/$defs/<id>` and `#/$defs/<id>/properties/x`; one into its own `$defs` or to an anchor stays. When the target has several rows, the build aligns them: the fact that writes the `ref` gets one row for each combination of its own row and the rows of the target that some reader gets together (the boundaries of `subset-of`), each with the `$defs` of that combination, so a reader reads a standard JSON Schema and changes nothing. A fact with one row becomes a fact with `variants`. The target goes into `derivedFrom`. A field the type checker knows is not in the target fails to compile. `check` reports `ref` when the field is missing from a row the two facts share, and `relates-foreign` when the target is no fact of any entry of the package. It also fits `guard` of a transition.",
  },
  {
    name: 'entity',
    signature: 'entity({ identity, fields, required? }) => EntitySchema',
    summary:
      "An entity as a JSON Schema for `mf.schema`: `{ type: 'object', 'x-identity', properties, required? }`, with the topic `ddd:entity`. `identity` is a field name, or a list of at least two different names (a list of one is written as the name), and `fields` maps a name to a schema or to `ref(fact)`. `required` is a keyed list of names. A `history` row drops a field with `remove: { '/properties': ['status'] }`, adds one with `add: { '/properties': { note: {...} } }` and swaps one with `replace: { '/properties/status': {...} }`, and must drop the name from `required` in the same row. Throws `BuilderError` when an identity name or a `required` name is not a field, and `history` checks it again after every row, so a row that leaves one behind fails and `check` reports `builder`.",
  },
  {
    name: 'valueObject',
    signature: 'valueObject(fields, options?: { required? }) => ObjectSchema',
    summary:
      "A value object as a JSON Schema for `mf.schema`: `{ type: 'object', properties, required? }`, with the topic `ddd:value-object`. A `history` row changes the fields by name in the same way as `entity`, and `required` follows them. Throws `BuilderError` when a `required` name is not a field.",
  },
  {
    name: 'domainEvent',
    signature: 'domainEvent(fields, options?: { required? }) => ObjectSchema',
    summary:
      'A domain event as a JSON Schema for `mf.schema`, in the shape and with the rules of `valueObject`, with the topic `ddd:domain-event`.',
  },
  {
    name: 'aggregate',
    signature: 'aggregate({ root, members }) => Aggregate',
    summary:
      "An aggregate as a value for `mf.value`: `{ root, members }`, each member `{ entity, cardinality }` where `cardinality` is `'one'` (the default) or `'many'`. The facts are written as `factLink` placeholders that the build replaces with their location and adds to `derivedFrom`. The topic is `ddd:aggregate`. `members` is keyed by `entity`, so a `history` row names a member by `factLink(entity)`: `remove: { '/members': [factLink(line)] }`. Throws `BuilderError` when `root` is not a fact object or a cardinality is not `'one'` or `'many'`, and `HistoryError` for two members of one entity.",
  },
  {
    name: 'invariant',
    signature: 'invariant(subject: Fact, text: Text) => BuiltStatement',
    summary:
      "A business rule about an entity or value, for `mf.statement` or the `statement` of a `history` row. It carries the text, and `subject` goes into `relates` so `derivedFrom` follows it. The topic is `ddd:invariant`. A later `history` row rewrites the sentence whole with `statement: invariant(...)`, which also carries the new subject. `set: { '': text }` replaces the sentence but not `relates`. Throws `BuilderError` when `subject` is not a fact object or `text` is empty.",
  },
  {
    name: 'useCase',
    signature: 'useCase({ input?, output?, steps, errors? }) => UseCase',
    summary:
      "An application use case as a value for `mf.value`: `{ input?, output?, steps, errors }`. `input` and `output` are `ref(fact)` or a schema. A step is `{ layer, action, rule?, emits?, calls? }` where `layer` is `'application'`, `'domain'` or `'infrastructure'` and the facts in `rule`, `emits` and `calls` become `factLink` placeholders. The topic is `ddd:use-case`. `steps` is keyed by `action`, which no two steps share, and a `history` row can `add` steps only at the end, so to insert in the middle replace the whole list. `errors` is a keyed list of codes. `sequenceToMermaid` draws it. Throws `BuilderError` for a layer that is not one of the three or an empty action, and `HistoryError` for a repeated action or code.",
  },
]

/** The helpers a converter script shares: formatting, stable JSON, schema normalization and pinned upstream files. */
const converterLibApi = [
  {
    name: 'writeFormatted',
    signature: 'writeFormatted(file: string, text: string) => Promise<void>',
    summary:
      'Writes `text` to `file` formatted with the prettier settings that `resolveConfig(file)` finds (none when there is no config), so a rerun gives the same bytes. Creates the parent directories. `prettier` is an optional peer dependency that is loaded when the function runs, and a missing package throws an error that names what to install: `pnpm add -D prettier@3`.',
  },
  {
    name: 'stableJson',
    signature: 'stableJson(value: unknown) => string',
    summary:
      'JSON with two-space indent and the keys of every object in code-unit order, for generated files. Arrays keep their order. There is no trailing newline.',
  },
  {
    name: 'DRAFT_2020_12',
    signature: "const DRAFT_2020_12: 'https://json-schema.org/draft/2020-12/schema'",
    summary:
      'The `$schema` URL of JSON Schema 2020-12. It is the value `interfaceToJsonSchema` and `normalizeSchema` put in `$schema`.',
  },
  {
    name: 'NormalizeOptions',
    signature: 'interface NormalizeOptions { describe?, drop?, notes? }',
    summary:
      'The options of `normalizeSchema`. `describe(text) => string` is called for each `description` and returns the text to keep. `drop` lists keywords to remove at any depth. `notes` is a `Map<string, number>` that counts what was dropped or rewritten, for the converter report. A type, exported with `export type`.',
  },
  {
    name: 'normalizeSchema',
    signature: 'normalizeSchema(input: JsonSchema, options?: NormalizeOptions) => JsonSchema',
    summary:
      'Rewrites a JSON Schema from another dialect (draft-07, OpenAPI 3.0) to 2020-12, only where a schema is expected, so a property named `items` or `deprecated` is left alone. `definitions` becomes `$defs` and `#/definitions/` references follow. A tuple `items: [...]` becomes `prefixItems` and `additionalItems` becomes `items`. A string `deprecated` becomes `true` and its message is appended to `description` as `Deprecated: <message>`. `nullable: true` adds `null` to `type`. `dependencies` splits into `dependentRequired` and `dependentSchemas`. `x-` keywords that fact-kit does not register (`X_KEYWORDS`), `$id`, `id` and the keywords in `drop` are removed. The result starts with `$schema` set to `DRAFT_2020_12`.',
  },
  {
    name: 'PinnedSource',
    signature: 'interface PinnedSource { repo, commit, path, sha256, license }',
    summary:
      'An upstream file pinned to a commit: `repo` is `owner/name`, `commit` is the full SHA, `path` is the file in the repository, `sha256` is the hex digest of its bytes and `license` is an SPDX id. A type, exported with `export type`.',
  },
  {
    name: 'sourceUrl',
    signature: 'sourceUrl(source: PinnedSource) => string',
    summary:
      'The GitHub page of the pinned file at its commit (`blob/<commit>/<path>` of the repository), where a reader opens it.',
  },
  {
    name: 'readPinned',
    signature: 'readPinned(source: PinnedSource, options: { cacheDir: string }) => Promise<string>',
    summary:
      'The text of the pinned file. Reads `<cacheDir>/<sha256>.txt` when it exists, otherwise downloads the file at that commit from the raw-content address of GitHub, checks the sha256 and writes the cache. `cacheDir` is required, so the cache place does not depend on the working directory. Throws `<repo>/<path>: sha256 is <actual>, expected <sha256>` when the bytes do not match, also for a cached file, and `<url>: HTTP <status>` when the download fails.',
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
        since: '0.8.0',
        replace: {
          '': [
            {
              code: 'history',
              rule: 'A `history` row does not fit: a key that matches no item, a key that is already there, an array that is not keyed, a bad pointer, or a pointer that goes into an array by index. Name an item by its key, or replace the whole array.',
              reads: 'sources',
            },
          ],
        },
        add: {
          '': [
            {
              code: 'builder',
              rule: 'A builder, `mf.*`, `contentOf` or `subsetOf` got input that does not fit, such as a name with a leading dot, rows whose first row is not the kind of the method, a subset whose parent is not a fact object, or a state machine, relations or sequence with an end that is not declared, or an entity, value object, aggregate or use case whose names do not match (an identity or `required` name that is not a field, a layer that is not one of three). `history` also raises it when a row makes what a builder checked invalid. The message names the row and the key. Only `check` prints the code. `build` stops with the message.',
              reads: 'sources',
            },
            {
              code: 'subset-of',
              rule: 'A list declared with `subsetOf` has, at some version boundary, a value that the list of its parent lacks, or the parent has no row that applies there. The boundaries are those of `ambiguous-rows`, taken over the rows of both facts. The message names the oldest version where it happens and the value. `build` runs this rule too.',
              reads: 'sources',
            },
            {
              code: 'ref',
              rule: 'A `ref(fact, field?)` does not resolve. At some version boundary of the two facts, the reader gets a row of the fact that writes the `ref` but no row of the target applies, the target lacks the field (a field name with a dot can not be referenced), the target is a statement and the `ref` has a field, or the target is not a schema where the `ref` is a `$ref`. Also: a field path with an empty part, `$defs` that already has the key with another schema, schemas that embed each other in a loop, a schema of another entry with a file `$ref` embedded here, a `$dynamicRef` or `$recursiveRef`, or a `$ref` to the root inside a subschema with an `$id`, in an embedded schema, which can not be moved into the schema that embeds it, and a target with several rows whose rows can not be aligned with the rows of the fact that writes the `ref`, so some reader gets a schema in `$defs` that is not the one it gets from the target. The message names the oldest version where it happens. `build` runs this rule too.',
              reads: 'sources',
            },
            {
              code: 'schema-property',
              rule: 'An `x-identity` names a field that is not in the `properties` of the same schema. It reads every schema of a fact, in every row, and every file under `schemas/`. A `required` list that builders make is checked by `builder`, not by this rule.',
              reads: 'sources and built indexes',
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
        since: '0.8.0',
        set: {
          '/description':
            'The first row gives the content with one of `value`, `schema` and `statement`. Each later row rewrites the content whole with one of those, or changes the content of the row before it with `remove`, `replace`, `add` and `set`, applied in that order. A row with none of them keeps the content and changes only the conditions. After each row, the check of the builder that made the content runs again, and a row that breaks it fails with `BuilderError`.',
          '/properties/remove': {
            description:
              'JSON Pointer -> what to drop. For a keyed array, the keys of the items to drop. For an object, the names of the properties to drop, such as `{ "/properties": ["status"] }` for an entity. A key or name that is not there fails.',
            type: 'object',
            additionalProperties: { type: 'array' },
          },
          '/properties/add': {
            description:
              'JSON Pointer -> what to add. For a keyed array, the items to append, and an item whose key is already there fails. For an object, an object of properties to add by name, such as `{ "/properties": { "note": { "type": "string" } } }` for an entity, and a name that is already there fails.',
            type: 'object',
            additionalProperties: { type: ['array', 'object'] },
          },
          '/properties/replace/description':
            'JSON Pointer -> the new value. For a keyed array and a list of items, the items are swapped in by key. Otherwise the value there is replaced, and it must exist. A pointer may not go into an array by index, so replace the whole array instead.',
          '/properties/set/description':
            'JSON Pointer -> the value to put there. The last member may be new. A pointer may not go into an array by index, so set the whole array instead.',
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
    variants: history(
      { since: '0.0.0', schema: indexSchema },
      {
        since: '0.9.0-alpha.1',
        set: {
          '/properties/indexFormat/description':
            '`1.2` for what this version builds. A missing field reads as `1.0`. Readers take any `1.x`.',
          '/properties/publish': publishSchema,
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.entry-module',
    topics: ['fact', 'authoring'],
    title: { en: 'Default export of facts/<entry>/index.ts' },
    description: {
      en: 'Run with Node type stripping, so only erasable syntax is allowed and relative imports end in `.ts`.',
    },
    variants: history(
      { since: '0.0.0', schema: entryModuleSchema },
      { since: '0.9.0-alpha.1', set: { '/properties/publish': publishSchema } },
    ),
  }),
  fact({
    id: 'fact-kit.config-file',
    topics: ['check', 'config'],
    title: { en: 'Settings in fact-kit.config.json' },
    description: { en: 'Command-line options override the file.' },
    variants: history(
      { since: since070, schema: configSchema },
      {
        since: '0.8.0',
        set: {
          '/properties/examplesDir/description':
            'Directory of example files, relative to the package. `check` reads them, and `build` writes them to `dist/examples.json` when the package has facts.',
          '/properties/indexFiles/description':
            'Built `index.json` files (or directories holding one) that `check` reads as well. `build` reads them too, to find the facts the examples name.',
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.x-keywords',
    topics: ['schema'],
    title: { en: 'Registered x- keywords' },
    description: {
      en: 'The only `x-` keywords a schema in a fact may use, each with the shape of its value. Any other `x-` keyword fails `check`.',
    },
    variants: history({ since: since070, value: xKeywords }, { since: '0.8.0', set: { '/x-identity': xIdentity } }),
  }),
  fact({
    id: 'fact-kit.cli',
    topics: ['cli', 'check', 'build', 'diff', 'pin', 'merge-since'],
    title: { en: 'fact-kit commands and options' },
    variants: history(
      { since: since070, value: commands },
      {
        since: '0.8.0',
        set: {
          '/build/summary':
            'Build facts/<entry>/index.ts into dist/<entry>/index.json and schemas/, and the example groups of the examples directory into dist/examples.json (nothing is written when there are none). The snippets in the groups are not run. In an aggregate package (`aggregate` in the config) copy the built indexes and examples.json of its component packages into dist/ instead.',
        },
        replace: {
          '/diff/options': [
            {
              flag: '--json',
              summary:
                'Print the result as JSON: { added, removed, changed }, or with --impact { id, facts: [{ id, depth, via }], docs: [{ file, line, id }], examples: [{ spec, group, scenario, id, in }] }.',
            },
          ],
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.problem-codes',
    topics: ['check'],
    title: { en: 'Problem codes of check and build' },
    description: { en: 'The stable `code` of each problem. The message is for people and can change.' },
    variants: history(
      { since: since070, value: problemCodes },
      { since: '0.8.0', add: { '': ['builder', 'subset-of', 'ref', 'schema-property'] } },
    ),
  }),
  fact({
    id: 'fact-kit.aggregate-layout',
    topics: ['build', 'config'],
    title: { en: 'Layout of an aggregate package' },
    description: {
      en: 'How `build` places the indexes of component packages in the published package, and what it rewrites in them.',
    },
    variants: history(
      { since: since070, value: aggregateLayout },
      {
        since: '0.8.0',
        set: {
          '/exports': [
            './<dir>/index.json',
            './<dir>/schemas/*',
            './<sub-path>/examples.json (`./examples.json` for the root), for each component that built examples',
          ],
          '/examples': {
            file: 'examples.json',
            dir: '<sub-path> (empty for the root), whatever number of entries the component has',
            spec: '<aggregate>/<sub-path>, which is what `diff --impact` prints as `spec` of an example',
            rewritten: { package: 'the aggregate package name' },
            copied: 'the groups as built by the component, unchanged',
          },
        },
      },
      {
        since: '0.9.0-alpha.1',
        set: {
          '/componentPackage/name':
            '<publish name without @<org>/>-facts, e.g. `promptex-macos-facts`. When that is also the base of another component package or of the aggregate in the repository, every one of them adds `.<publish target>`, e.g. `fact-kit-facts.npm` and `fact-kit-facts.go`. A unit with restricted access adds `@<scope>/`',
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.read-facts',
    topics: ['read'],
    title: { en: 'readFacts parameters and return value' },
    variants: history({ since: '0.0.0', value: readFactsBefore }, { since: '0.9.0-alpha.1', value: readFactsSpec }),
  }),
  fact({
    id: 'fact-kit.module-api',
    topics: ['authoring', 'read', 'docs'],
    title: { en: 'Functions fact-kit exports for authoring and rendering' },
    description: { en: 'The exports a facts package, its docs and its examples call, and the fields of `SchemaRow`.' },
    variants: history(
      { since: since070, value: moduleApi },
      {
        since: '0.8.0',
        replace: {
          '/exports': [
            {
              name: 'history',
              signature: 'history(...rows: HistoryRow[]) => HistoryVariants',
              summary:
                "Expands the rows of a fact into `variants`: `variants: history(...)`. Row fields are in `fact-kit.history-row`. Targets are JSON Pointers (RFC 6901) into the content, and `''` is the root. A row that does not fit throws an error that names the key, and `check` reports it as `history`. The result is still an array of variants, and `mf.value(name, history(...))` takes it. After each row, the check of the builder that made the content runs again, and a row that breaks it throws `BuilderError`, which `check` reports as `builder`. `remove` and `add` also work on an object by property name, such as the `properties` of an `entity`.",
            },
            {
              name: 'defineExamples',
              signature: 'defineExamples(examples: ExampleGroupSource | ExampleGroupSource[]) => typeof examples',
              summary:
                'Identity helper that types an example file. Each group follows `fact-kit.example-group`. In `outcome` an item may also be `ref(fact)`, `ref(fact, field)` or `statementFrom(fact, render)`, which the build turns into `{ fact, field?, text? }`.',
            },
            {
              name: 'exampleFactRefs',
              signature:
                "exampleFactRefs(group: ExampleGroup) => { id: string; location: string; in: 'facts' | 'outcome'; field?: string }[]",
              summary:
                'Every fact id an example group references, with the JSON pointer where it is referenced. `in` is `facts` for `facts` of the group or of a scenario and `outcome` for a `{ fact }` item of an outcome, and `field` is the field that item names.',
            },
          ],
        },
        add: { '/exports': newApi },
      },
      { since: 'next', add: { '/exports': converterLibApi } },
    ),
  }),
  fact({
    id: 'fact-kit.converters',
    topics: ['convert', 'authoring'],
    title: { en: 'Converters and the optional TypeScript peer dependency' },
    description: {
      en: 'The converters read TypeScript with the TypeScript 7.1 API, which starts a native compiler process. `typescript` is an optional peer dependency that is loaded when a converter runs, and a converter throws an error that names the package to install when it is missing. `writeFormatted` loads the optional peer dependency `prettier` the same way.',
    },
    variants: history(
      { since: '0.0.0', value: converters },
      {
        since: 'next',
        set: {
          '/optionalPeers': [
            {
              peerDependency: 'prettier',
              range: '>=3.0.0',
              install: 'pnpm add -D prettier@3',
              usedBy: ['writeFormatted'],
            },
          ],
        },
      },
    ),
  }),
  fact({
    id: 'fact-kit.example-group',
    topics: ['examples', 'schema'],
    title: { en: 'Fields of an example group' },
    description: { en: 'One group in an example package, checked by `check` and written by `build`.' },
    variants: history(
      { since: since070, schema: exampleGroupSchema },
      {
        since: '0.8.0',
        set: {
          '/properties/scenarios/items/properties/outcome': {
            description:
              'What appears on disk or in the terminal after running the code. An item is a string, or `{ fact, field?, text? }` that names a fact: `field` is a dotted path in it and `text` is what to show, such as a sentence rendered from the fact. In a `.ts` example file write `ref(fact)`, `ref(fact, "a.b")` or `statementFrom(fact, render)`, and the build writes the object. `fact` must exist (`unknown-fact-id`), and `field` must be in at least one row of the fact (`ref`).',
            type: 'array',
            items: {
              oneOf: [
                nonEmpty,
                {
                  type: 'object',
                  required: ['fact'],
                  additionalProperties: false,
                  properties: { fact: nonEmpty, field: nonEmpty, text: defs.Text },
                },
              ],
            },
          },
        },
      },
    ),
  }),
]

const entry: FactsSource = {
  describes: { 'fact-kit-js': kit.version },
  publish: { target: 'npm', name: 'fact-kit' },
  facts,
}

export default entry
