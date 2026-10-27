import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  BuilderError,
  HistoryError,
  buildFacts,
  factsOf,
  history,
  keyed,
  observedDoc,
  relations,
  relationsToMermaid,
  sequence,
  sequenceToMermaid,
  stateMachine,
  stateMachineToMermaid,
} from '../src/index.ts'
import { BUILDER } from '../src/markers.ts'
import { cleanTmp, cli, makeTmp, writeTree } from './helpers.ts'

afterEach(cleanTmp)

const src = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href
const mf = factsOf({
  tool: 'flow',
  source: observedDoc({ url: 'https://example.com/doc', fetched: '2026-10-01' }),
})

const errorOf = (fn: () => unknown): Error => {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}
const builderFailure = (fn: () => unknown): string => {
  const error = errorOf(fn)
  expect(error).toBeInstanceOf(BuilderError)
  return error.message
}
const historyFailure = (fn: () => unknown): string => {
  const error = errorOf(fn)
  expect(error).toBeInstanceOf(HistoryError)
  return error.message
}
const valueAt = (variants: ReturnType<typeof history>, i: number): any => (variants[i]?.content as any).value

const machine = () =>
  stateMachine({
    initial: 'draft',
    states: ['draft', 'active', 'done', 'blocked'],
    transitions: [
      { from: 'draft', to: 'active', event: 'start' },
      { from: 'active', to: 'done', event: ['finish', 'close'], guard: 'all criteria met' },
    ],
  })
const graph = () =>
  relations({
    nodes: ['a', 'b', 'c'],
    edges: [
      { from: 'a', to: 'b', name: 'has', cardinality: 'many' },
      { from: 'b', to: 'a', name: 'owned by' },
    ],
  })
const flow = () =>
  sequence({
    participants: ['user', 'api', 'db'],
    steps: [
      { from: 'user', to: 'api', action: 'ask' },
      { from: 'api', to: 'db', action: 'query' },
    ],
  })

describe('c002 the three builders make values', () => {
  test('stateMachine gives { initial, states, transitions } keyed by name and by from and to', () => {
    const value = machine()
    expect(Object.keys(value)).toEqual(['initial', 'states', 'transitions'])
    expect(JSON.parse(JSON.stringify(value)).states).toEqual(['draft', 'active', 'done', 'blocked'])
    expect(Object.getOwnPropertySymbols(value).map(String)).toContain('Symbol(fact-kit.builder)')
    expect((value as any)[BUILDER]).toBe('stateMachine')
    expect(Object.getOwnPropertySymbols(value.transitions).map(String)).toContain('Symbol(fact-kit.keys)')
  })

  test('relations gives { nodes, edges } and sequence gives { participants, steps }', () => {
    expect(Object.keys(graph())).toEqual(['nodes', 'edges'])
    expect((graph() as any)[BUILDER]).toBe('relations')
    expect(Object.keys(flow())).toEqual(['participants', 'steps'])
    expect((flow() as any)[BUILDER]).toBe('sequence')
  })

  test('go into mf.value as a value fact, and the fact exposes the fields', () => {
    const fact = mf.value('machine', machine())
    expect(fact.content).toEqual({ value: JSON.parse(JSON.stringify(machine())) })
    expect(fact.initial).toBe('draft')
    expect(fact.states).toEqual(['draft', 'active', 'done', 'blocked'])
    expect(mf.value('graph', graph()).content).toHaveProperty('value.nodes')
    expect(mf.value('flow', flow()).content).toHaveProperty('value.steps')
  })

  test('the type checker takes the names as literal types', () => {
    // @ts-expect-error 'nowhere' is not one of the states
    expect(() =>
      stateMachine({ initial: 'draft', states: ['draft'], transitions: [{ from: 'draft', to: 'nowhere' }] }),
    ).toThrow()
  })
})

describe('c003 mermaid', () => {
  test('stateMachineToMermaid', () => {
    expect(stateMachineToMermaid(machine())).toBe(
      [
        'stateDiagram-v2',
        '    state "draft" as s0',
        '    state "active" as s1',
        '    state "done" as s2',
        '    state "blocked" as s3',
        '    [*] --> s0',
        '    s0 --> s1: start',
        '    s1 --> s2: finish, close [all criteria met]',
      ].join('\n'),
    )
  })

  test('relationsToMermaid', () => {
    expect(relationsToMermaid(graph())).toBe(
      [
        'flowchart LR',
        '    n0["a"]',
        '    n1["b"]',
        '    n2["c"]',
        '    n0 -->|has| n1',
        '    n1 -->|owned by| n0',
      ].join('\n'),
    )
  })

  test('sequenceToMermaid', () => {
    expect(sequenceToMermaid(flow())).toBe(
      [
        'sequenceDiagram',
        '    participant p0 as user',
        '    participant p1 as api',
        '    participant p2 as db',
        '    p0->>p1: ask',
        '    p1->>p2: query',
      ].join('\n'),
    )
  })

  test('take a fact whose content is the value, and give the same text', () => {
    expect(stateMachineToMermaid(mf.value('machine', machine()))).toBe(stateMachineToMermaid(machine()))
    expect(relationsToMermaid(mf.value('graph', graph()))).toBe(relationsToMermaid(graph()))
    expect(sequenceToMermaid(mf.value('flow', flow()))).toBe(sequenceToMermaid(flow()))
  })

  test('keep names with spaces, quotes and mermaid markup in the label, behind an id', () => {
    const odd = stateMachine({
      initial: 'a "b"',
      states: ['a "b"', 'end; #1', 'state'],
      transitions: [{ from: 'a "b"', to: 'end; #1', event: 'x|y' }],
    })
    expect(stateMachineToMermaid(odd)).toBe(
      [
        'stateDiagram-v2',
        '    state "a #quot;b#quot;" as s0',
        '    state "end#59; #35;1" as s1',
        '    state "state" as s2',
        '    [*] --> s0',
        '    s0 --> s1: x#124;y',
      ].join('\n'),
    )
  })

  test('refuse a fact without a value and a value that does not hold together', () => {
    expect(builderFailure(() => stateMachineToMermaid(mf.statement('s', 'text')))).toContain('no value to draw')
    expect(
      builderFailure(() => relationsToMermaid({ nodes: ['a'], edges: [{ from: 'a', to: 'z', name: 'x' }] })),
    ).toContain('"z"')
  })
})

describe('c004 an end that is not declared fails as builder', () => {
  test('a transition to a missing state names the transition', () => {
    const message = builderFailure(() =>
      stateMachine({
        initial: 'a',
        states: ['a'],
        transitions: [{ from: 'a', to: 'b' }] as any,
      }),
    )
    expect(message).toContain('transition ["a","b"]')
    expect(message).toContain('"to" is "b"')
  })

  test('initial must be a state', () => {
    expect(builderFailure(() => stateMachine({ initial: 'x', states: ['a'], transitions: [] } as any))).toContain(
      'initial "x"',
    )
  })

  test('an edge to a missing node and a step to a missing participant name their key', () => {
    expect(
      builderFailure(() => relations({ nodes: ['a'], edges: [{ from: 'a', to: 'z', name: 'has' }] } as any)),
    ).toContain('edge ["a","z","has"]')
    expect(
      builderFailure(() => sequence({ participants: ['a'], steps: [{ from: 'a', to: 'z', action: 'go' }] } as any)),
    ).toContain('step "go"')
  })

  test('a version row that drops a state a transition still uses fails, naming the row and the transition', () => {
    const message = builderFailure(() =>
      history({ since: '1.0.0', value: machine() }, { since: '1.1.0', remove: { '/states': ['active'] } }),
    )
    expect(message).toContain('history row 1 (since "1.1.0")')
    expect(message).toContain('transition ["draft","active"]')
  })

  test('the same row passes once the transitions go too', () => {
    const v = history(
      { since: '1.0.0', value: machine() },
      {
        since: '1.1.0',
        remove: {
          '/states': ['active', 'done'],
          '/transitions': [
            ['draft', 'active'],
            ['active', 'done'],
          ],
        },
      },
    )
    expect(valueAt(v, 1).states).toEqual(['draft', 'blocked'])
    expect(valueAt(v, 1).transitions).toEqual([])
  })

  test('a build with a bad flow stops, and check reports the code builder', async () => {
    const dir = makeTmp('flow-builder')
    writeTree(dir, {
      'package.json': { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} },
      'facts/flow/index.ts': [
        `import { factsOf, observedDoc, stateMachine } from '${src}'`,
        "const mf = factsOf({ tool: 'flow', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        "const m = mf.value('m', stateMachine({ initial: 'a', states: ['a'], transitions: [{ from: 'a', to: 'gone' }] } as any))",
        "export default { describes: { flow: '1.0.0' }, facts: [m] }",
      ].join('\n'),
    })
    const build = await cli(['build', '--cwd', dir])
    expect(build.code).toBe(1)
    expect(build.stderr).toContain('transition ["a","gone"]')
    const check = await cli(['check', '--cwd', dir, '--json'])
    const problem = JSON.parse(check.stdout).problems.find((p: any) => p.code === 'builder')
    expect(problem.message).toContain('transition ["a","gone"]')
  })

  test('a version row that drops a node or a participant that is still used fails the same way', () => {
    expect(
      builderFailure(() => history({ since: '1', value: graph() }, { since: '2', remove: { '/nodes': ['b'] } })),
    ).toContain('edge ["a","b","has"]')
    expect(
      builderFailure(() => history({ since: '1', value: flow() }, { since: '2', remove: { '/participants': ['db'] } })),
    ).toContain('step "query"')
  })
})

// For each keyed collection: a replace and a remove that match, and the same that do not.
describe('c005 history rules for the keyed collections of the flows', () => {
  test('states: remove by name, replace by name', () => {
    const v = history(
      { since: '1', value: machine() },
      { since: '2', remove: { '/states': ['blocked'] } },
      { since: '3', replace: { '/states': ['draft'] } },
    )
    expect(valueAt(v, 1).states).toEqual(['draft', 'active', 'done'])
    expect(valueAt(v, 2).states).toEqual(['draft', 'active', 'done'])
    expect(
      historyFailure(() => history({ since: '1', value: machine() }, { since: '2', remove: { '/states': ['gone'] } })),
    ).toContain('no item has the key "gone"')
    expect(
      historyFailure(() => history({ since: '1', value: machine() }, { since: '2', replace: { '/states': ['gone'] } })),
    ).toContain('no item has the key "gone"')
  })

  test('transitions: remove and replace by from and to', () => {
    const v = history(
      { since: '1', value: machine() },
      { since: '2', replace: { '/transitions': [{ from: 'draft', to: 'active', event: ['start', 'open'] }] } },
      { since: '3', remove: { '/transitions': [['active', 'done']] } },
    )
    expect(valueAt(v, 1).transitions[0]).toEqual({ from: 'draft', to: 'active', event: ['start', 'open'] })
    expect(valueAt(v, 2).transitions).toEqual([{ from: 'draft', to: 'active', event: ['start', 'open'] }])
    expect(
      historyFailure(() =>
        history(
          { since: '1', value: machine() },
          { since: '2', replace: { '/transitions': [{ from: 'draft', to: 'done' }] } },
        ),
      ),
    ).toContain('no item has the key ["draft","done"]')
    expect(
      historyFailure(() =>
        history({ since: '1', value: machine() }, { since: '2', remove: { '/transitions': [['done', 'draft']] } }),
      ),
    ).toContain('no item has the key ["done","draft"]')
    expect(
      historyFailure(() =>
        history(
          { since: '1', value: machine() },
          { since: '2', add: { '/transitions': [{ from: 'draft', to: 'active' }] } },
        ),
      ),
    ).toContain('already there')
  })

  test('nodes: remove and replace by name', () => {
    const v = history(
      { since: '1', value: graph() },
      { since: '2', remove: { '/nodes': ['c'] } },
      { since: '3', replace: { '/nodes': ['a'] } },
    )
    expect(valueAt(v, 1).nodes).toEqual(['a', 'b'])
    expect(valueAt(v, 2).nodes).toEqual(['a', 'b'])
    expect(
      historyFailure(() => history({ since: '1', value: graph() }, { since: '2', remove: { '/nodes': ['z'] } })),
    ).toContain('no item has the key "z"')
    expect(
      historyFailure(() => history({ since: '1', value: graph() }, { since: '2', replace: { '/nodes': ['z'] } })),
    ).toContain('no item has the key "z"')
    expect(
      historyFailure(() => history({ since: '1', value: graph() }, { since: '2', add: { '/nodes': ['a'] } })),
    ).toContain('already there')
  })

  test('edges: remove and replace by from, to and name', () => {
    const v = history(
      { since: '1', value: graph() },
      { since: '2', replace: { '/edges': [{ from: 'a', to: 'b', name: 'has', cardinality: 'one' }] } },
      { since: '3', remove: { '/edges': [['b', 'a', 'owned by']] } },
    )
    expect(valueAt(v, 1).edges[0].cardinality).toBe('one')
    expect(valueAt(v, 2).edges).toEqual([{ from: 'a', to: 'b', name: 'has', cardinality: 'one' }])
    expect(
      historyFailure(() =>
        history(
          { since: '1', value: graph() },
          { since: '2', replace: { '/edges': [{ from: 'a', to: 'b', name: 'other' }] } },
        ),
      ),
    ).toContain('no item has the key ["a","b","other"]')
    expect(
      historyFailure(() => history({ since: '1', value: graph() }, { since: '2', remove: { '/edges': [['a', 'b']] } })),
    ).toContain('array of 3 values')
  })

  test('steps: remove and replace by action, add only at the end', () => {
    const v = history(
      { since: '1', value: flow() },
      { since: '2', replace: { '/steps': [{ from: 'user', to: 'db', action: 'query' }] } },
      { since: '3', add: { '/steps': [{ from: 'db', to: 'user', action: 'reply' }] } },
      { since: '4', remove: { '/steps': ['ask'] } },
    )
    expect(valueAt(v, 1).steps[1]).toEqual({ from: 'user', to: 'db', action: 'query' })
    expect(valueAt(v, 2).steps.map((s: any) => s.action)).toEqual(['ask', 'query', 'reply'])
    expect(valueAt(v, 3).steps.map((s: any) => s.action)).toEqual(['query', 'reply'])
    expect(
      historyFailure(() =>
        history(
          { since: '1', value: flow() },
          { since: '2', replace: { '/steps': [{ from: 'user', to: 'api', action: 'nope' }] } },
        ),
      ),
    ).toContain('no item has the key "nope"')
    expect(
      historyFailure(() => history({ since: '1', value: flow() }, { since: '2', remove: { '/steps': ['nope'] } })),
    ).toContain('no item has the key "nope"')
  })

  test('steps: the whole list can be replaced to insert in the middle', () => {
    const v = history(
      { since: '1', value: flow() },
      {
        since: '2',
        replace: {
          '/steps': keyed(
            [
              { from: 'user', to: 'api', action: 'ask' },
              { from: 'api', to: 'api', action: 'validate' },
              { from: 'api', to: 'db', action: 'query' },
            ],
            ['action'],
          ),
        },
      },
    )
    expect(valueAt(v, 1).steps.map((s: any) => s.action)).toEqual(['ask', 'validate', 'query'])
  })

  test('a key that appears twice in one collection fails', () => {
    expect(historyFailure(() => stateMachine({ initial: 'a', states: ['a', 'a'], transitions: [] }))).toContain('"a"')
    expect(
      historyFailure(() =>
        stateMachine({
          initial: 'a',
          states: ['a', 'b'],
          transitions: [
            { from: 'a', to: 'b', event: 'x' },
            { from: 'a', to: 'b', event: 'y' },
          ],
        }),
      ),
    ).toContain('["a","b"]')
    expect(historyFailure(() => relations({ nodes: ['a', 'a'], edges: [] }))).toContain('"a"')
    expect(
      historyFailure(() =>
        relations({
          nodes: ['a', 'b'],
          edges: [
            { from: 'a', to: 'b', name: 'x' },
            { from: 'a', to: 'b', name: 'x' },
          ],
        }),
      ),
    ).toContain('["a","b","x"]')
    expect(historyFailure(() => sequence({ participants: ['a', 'a'], steps: [] }))).toContain('"a"')
    expect(
      historyFailure(() =>
        sequence({
          participants: ['a', 'b'],
          steps: [
            { from: 'a', to: 'b', action: 'go' },
            { from: 'b', to: 'a', action: 'go' },
          ],
        }),
      ),
    ).toContain('"go"')
  })

  test('a duplicate that a row brings in by set, past keyed, fails as builder', () => {
    expect(
      builderFailure(() =>
        history(
          { since: '1', value: flow() },
          {
            since: '2',
            set: {
              '/steps': [
                { from: 'user', to: 'api', action: 'ask' },
                { from: 'api', to: 'db', action: 'ask' },
              ],
            },
          },
        ),
      ),
    ).toContain('steps has the key "ask" twice')
  })

  test('a built package keeps the rows of a machine written with history', async () => {
    const dir = makeTmp('flow-history')
    writeTree(dir, {
      'package.json': { name: 'demo-facts', version: '1.0.0', type: 'module', exports: {} },
      'facts/flow/index.ts': [
        `import { factsOf, observedDoc, stateMachine, history } from '${src}'`,
        "const mf = factsOf({ tool: 'flow', source: observedDoc({ url: 'https://example.com/x', fetched: '2026-10-01' }) })",
        "const m = mf.value('m', history({ since: '1.0.0', value: stateMachine({ initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', to: 'b' }] }) }, { since: '1.1.0', add: { '/states': ['c'], '/transitions': [{ from: 'b', to: 'c', event: ['x', 'y'] }] } }))",
        "export default { describes: { flow: '1.1.0' }, facts: [m] }",
      ].join('\n'),
    })
    const result = await buildFacts({ cwd: dir, writeExports: true })
    expect(result.problems).toEqual([])
    const fact = JSON.parse(readFileSync(join(dir, 'dist/flow/index.json'), 'utf8')).facts[0]
    expect(fact.variants).toHaveLength(2)
    expect(fact.variants[1].content.value.transitions[1]).toEqual({ from: 'b', to: 'c', event: ['x', 'y'] })
  })
})
