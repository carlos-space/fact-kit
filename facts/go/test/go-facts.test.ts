import { readerSpec } from '../../readers-test.ts'

readerSpec('go', '0.3.0-alpha.1', { read: 'ReadFacts', select: 'SelectFacts' })
