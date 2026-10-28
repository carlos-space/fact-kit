// Sample facts published privately to GitHub Packages, so samples/rust and samples/go can show that a private
// -facts package installed with pnpm is read the same way as a public one.
import { defineFacts } from 'fact-kit'

export default defineFacts({
  describes: {},
  facts: [
    {
      id: 'fact-kit-sample.greeting',
      tool: 'fact-kit-sample',
      topics: ['sample'],
      title: 'Greeting',
      content: { value: 'hello from a private facts package' },
      source: { kind: 'published' },
    },
    {
      id: 'fact-kit-sample.max-retries',
      tool: 'fact-kit-sample',
      topics: ['sample'],
      title: 'Maximum retries',
      content: { value: 3 },
      source: { kind: 'published' },
    },
  ],
})
