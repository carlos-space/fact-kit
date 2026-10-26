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

export interface ExampleScenario {
  title: string
  /** What the reader is trying to do, one sentence. */
  situation: string
  code: readonly ExampleCode[]
  /** What appears on disk or in the terminal after running the code. */
  outcome: readonly string[]
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

/** Every fact id an example group references, with where it is referenced. */
export function exampleFactRefs(group: ExampleGroup): { id: string; location: string }[] {
  const refs: { id: string; location: string }[] = []
  group.facts?.forEach((id, i) => refs.push({ id, location: `/facts/${i}` }))
  group.scenarios.forEach((s, si) =>
    s.facts.forEach((id, i) => refs.push({ id, location: `/scenarios/${si}/facts/${i}` })),
  )
  return refs
}

/** Identity helper that gives an example file its type. */
export const defineExamples = <T extends ExampleGroup | readonly ExampleGroup[]>(examples: T): T => examples
