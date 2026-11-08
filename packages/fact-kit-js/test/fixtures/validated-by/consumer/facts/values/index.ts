export default {
  describes: {},
  facts: [
    {
      id: 'values.good',
      tool: 'values',
      topics: ['value'],
      title: 'A person that fits the schema',
      validatedBy: '@fixture/shapes:shapes.person',
      content: { value: { name: 'Ann', age: 30 } },
      source: { kind: 'published' },
    },
    {
      id: 'values.bad',
      tool: 'values',
      topics: ['value'],
      title: 'A person that does not fit the schema',
      validatedBy: '@fixture/shapes:shapes.person',
      content: { value: { name: 'A', nickname: 'x' } },
      source: { kind: 'published' },
    },
  ],
}
