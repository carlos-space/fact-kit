import type { BuiltStatement } from './markers.ts'
import type { Text } from './types.ts'

/**
 * Reference-manual style examples. One group has an id, a name, the situation it answers and the claim it
 * makes, plus several scenarios. Each scenario shows the situation, code, what comes out, the points to
 * take away, and the ids of the facts it demonstrates. Code is run by the tool's own tests, not here.
 */
export interface ExampleCode {
  /** File name or short label shown above the snippet. */
  caption: string
  lang: string
  source: string
}

/**
 * An outcome that names a fact instead of only saying something. `field` is a dotted path inside the fact, and
 * `text` is what to show in its place, such as a sentence rendered from the fact (`statementFrom`). A reader
 * that wants the live value follows `fact` (and `field`), and falls back to `text`.
 */
export interface OutcomeRef {
  /** Id of the fact, as in `facts`. Every id must exist. */
  fact: string
  field?: string
  text?: Text
}

export interface ExampleScenario {
  title: string
  /** What the reader is trying to do, one sentence. */
  situation: string
  code: readonly ExampleCode[]
  /** What appears on disk or in the terminal after running the code. A string, or a reference to a fact. */
  outcome: readonly (string | OutcomeRef)[]
  points: readonly string[]
  /** Ids of the facts this scenario demonstrates. Every id must exist. */
  facts: readonly string[]
}

export interface ExampleGroup {
  id: string
  name: string
  situation: string
  claim: string
  /** Facts the whole group demonstrates, on top of those of its scenarios. */
  facts?: readonly string[]
  scenarios: readonly ExampleScenario[]
}

/**
 * An outcome item as an example file may write it. `ref(fact)` and `ref(fact, 'a.b')` are strings that the build
 * turns into `{ fact, field? }`, and `statementFrom(fact, render)` into `{ fact, text }`.
 */
export type OutcomeSource = string | OutcomeRef | BuiltStatement
export type ExampleScenarioSource = Omit<ExampleScenario, 'outcome'> & { outcome: readonly OutcomeSource[] }
export type ExampleGroupSource = Omit<ExampleGroup, 'scenarios'> & { scenarios: readonly ExampleScenarioSource[] }

/** One place where an example group names a fact. */
export interface ExampleFactRef {
  id: string
  /** JSON pointer inside the group. */
  location: string
  /** `facts` for `facts` of the group or of a scenario, `outcome` for a reference inside an outcome. */
  in: 'facts' | 'outcome'
  /** The dotted field of an outcome reference, when it names one. */
  field?: string
}

/** Every fact id an example group references (in `facts` and in `outcome`), with where it is referenced. */
export function exampleFactRefs(group: ExampleGroup): ExampleFactRef[] {
  const refs: ExampleFactRef[] = []
  group.facts?.forEach((id, i) => refs.push({ id, location: `/facts/${i}`, in: 'facts' }))
  group.scenarios.forEach((s, si) => {
    s.facts.forEach((id, i) => refs.push({ id, location: `/scenarios/${si}/facts/${i}`, in: 'facts' }))
    s.outcome.forEach((item, oi) => {
      if (typeof item === 'string') return
      refs.push({
        id: item.fact,
        location: `/scenarios/${si}/outcome/${oi}/fact`,
        in: 'outcome',
        ...(item.field !== undefined ? { field: item.field } : {}),
      })
    })
  })
  return refs
}

/** Identity helper that gives an example file its type. */
export const defineExamples = <T extends ExampleGroupSource | readonly ExampleGroupSource[]>(examples: T): T => examples
