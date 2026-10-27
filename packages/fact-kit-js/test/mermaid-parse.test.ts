// @vitest-environment jsdom
// Runs the real mermaid parser on what the three renderers write. mermaid needs a DOM, so this file runs in jsdom.
import mermaid from 'mermaid'
import { describe, expect, test } from 'vitest'
import {
  factsOf,
  observedDoc,
  ref,
  relations,
  relationsToMermaid,
  sequence,
  sequenceToMermaid,
  stateMachine,
  stateMachineToMermaid,
  useCase,
} from '../src/index.ts'

const mf = factsOf({ tool: 'm', source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }) })
const rule = mf.statement('rule', 'All criteria are met.')
const target = mf.schema('target', { type: 'object', properties: { id: { type: 'string' } } })

// Names with spaces, quotes, `#`, `;`, `|`, a reserved word and Chinese, the cases the renderers escape.
const awkward = ['start', 'end', 'a "quoted" one', 'has#hash;semi|bar', '中文 狀態']

const machine = stateMachine({
  initial: 'start',
  states: awkward,
  transitions: [
    { from: 'start', to: 'end', event: ['go', 'stop now'], guard: ref(rule) },
    { from: 'end', to: 'a "quoted" one', event: 'say "hi"' },
    { from: 'a "quoted" one', to: 'has#hash;semi|bar', guard: 'x > 1; y' },
    { from: 'has#hash;semi|bar', to: '中文 狀態' },
  ],
})
const graph = relations({
  nodes: awkward,
  edges: [
    { from: 'start', to: 'end', name: 'has many', cardinality: 'many' },
    { from: 'end', to: 'a "quoted" one', name: 'is "owned" by' },
    { from: 'has#hash;semi|bar', to: '中文 狀態', name: 'a|b;c#d' },
  ],
})
const flow = sequence({
  participants: awkward,
  steps: [
    { from: 'start', to: 'end', action: 'ask: "what"?' },
    { from: 'end', to: 'has#hash;semi|bar', action: 'reply; then #1' },
    { from: 'has#hash;semi|bar', to: '中文 狀態', action: '回覆' },
  ],
})
const flowUseCase = useCase({
  input: ref(target, 'id'),
  steps: [
    { layer: 'application', action: 'read "it"' },
    { layer: 'domain', action: 'check; rule #1', rule },
    { layer: 'domain', action: '發出事件', emits: target },
    { layer: 'infrastructure', action: 'save|store' },
  ],
  errors: ['not-found'],
})

const outputs: [string, string, string][] = [
  ['stateMachineToMermaid', stateMachineToMermaid(machine), 'stateDiagram'],
  ['stateMachineToMermaid (fact)', stateMachineToMermaid(mf.value('machine', machine)), 'stateDiagram'],
  ['relationsToMermaid', relationsToMermaid(graph), 'flowchart-v2'],
  ['sequenceToMermaid (Sequence)', sequenceToMermaid(flow), 'sequence'],
  ['sequenceToMermaid (UseCase)', sequenceToMermaid(flowUseCase), 'sequence'],
  ['sequenceToMermaid (UseCase fact)', sequenceToMermaid(mf.value('use-case', flowUseCase)), 'sequence'],
]

describe('c007 the mermaid parser accepts what the renderers write', () => {
  test.each(outputs)('%s', async (name, text, diagramType) => {
    const parsed = await mermaid.parse(text)
    expect(parsed, name).toMatchObject({ diagramType })
  })

  test('the parser does reject a diagram that is wrong, so the checks above can fail', async () => {
    await expect(mermaid.parse('sequenceDiagram\n    p0->>>>')).rejects.toThrow()
    await expect(mermaid.parse('stateDiagram-v2\n    s0 --> ')).rejects.toThrow()
    await expect(mermaid.parse('flowchart LR\n    n0["unclosed')).rejects.toThrow()
  })
})
