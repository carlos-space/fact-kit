import { readerSpec } from '../../readers-test.ts'

readerSpec('go', { version: 'head', include: ['readers'] }, { read: 'ReadFacts', select: 'SelectFacts' })
