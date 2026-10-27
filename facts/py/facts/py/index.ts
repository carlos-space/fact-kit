// Facts about the Python reader in py/. They are the spec of its public API, and the reader does not import them.
import { readerFacts } from '../../../readers-lib.ts'

const options = [
  { name: 'version', js: 'options.version', type: 'str | None', required: false, default: 'None' },
  { name: 'include', js: 'options.include', type: 'Iterable[str]', required: false, default: '()' },
  { name: 'platform', js: 'options.platform', type: 'str | None', required: false, default: 'None' },
  { name: 'os', js: 'options.os', type: 'str | None', required: false, default: 'None' },
]

export default readerFacts({
  tool: 'fact-kit-py',
  language: 'Python',
  package: {
    registry: 'pypi',
    name: 'fact-kit',
    import: 'fact_kit',
    tagPrefix: 'py/v',
    requires: 'python>=3.11',
  },
  read: {
    name: 'read_facts',
    signature: 'read_facts(spec, *, root=None, version=None, include=(), platform=None, os=None) -> FactReader',
    parameters: [
      { name: 'spec', js: 'spec', type: 'str', required: true },
      {
        name: 'root',
        js: 'options.root',
        type: 'str | os.PathLike[str] | None',
        required: false,
        default: 'the current working directory',
      },
      ...options,
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
    signature: 'select_facts(index, *, version=None, include=(), platform=None, os=None) -> list[dict]',
    parameters: [{ name: 'index', js: 'index', type: 'Mapping[str, Any]', required: true }, ...options],
    returns: 'list[dict]',
  },
  errors: {
    type: 'FactReadError(Exception)',
    code: 'error.code',
    codes: [
      { code: 'not-an-index', variant: 'FactReadError with code "not-an-index"' },
      { code: 'unsupported-index-format', variant: 'FactReadError with code "unsupported-index-format"' },
      { code: 'not-found', variant: 'FactReadError with code "not-found"' },
      { code: 'invalid-version', variant: 'FactReadError with code "invalid-version"' },
    ],
  },
})
