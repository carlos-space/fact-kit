export type {
  Fact,
  FactContent,
  FactIndex,
  FactProbe,
  FactSource,
  FactsModule,
  JsonSchema,
  Problem,
  Text,
} from './types.ts'
export { defineFacts } from './define.ts'
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
export { checkProject, readConfig } from './project.ts'
export type { CheckProjectOptions, ProjectConfig } from './project.ts'
export { buildFacts, buildIndex, expectedExports, exportsCover } from './build.ts'
export type { BuildOptions, BuildResult } from './build.ts'
export { loadEntries } from './load.ts'
export type { LoadedEntry } from './load.ts'
export { readFacts } from './read.ts'
export type { FactReader, ReadFactsOptions } from './read.ts'
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
