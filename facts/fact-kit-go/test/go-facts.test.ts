import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('fact-kit-go', '0.3.0-alpha.1', { read: 'ReadFacts', select: 'SelectFacts' })
