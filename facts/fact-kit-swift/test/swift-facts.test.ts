import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('fact-kit-swift', '0.3.0-alpha.1', { read: 'readFacts', select: 'selectFacts' })
