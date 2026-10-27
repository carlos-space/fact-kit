import { readerSpec } from '../../readers-test.ts'

readerSpec('rs', { version: 'head', include: ['readers'] }, { read: 'read_facts', select: 'select_facts' })
