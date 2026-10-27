import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('swift', '0.3.0-alpha.1', { read: 'readFacts', select: 'selectFacts' })
