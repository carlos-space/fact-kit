// Facts about the Go reader in go/. They are the spec of its public API, and the reader does not import them.
import { readerFacts } from '../../../readers-lib.ts'

const options = [
  { name: 'opts.Version', js: 'options.version', type: 'string', required: false, default: '""' },
  { name: 'opts.Include', js: 'options.include', type: '[]string', required: false, default: 'nil' },
  { name: 'opts.Platform', js: 'options.platform', type: 'string', required: false, default: '""' },
  { name: 'opts.OS', js: 'options.os', type: 'string', required: false, default: '""' },
]

export default readerFacts({
  tool: 'fact-kit-go',
  language: 'Go',
  package: {
    registry: 'go module proxy',
    name: 'github.com/carlos-space/fact-kit/go',
    import: 'factkit',
    tagPrefix: 'go/v',
    requires: 'go>=1.26',
  },
  read: {
    name: 'ReadFacts',
    signature: 'ReadFacts(spec string, opts ReadFactsOptions) (*FactReader, error)',
    parameters: [
      { name: 'spec', js: 'spec', type: 'string', required: true },
      {
        name: 'opts.Root',
        js: 'options.root',
        type: 'string',
        required: false,
        default: 'the current working directory',
      },
      ...options,
    ],
    returns: {
      type: '*FactReader',
      members: [
        { name: 'Package', js: 'package' },
        { name: 'Version', js: 'version' },
        { name: 'Entry', js: 'entry' },
        { name: 'Describes', js: 'describes' },
        { name: 'Facts', js: 'facts' },
        { name: 'Has', js: 'has' },
        { name: 'Get', js: 'get' },
        { name: 'Value', js: 'value' },
      ],
    },
  },
  select: {
    name: 'SelectFacts',
    signature: 'SelectFacts(index []byte, opts SelectOptions) ([]SelectedFact, error)',
    parameters: [{ name: 'index', js: 'index', type: '[]byte', required: true }, ...options],
    returns: '([]SelectedFact, error)',
  },
  errors: {
    type: '*FactReadError',
    code: 'errors.As(err, &e); e.Code',
    codes: [
      { code: 'not-an-index', variant: 'CodeNotAnIndex' },
      { code: 'unsupported-index-format', variant: 'CodeUnsupportedIndexFormat' },
      { code: 'not-found', variant: 'CodeNotFound' },
      { code: 'invalid-version', variant: 'CodeInvalidVersion' },
    ],
  },
})
