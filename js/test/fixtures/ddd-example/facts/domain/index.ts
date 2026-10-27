// The entry module of the DDD example, so the sample builds as one entry (t005 c004).
import { defineFacts } from 'fact-kit'
import {
  closeMainline,
  closeRequiresCriteria,
  criterion,
  mainline,
  mainlineClosed,
  mainlineStatus,
} from './example.ts'

export default defineFacts({
  describes: { mainflow: '0.1.0' },
  facts: [criterion, mainlineStatus, mainline, closeRequiresCriteria, mainlineClosed, closeMainline],
})
