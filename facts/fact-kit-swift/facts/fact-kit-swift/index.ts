// Facts about the Swift reader in packages/fact-kit-swift/Sources/. They are the spec of its public API, and the reader does not import them.
import { readerFacts } from '../../../_lib/readers-lib.ts'

const options = [
  { name: 'version', js: 'options.version', type: 'String?', required: false, default: 'nil' },
  { name: 'include', js: 'options.include', type: '[String]', required: false, default: '[]' },
  { name: 'platform', js: 'options.platform', type: 'String?', required: false, default: 'nil' },
  { name: 'os', js: 'options.os', type: 'String?', required: false, default: 'nil' },
]

export default readerFacts(
  {
    tool: 'fact-kit-swift',
    language: 'Swift',
    package: [
      // 0.3.0-alpha.1 was published from this repository, tagged with the bare version.
      {
        since: '0.3.0-alpha.1',
        value: {
          registry: 'swiftpm',
          name: 'https://github.com/carlos-space/fact-kit',
          import: 'FactKit',
          tagPrefix: '',
          requires: 'swift-tools-version 6.0',
        },
      },
      // From 0.3.0-alpha.2 it is published from the mirror repository, whose tags are X.Y.Z.
      {
        since: '0.3.0-alpha.2',
        value: {
          registry: 'swiftpm',
          name: 'https://github.com/carlos-space/fact-kit-swift',
          import: 'FactKit',
          tagPrefix: '',
          sourceTagPrefix: 'fact-kit-swift/v',
          requires: 'swift-tools-version 6.0',
        },
      },
    ],
    read: {
      name: 'readFacts',
      signature:
        'readFacts(_ spec: String, root: URL, version: String? = nil, include: [String] = [], platform: String? = nil, os: String? = nil) throws -> FactReader',
      parameters: [
        { name: 'spec', js: 'spec', type: 'String', required: true },
        { name: 'root', js: 'options.root', type: 'URL', required: true },
        ...options,
      ],
      returns: {
        type: 'FactReader',
        members: [
          { name: 'package', js: 'package' },
          { name: 'version', js: 'version' },
          { name: 'entry', js: 'entry' },
          { name: 'describes', js: 'describes' },
          { name: 'publish', js: 'publish' },
          { name: 'facts', js: 'facts' },
          { name: 'has', js: 'has' },
          { name: 'get', js: 'get' },
          { name: 'value', js: 'value' },
        ],
      },
    },
    select: {
      name: 'selectFacts',
      signature:
        'selectFacts(_ index: Data, version: String? = nil, include: [String] = [], platform: String? = nil, os: String? = nil) throws -> [SelectedFact]',
      parameters: [{ name: 'index', js: 'index', type: 'Data', required: true }, ...options],
      returns: '[SelectedFact]',
    },
    errors: {
      type: 'enum FactReadError: Error',
      code: 'error.code',
      codes: [
        { code: 'not-an-index', variant: 'FactReadError.notAnIndex' },
        { code: 'unsupported-index-format', variant: 'FactReadError.unsupportedIndexFormat' },
        { code: 'not-found', variant: 'FactReadError.notFound' },
        { code: 'invalid-version', variant: 'FactReadError.invalidVersion' },
      ],
    },
  },
  '0.3.0-alpha.1',
)
