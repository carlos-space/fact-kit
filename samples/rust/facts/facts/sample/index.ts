// The facts of this sample crate. The Rust test reads the built dist/sample/index.json through self-reference.
import { defineFacts } from 'fact-kit'

export default defineFacts({
  describes: {},
  facts: [
    {
      id: 'rust-sample.greeting-max-length',
      tool: 'rust-sample',
      topics: ['sample'],
      title: 'Longest greeting',
      content: { value: 42 },
      source: { kind: 'published' },
    },
  ],
})
