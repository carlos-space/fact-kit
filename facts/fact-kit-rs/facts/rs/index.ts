// Facts about the Rust reader in packages/fact-kit-rs/. They are the spec of its public API, and the reader does not import them.
import { readerFacts } from '../../../_lib/readers-lib.ts'

const options = [
  { name: 'version', js: 'options.version', type: 'Option<String>', required: false, default: 'None' },
  { name: 'include', js: 'options.include', type: 'Vec<String>', required: false, default: 'empty' },
  { name: 'platform', js: 'options.platform', type: 'Option<String>', required: false, default: 'None' },
  { name: 'os', js: 'options.os', type: 'Option<String>', required: false, default: 'None' },
]

export default readerFacts(
  {
    tool: 'fact-kit-rs',
    language: 'Rust',
    package: {
      registry: 'crates.io',
      name: 'fact-kit',
      import: 'fact_kit',
      tagPrefix: 'fact-kit-rs/v',
      requires: 'rust>=1.95, edition 2024',
    },
    read: {
      name: 'read_facts',
      signature: 'read_facts(spec: &str, options: &ReadFactsOptions) -> Result<FactReader, FactReadError>',
      parameters: [
        { name: 'spec', js: 'spec', type: '&str', required: true },
        {
          name: 'options.root',
          js: 'options.root',
          type: 'Option<PathBuf>',
          required: false,
          default: 'the current working directory',
        },
        ...options.map((p) => ({ ...p, name: `options.${p.name}` })),
      ],
      returns: {
        type: 'FactReader',
        members: [
          { name: 'package', js: 'package' },
          { name: 'version', js: 'version' },
          { name: 'entry', js: 'entry' },
          { name: 'describes', js: 'describes' },
          { name: 'facts', js: 'facts' },
          { name: 'has', js: 'has' },
          { name: 'get', js: 'get' },
          { name: 'value', js: 'value' },
        ],
      },
    },
    select: {
      name: 'select_facts',
      signature:
        'select_facts(index: &serde_json::Value, options: &SelectOptions) -> Result<Vec<SelectedFact>, FactReadError>',
      parameters: [
        { name: 'index', js: 'index', type: '&serde_json::Value', required: true },
        ...options.map((p) => ({ ...p, name: `options.${p.name}` })),
      ],
      returns: 'Result<Vec<SelectedFact>, FactReadError>',
    },
    errors: {
      type: 'enum FactReadError',
      code: 'error.code() -> &str',
      codes: [
        { code: 'not-an-index', variant: 'FactReadError::NotAnIndex' },
        { code: 'unsupported-index-format', variant: 'FactReadError::UnsupportedIndexFormat' },
        { code: 'not-found', variant: 'FactReadError::NotFound' },
        { code: 'invalid-version', variant: 'FactReadError::InvalidVersion' },
      ],
    },
  },
  '0.3.0-alpha.1',
)
