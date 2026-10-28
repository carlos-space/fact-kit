import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('fact-kit-go', '0.3.0-alpha.1', { read: 'ReadFacts', select: 'SelectFacts' }, [
  { version: '0.3.0-alpha.1', since: '0.3.0-alpha.1', name: 'github.com/carlos-space/fact-kit/go', tagPrefix: 'go/v' },
  { version: '0.3.0-alpha.2', since: '0.3.0-alpha.2', name: 'github.com/carlos-space/fact-kit-go', tagPrefix: 'v' },
  { version: undefined, since: '0.3.0-alpha.2', name: 'github.com/carlos-space/fact-kit-go', tagPrefix: 'v' },
])
