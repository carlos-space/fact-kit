export type {
  DerivedFact,
  Fact,
  FactDecl,
  FactLike,
  FactContent,
  FactIndex,
  FactProbe,
  FactSource,
  FactVariant,
  FactsModule,
  FactsSource,
  JsonSchema,
  Os,
  Problem,
  Since,
  Text,
} from './types.ts'
export { defineFacts } from './define.ts'
export { HistoryError, history, keyed } from './history.ts'
export type { HistoryRow, HistoryVariants } from './history.ts'
export {
  BuilderError,
  contentOf,
  factsOf,
  observedDoc,
  observedSpike,
  ref,
  statementFrom,
  subsetOf,
} from './builders.ts'
export type {
  BuiltStatement,
  FactRef,
  FactOptions,
  FactsFactory,
  FactsOfOptions,
  FieldPath,
  SchemaFact,
  StatementFact,
  ValueFact,
  VersionedFact,
} from './builders.ts'
export {
  relations,
  relationsToMermaid,
  sequence,
  sequenceToMermaid,
  stateMachine,
  stateMachineToMermaid,
} from './flows.ts'
export type { Relation, Relations, Sequence, SequenceStep, StateMachine, Transition } from './flows.ts'
export { aggregate, domainEvent, entity, invariant, useCase, valueObject } from './ddd.ts'
export type { Aggregate, AggregateMember, EntitySchema, ObjectSchema, UseCase, UseCaseStep } from './ddd.ts'
export { derive, factLink } from './author.ts'
export {
  EXAMPLE_GROUP_SCHEMA_ID,
  FACT_SCHEMA_ID,
  INDEX_SCHEMA_ID,
  SCHEMA_DIALECT_ID,
  X_KEYWORDS,
  exampleGroupSchema,
  factSchema,
  indexSchema,
  schemaDialect,
} from './meta-schema.ts'
export { validateExampleGroup, validateFact, validateIndex, validateSchemaDocument } from './validate.ts'
export type { ValidationIssue } from './validate.ts'
export { checkFacts, findLocalPaths, findUrlHosts, isAllowedHost } from './check.ts'
export type { CheckOptions, CheckResult, ExampleInput, IndexInput } from './check.ts'
export { checkProject, parseTrain, readConfig } from './project.ts'
export type { CheckProjectOptions, ProjectConfig } from './project.ts'
export { INDEX_FORMAT, buildFacts, buildIndex, expectedExports, exportsCover } from './build.ts'
export type { BuildOptions, BuildResult } from './build.ts'
export { aggregateExports, planAggregate, writeAggregate } from './aggregate.ts'
export type { AggregatePlan, PlacedIndex } from './aggregate.ts'
export { pinVersion } from './pin.ts'
export type { PinOptions, PinResult } from './pin.ts'
export { mergeSince } from './merge-since.ts'
export type { MergeSinceOptions, MergeSinceResult } from './merge-since.ts'
export { impactOf } from './impact.ts'
export type { Impact, ImpactOptions } from './impact.ts'
export { InputError, LoadError, loadEntries } from './load.ts'
export type { LoadedEntry } from './load.ts'
export { readFacts } from './read.ts'
export type { FactRead, FactReader, ReadFactsOptions } from './read.ts'
export { NO_SINCE, selectFacts } from './select.ts'
export type { SelectOptions, SelectedFact } from './select.ts'
export { FactReadError, compareVersions, releaseLine } from './version.ts'
export type { ReadErrorCode } from './version.ts'
export { diffFacts, diffIndexFiles, diffIndexes } from './diff.ts'
export type { IndexDiff } from './diff.ts'
export { interfaceToJsonSchema, readJsonSchemaFile, readStringTuples, readStringTuplesFromFile } from './convert.ts'
export type { InterfaceToSchemaOptions } from './convert.ts'
export { flattenSchema, schemaRowsToMarkdown } from './table.ts'
export type { SchemaRow } from './table.ts'
export { defineExamples, exampleFactRefs } from './examples.ts'
export type { ExampleCode, ExampleGroup, ExampleScenario } from './examples.ts'
export { replaceFactBlocks, valueListToMarkdown } from './render.ts'
export type { ReplaceBlocksResult, ValueListOptions } from './render.ts'
export { DRAFT_2020_12 } from './convert.ts'
export { stableJson, writeFormatted } from './format.ts'
export { normalizeSchema } from './normalize.ts'
export type { NormalizeOptions } from './normalize.ts'
export { readPinned, sourceUrl } from './pinned.ts'
export type { PinnedSource } from './pinned.ts'
