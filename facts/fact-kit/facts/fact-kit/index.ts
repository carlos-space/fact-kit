// Facts about fact-kit itself. They are the spec, and fact-kit's code does not import them. The tests in
// test/fact-kit-spec.test.ts compare each one with the implementation, so a change on either side fails there.
import type { Fact, FactsModule } from '../../../../js/src/index.ts'
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
      'Where the fact comes from. `published` is written by the tool itself, `converted` is generated from an upstream file, `observed` is read from documentation or measured.',
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
      description: 'Locations of the facts this one is computed from: `<id>`, or `<spec>:<id>` for another package.',
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
    entry: { ...nonEmpty, description: 'Sub-path of the entry, e.g. `claude-code`.' },
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
    facts: { type: 'array', items: { $ref: 'urn:fact-kit:fact' } },
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
      '1': 'A problem was found, or the command failed.',
      '2': 'Wrong usage: no command, an unknown command, or the wrong number of arguments.',
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
    ],
  },
  build: {
    summary: 'Build facts/<entry>/index.ts into dist/<entry>/index.json and schemas/.',
    arguments: [],
    options: [
      dirOption('--cwd', '<dir>', 'the current directory', 'Package directory.'),
      dirOption('--facts-dir', '<dir>', 'facts', 'Fact sources.'),
      dirOption('--out-dir', '<dir>', 'dist', 'Output directory.'),
      { flag: '--write-exports', summary: 'Add the missing "exports" entries to package.json.' },
    ],
  },
  diff: {
    summary: 'List the fact ids added, removed and changed between two index.json files.',
    arguments: ['<old>', '<new>'],
    options: [{ flag: '--json', summary: 'Print the result as JSON: { added, removed, changed }.' }],
  },
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
  exports: [
    {
      name: 'defineFacts',
      signature: 'defineFacts(module: FactsModule) => FactsModule',
      summary: 'Identity helper that types the default export of `facts/<entry>/index.ts`.',
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

const problemCodes = [
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
]

const fact = (f: Omit<Fact, 'tool' | 'source'>): Fact => ({ ...f, tool: 'fact-kit', source: published })

const facts: Fact[] = [
  fact({
    id: 'fact-kit.fact',
    topics: ['fact', 'schema'],
    title: { en: 'Fields of a fact' },
    description: { en: 'The shape of one fact in an `index.json`.' },
    content: { schema: factSchema },
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
    topics: ['cli', 'check', 'build', 'diff'],
    title: { en: 'fact-kit commands and options' },
    content: { value: commands },
  }),
  fact({
    id: 'fact-kit.problem-codes',
    topics: ['check'],
    title: { en: 'Problem codes of check and build' },
    description: { en: 'The stable `code` of each problem. The message is for people and can change.' },
    content: { value: problemCodes },
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
    content: { value: moduleApi },
  }),
  fact({
    id: 'fact-kit.example-group',
    topics: ['examples', 'schema'],
    title: { en: 'Fields of an example group' },
    description: { en: 'One group in an example package, checked by `check`.' },
    content: { schema: exampleGroupSchema },
  }),
]

const entry: FactsModule = { describes: { 'fact-kit': kit.version }, facts }

export default entry
