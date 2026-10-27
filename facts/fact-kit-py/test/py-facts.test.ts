import { readerSpec } from '../../_lib/readers-test.ts'

readerSpec('fact-kit-py', '0.3.0-alpha.1', { read: 'read_facts', select: 'select_facts' })
