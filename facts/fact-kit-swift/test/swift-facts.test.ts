import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('fact-kit-swift', '0.3.0-alpha.1', { read: 'readFacts', select: 'selectFacts' }, [
  { version: '0.3.0-alpha.1', since: '0.3.0-alpha.1', name: 'https://github.com/carlos-space/fact-kit', tagPrefix: '' },
  {
    version: '0.3.0-alpha.2',
    since: '0.3.0-alpha.2',
    name: 'https://github.com/carlos-space/fact-kit-swift',
    tagPrefix: '',
  },
  {
    version: '0.5.1-alpha.1',
    since: '0.5.1-alpha.1',
    name: 'https://github.com/promptex-ai/fact-kit-swift',
    tagPrefix: '',
  },
  { version: '0.5.1', since: '0.5.1-alpha.1', name: 'https://github.com/promptex-ai/fact-kit-swift', tagPrefix: '' },
  { version: undefined, since: '0.5.1-alpha.1', name: 'https://github.com/promptex-ai/fact-kit-swift', tagPrefix: '' },
])
