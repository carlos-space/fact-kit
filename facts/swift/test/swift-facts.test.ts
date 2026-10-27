import { readerSpec } from '../../readers-test.ts'

readerSpec('swift', { version: 'head', include: ['readers'] }, { read: 'readFacts', select: 'selectFacts' })
