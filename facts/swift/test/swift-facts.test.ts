import { readerSpec } from '../../readers-test.ts'

readerSpec('swift', '0.3.0-alpha.1', { read: 'readFacts', select: 'selectFacts' })
