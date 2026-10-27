import { useCaseProblem } from './ddd.ts'
import type { UseCase } from './ddd.ts'
import { keyed } from './history.ts'
import type { FactRef } from './builders.ts'
import { BUILDER, BuilderError, REF_TOKEN, isObject, refTarget, registerBuilderCheck, setMark } from './markers.ts'
import type { Fact } from './types.ts'

// --- shapes ------------------------------------------------------------------------------------------------
export interface Transition<S extends string = string> {
  from: S
  to: S
  /** One event, or several between the same two states (the key is `from` plus `to`). */
  event?: string | string[]
  /** Applies to every event of the transition. A `ref(fact)` is the location of that fact once built. */
  guard?: string | FactRef
}

export interface StateMachine<S extends string = string> {
  initial: S
  states: S[]
  transitions: Transition<S>[]
}

export interface Relation<N extends string = string> {
  from: N
  to: N
  name: string
  cardinality?: 'one' | 'many'
}

export interface Relations<N extends string = string> {
  nodes: N[]
  edges: Relation<N>[]
}

export interface SequenceStep<P extends string = string> {
  from: P
  to: P
  action: string
}

export interface Sequence<P extends string = string> {
  participants: P[]
  steps: SequenceStep<P>[]
}

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)
const isName = (value: unknown): value is string => typeof value === 'string' && value !== ''

// --- checks: what each builder verifies of its own output, at build time and again after every history row --
/** A list of `field` of each item that is not in `known`, as one message that names the key of the item. */
function dangling(
  items: unknown,
  what: string,
  keyFields: readonly string[],
  ends: readonly string[],
  known: readonly unknown[],
  owner: string,
): string | undefined {
  if (!Array.isArray(items)) return `${what} must be a list, got ${show(items)}`
  for (const item of items) {
    if (!isObject(item)) return `${what} item ${show(item)} must be an object`
    const key = keyFields.length === 1 ? item[keyFields[0] as string] : keyFields.map((k) => item[k])
    for (const end of ends) {
      if (!known.includes(item[end])) {
        return `${what} ${show(key)}: "${end}" is ${show(item[end])}, which is not in ${owner}`
      }
    }
  }
  return undefined
}

/** A message for the first key that appears twice in `items`, naming the key. */
function repeated(items: unknown, what: string, keyFields: readonly string[]): string | undefined {
  if (!Array.isArray(items)) return `${what} must be a list, got ${show(items)}`
  const seen = new Set<string>()
  for (const item of items) {
    const key =
      keyFields.length === 0
        ? item
        : isObject(item)
          ? keyFields.length === 1
            ? item[keyFields[0] as string]
            : keyFields.map((k) => item[k])
          : undefined
    const id = show(key)
    if (seen.has(id)) return `${what} has the key ${id} twice`
    seen.add(id)
  }
  return undefined
}

function stateMachineProblem(root: unknown): string | undefined {
  if (!isObject(root)) return `a state machine must be an object, got ${show(root)}`
  const { initial, states, transitions } = root
  const dup = repeated(states, 'states', []) ?? repeated(transitions, 'transitions', ['from', 'to'])
  if (dup) return dup
  const list = states as unknown[]
  if (!list.every(isName)) return `states must be non-empty strings, got ${show(states)}`
  if (!(list as unknown[]).includes(initial)) return `initial ${show(initial)} is not in states ${show(states)}`
  const missing = dangling(transitions, 'transition', ['from', 'to'], ['from', 'to'], list, 'states')
  if (missing) return missing
  for (const t of transitions as Record<string, unknown>[]) {
    const key = show([t.from, t.to])
    const event = t.event
    if (event !== undefined && !isName(event) && !(Array.isArray(event) && event.length > 0 && event.every(isName))) {
      return `transition ${key}: "event" must be a string or a list of strings, got ${show(event)}`
    }
    if (t.guard !== undefined && !isName(t.guard)) {
      // A `ref(fact)` is a string until the build, so it passes here.
      return `transition ${key}: "guard" must be a string or a ref(fact), got ${show(t.guard)}`
    }
  }
  return undefined
}

function relationsProblem(root: unknown): string | undefined {
  if (!isObject(root)) return `relations must be an object, got ${show(root)}`
  const { nodes, edges } = root
  const dup = repeated(nodes, 'nodes', []) ?? repeated(edges, 'edges', ['from', 'to', 'name'])
  if (dup) return dup
  const list = nodes as unknown[]
  if (!list.every(isName)) return `nodes must be non-empty strings, got ${show(nodes)}`
  const missing = dangling(edges, 'edge', ['from', 'to', 'name'], ['from', 'to'], list, 'nodes')
  if (missing) return missing
  for (const e of edges as Record<string, unknown>[]) {
    const key = show([e.from, e.to, e.name])
    if (!isName(e.name)) return `edge ${key}: "name" must be a non-empty string`
    if (e.cardinality !== undefined && e.cardinality !== 'one' && e.cardinality !== 'many') {
      return `edge ${key}: "cardinality" must be "one" or "many", got ${show(e.cardinality)}`
    }
  }
  return undefined
}

function sequenceProblem(root: unknown): string | undefined {
  if (!isObject(root)) return `a sequence must be an object, got ${show(root)}`
  const { participants, steps } = root
  const dup = repeated(participants, 'participants', []) ?? repeated(steps, 'steps', ['action'])
  if (dup) return dup
  const list = participants as unknown[]
  if (!list.every(isName)) return `participants must be non-empty strings, got ${show(participants)}`
  const missing = dangling(steps, 'step', ['action'], ['from', 'to'], list, 'participants')
  if (missing) return missing
  for (const s of steps as Record<string, unknown>[]) {
    if (!isName(s.action)) return `step ${show(s.action)}: "action" must be a non-empty string`
  }
  return undefined
}

registerBuilderCheck('stateMachine', stateMachineProblem, { kind: 'value' })
registerBuilderCheck('relations', relationsProblem, { kind: 'value' })
registerBuilderCheck('sequence', sequenceProblem, { kind: 'value' })

// --- builders ----------------------------------------------------------------------------------------------
function made<T extends object>(name: string, value: T, problem: (root: unknown) => string | undefined): T {
  setMark(value, BUILDER, name)
  const broken = problem(value)
  if (broken !== undefined) throw new BuilderError(`${name}: ${broken}`)
  return value
}

const listOf = (what: string, value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new BuilderError(`${what} must be a list, got ${show(value)}`)
  return value
}

/**
 * A state machine as a value: `{ initial, states, transitions }`. The states are `keyed` by name and the
 * transitions by `from` and `to`, so a `history` row can `add`, `remove` and `replace` them by key. Several
 * events between the same two states are one transition whose `event` is a list. Throws `BuilderError` when
 * `initial` or the end of a transition is not a state.
 */
export function stateMachine<const S extends string>(def: {
  initial: NoInfer<S>
  states: readonly S[]
  transitions: readonly Transition<NoInfer<S>>[]
}): StateMachine<S> {
  if (!isObject(def)) throw new BuilderError('stateMachine: expected { initial, states, transitions }')
  const value = {
    initial: def.initial,
    states: keyed(listOf('stateMachine: states', def.states)),
    transitions: keyed(listOf('stateMachine: transitions', def.transitions), ['from', 'to']),
  }
  return made('stateMachine', value, stateMachineProblem) as unknown as StateMachine<S>
}

/**
 * A set of nodes and named relations between them as a value: `{ nodes, edges }`. The nodes are `keyed` by
 * name and the edges by `from`, `to` and `name`. Throws `BuilderError` when an end of an edge is not a node.
 */
export function relations<const N extends string>(def: {
  nodes: readonly N[]
  edges: readonly Relation<NoInfer<N>>[]
}): Relations<N> {
  if (!isObject(def)) throw new BuilderError('relations: expected { nodes, edges }')
  const value = {
    nodes: keyed(listOf('relations: nodes', def.nodes)),
    edges: keyed(listOf('relations: edges', def.edges), ['from', 'to', 'name']),
  }
  return made('relations', value, relationsProblem) as unknown as Relations<N>
}

/**
 * A sequence of messages between participants as a value: `{ participants, steps }`. The participants are
 * `keyed` by name and the steps by `action`, which no two steps share. A `history` row can `add` steps only at
 * the end, so insert in the middle by replacing the whole `steps`. Throws `BuilderError` when an end of a step
 * is not a participant.
 */
export function sequence<const P extends string>(def: {
  participants: readonly P[]
  steps: readonly SequenceStep<NoInfer<P>>[]
}): Sequence<P> {
  if (!isObject(def)) throw new BuilderError('sequence: expected { participants, steps }')
  const value = {
    participants: keyed(listOf('sequence: participants', def.participants)),
    steps: keyed(listOf('sequence: steps', def.steps), ['action']),
  }
  return made('sequence', value, sequenceProblem) as unknown as Sequence<P>
}

// --- mermaid -----------------------------------------------------------------------------------------------
type Renderable<V> = V | Pick<Fact, 'id' | 'content'>

/** The value inside a fact that holds one, or the argument itself. */
function valueOf(source: unknown, fn: string): unknown {
  if (isObject(source) && 'content' in source) {
    const content = source.content
    if (isObject(content) && Object.hasOwn(content, 'value')) return content.value
    throw new BuilderError(
      `${fn}: ${show(source.id)} has no value to draw. Pass a fact with one value, or the value itself`,
    )
  }
  return source
}

/** Text for a label: mermaid reads `#` followed by a number or name and `;` as markup, so they become entities. */
function label(text: string): string {
  // A `ref` that was not built yet is drawn as the fact it points at.
  const named = text.replace(REF_TOKEN, (token) => {
    const t = refTarget(token)
    const id = (t?.fact as { id?: unknown } | undefined)?.id
    return t && typeof id === 'string' ? `${id}${t.field !== undefined ? `#${t.field}` : ''}` : token
  })
  return named.replace(/[#";|]/g, (c) => (c === '"' ? '#quot;' : `#${c.charCodeAt(0)};`)).replace(/\s*\n\s*/g, ' ')
}

function ready(name: string, source: unknown, problem: (root: unknown) => string | undefined): any {
  const value = valueOf(source, `${name}ToMermaid`)
  const broken = problem(value)
  if (broken !== undefined) throw new BuilderError(`${name}ToMermaid: ${broken}`)
  return value
}

/** A `stateDiagram-v2` of a state machine, without a code fence. States get ids `s0`, `s1`, ... and keep their name as label. */
export function stateMachineToMermaid(source: Renderable<StateMachine>): string {
  const machine = ready('stateMachine', source, stateMachineProblem) as StateMachine
  const id = (state: string) => `s${machine.states.indexOf(state)}`
  const lines = ['stateDiagram-v2']
  for (const [i, state] of machine.states.entries()) lines.push(`    state "${label(state)}" as s${i}`)
  lines.push(`    [*] --> ${id(machine.initial)}`)
  for (const t of machine.transitions) {
    const events = t.event === undefined ? [] : Array.isArray(t.event) ? t.event : [t.event]
    const parts = [events.map(label).join(', '), t.guard === undefined ? '' : `[${label(t.guard)}]`].filter(
      (part) => part !== '',
    )
    lines.push(`    ${id(t.from)} --> ${id(t.to)}${parts.length > 0 ? `: ${parts.join(' ')}` : ''}`)
  }
  return lines.join('\n')
}

/** A `flowchart LR` of nodes and relations, without a code fence. Nodes get ids `n0`, `n1`, ... and keep their name as label. */
export function relationsToMermaid(source: Renderable<Relations>): string {
  const graph = ready('relations', source, relationsProblem) as Relations
  const id = (node: string) => `n${graph.nodes.indexOf(node)}`
  const lines = ['flowchart LR']
  for (const [i, node] of graph.nodes.entries()) lines.push(`    n${i}["${label(node)}"]`)
  for (const e of graph.edges) lines.push(`    ${id(e.from)} -->|${label(e.name)}| ${id(e.to)}`)
  return lines.join('\n')
}

/**
 * A `sequenceDiagram`, without a code fence. Participants get ids `p0`, `p1`, ... and keep their name as label.
 * A use case is drawn too: the participants are `caller` and then each `layer` in the order of first use, and
 * each step is a message from the layer of the step before it (the caller for the first) to its own layer.
 */
export function sequenceToMermaid(source: Renderable<Sequence | UseCase>): string {
  const value = valueOf(source, 'sequenceToMermaid')
  // A sequence has participants. A use case has none, only steps that name a layer.
  if (isObject(value) && !('participants' in value) && Array.isArray(value.steps)) {
    const broken = useCaseProblem(value)
    if (broken !== undefined) throw new BuilderError(`sequenceToMermaid: ${broken}`)
    const steps = (value as unknown as UseCase).steps
    const who = ['caller', ...new Set(steps.map((s) => s.layer as string))]
    const lines = ['sequenceDiagram']
    for (const [i, name] of who.entries()) lines.push(`    participant p${i} as ${label(name)}`)
    let from = 'caller'
    for (const s of steps) {
      lines.push(`    p${who.indexOf(from)}->>p${who.indexOf(s.layer)}: ${label(s.action)}`)
      from = s.layer
    }
    return lines.join('\n')
  }
  const flow = ready('sequence', value, sequenceProblem) as Sequence
  const id = (participant: string) => `p${flow.participants.indexOf(participant)}`
  const lines = ['sequenceDiagram']
  for (const [i, who] of flow.participants.entries()) lines.push(`    participant p${i} as ${label(who)}`)
  for (const s of flow.steps) lines.push(`    ${id(s.from)}->>${id(s.to)}: ${label(s.action)}`)
  return lines.join('\n')
}
