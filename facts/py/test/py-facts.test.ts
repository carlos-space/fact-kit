import { readerSpec } from '../../readers-test.ts'

readerSpec('py', { version: 'head', include: ['readers'] }, { read: 'read_facts', select: 'select_facts' })
