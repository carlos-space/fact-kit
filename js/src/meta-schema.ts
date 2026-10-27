/**
 * JSON Schema 2020-12 meta-schemas for facts. `schemaDialect` extends the 2020-12 meta-schema through
 * `$dynamicAnchor`, so every subschema at any depth gets the same restriction on `x-` keywords.
 */

/** The only `x-` keywords a schema may use, with the shape of each value. */
export const X_KEYWORDS = {
  'x-since': { type: 'string' },
  'x-deprecatedIn': { type: 'string' },
  'x-removeIn': { type: 'string' },
  'x-replacement': { type: 'string' },
  'x-platforms': { type: 'array', items: { type: 'string' } },
  'x-diagnostic': { type: 'string' },
  'x-defaultRule': { type: 'string' },
  /** The field that identifies an entity, or two or more fields that do together. `check` tests they are in `properties`. */
  'x-identity': {
    oneOf: [
      { type: 'string', minLength: 1 },
      { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2, uniqueItems: true },
    ],
  },
} as const

export const SCHEMA_DIALECT_ID = 'urn:fact-kit:schema'
export const FACT_SCHEMA_ID = 'urn:fact-kit:fact'
export const INDEX_SCHEMA_ID = 'urn:fact-kit:index'
export const EXAMPLE_GROUP_SCHEMA_ID = 'urn:fact-kit:example-group'

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

/** Meta-schema for a JSON Schema document inside a fact (`content.schema`, `schemas/*.schema.json`). */
export const schemaDialect = {
  $schema: DRAFT,
  $id: SCHEMA_DIALECT_ID,
  $dynamicAnchor: 'meta',
  title: 'JSON Schema 2020-12 with registered x- keywords',
  allOf: [{ $ref: DRAFT }],
  type: ['object', 'boolean'],
  properties: X_KEYWORDS,
  propertyNames: {
    if: { pattern: '^x-' },
    then: { enum: Object.keys(X_KEYWORDS) },
  },
}

const text = {
  oneOf: [
    { type: 'string', minLength: 1 },
    {
      type: 'object',
      properties: { en: { type: 'string', minLength: 1 }, 'zh-TW': { type: 'string', minLength: 1 } },
      additionalProperties: false,
      minProperties: 1,
    },
  ],
}

const nonEmptyString = { type: 'string', minLength: 1 }
const stringList = { type: 'array', items: nonEmptyString }
const osList = { type: 'array', items: { enum: ['macos', 'linux', 'windows'] } }
/** A version, `'next'`, or one version per release line. Whether each is a valid version is checked by `check`. */
const since = { oneOf: [nonEmptyString, { type: 'array', minItems: 1, items: nonEmptyString }] }
const factId = '[a-z0-9][a-z0-9-]*\\.[a-z0-9][a-z0-9._-]*'
/** `<id>` in the same entry, or `<spec>:<id>` in another package or entry. */
const factLocation = { type: 'string', pattern: `^(?:[^:\\s]+:)?${factId}$` }

const factContent = {
  type: 'object',
  properties: { value: true, schema: { $ref: SCHEMA_DIALECT_ID }, statement: text },
  additionalProperties: false,
  oneOf: [{ required: ['value'] }, { required: ['schema'] }, { required: ['statement'] }],
}

/** Meta-schema for one fact. */
export const factSchema = {
  $schema: DRAFT,
  $id: FACT_SCHEMA_ID,
  title: 'Fact',
  type: 'object',
  required: ['id', 'tool', 'topics', 'title', 'content', 'source'],
  // Fields this version does not know are allowed, so a later 1.x minor can add some and readers skip them.
  properties: {
    id: { type: 'string', pattern: `^${factId}$` },
    tool: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    topics: stringList,
    title: text,
    description: text,
    content: factContent,
    variants: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['since', 'content'],
        additionalProperties: false,
        properties: {
          since,
          content: factContent,
          pending: nonEmptyString,
          stability: { enum: ['experimental'] },
          platforms: stringList,
          os: osList,
        },
      },
    },
    derivedFrom: { type: 'array', items: factLocation },
    when: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platforms: stringList,
        os: osList,
        since,
        deprecatedIn: nonEmptyString,
        removeIn: nonEmptyString,
        replacement: { oneOf: [nonEmptyString, { type: 'array', minItems: 1, items: nonEmptyString }] },
        movedTo: factLocation,
      },
    },
    source: {
      type: 'object',
      required: ['kind'],
      properties: { kind: { enum: ['published', 'converted', 'observed', 'derived'] } },
      allOf: [
        {
          if: { properties: { kind: { const: 'published' } } },
          then: { additionalProperties: false, properties: { kind: true } },
        },
        {
          if: { properties: { kind: { const: 'converted' } } },
          then: {
            required: ['from', 'converter', 'upstream'],
            additionalProperties: false,
            properties: { kind: true, from: nonEmptyString, converter: nonEmptyString, upstream: nonEmptyString },
          },
        },
        {
          if: { properties: { kind: { const: 'derived' } } },
          then: {
            required: ['from', 'version'],
            additionalProperties: false,
            properties: { kind: true, from: nonEmptyString, version: nonEmptyString },
          },
        },
        {
          if: { properties: { kind: { const: 'observed' } } },
          then: {
            required: ['basis'],
            additionalProperties: false,
            properties: {
              kind: true,
              basis: { enum: ['doc', 'measured', 'spike'] },
              url: nonEmptyString,
              fetched: nonEmptyString,
              note: text,
            },
          },
        },
      ],
    },
    verify: {
      type: 'object',
      required: ['probe', 'verifiedOn'],
      additionalProperties: false,
      properties: {
        verifiedOn: nonEmptyString,
        screenedThrough: nonEmptyString,
        probe: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { enum: ['hash', 'sample', 'manual'] } },
          allOf: [
            {
              if: { properties: { kind: { const: 'hash' } } },
              then: {
                required: ['anchor', 'hash'],
                additionalProperties: false,
                properties: { kind: true, anchor: nonEmptyString, hash: nonEmptyString, url: nonEmptyString },
              },
            },
            {
              if: { properties: { kind: { const: 'sample' } } },
              then: {
                required: ['path'],
                additionalProperties: false,
                properties: { kind: true, path: nonEmptyString },
              },
            },
            {
              if: { properties: { kind: { const: 'manual' } } },
              then: {
                required: ['reason'],
                additionalProperties: false,
                properties: { kind: true, reason: nonEmptyString },
              },
            },
          ],
        },
      },
    },
  },
  // `verify` belongs to observed facts only.
  if: { required: ['verify'] },
  then: { properties: { source: { properties: { kind: { const: 'observed' } } } } },
}

/** Meta-schema for a built `index.json`. */
export const indexSchema = {
  $schema: DRAFT,
  $id: INDEX_SCHEMA_ID,
  title: 'Fact index',
  type: 'object',
  required: ['package', 'entry', 'describes', 'facts'],
  // Fields this version does not know are allowed, see the fact schema.
  properties: {
    indexFormat: { type: 'string', pattern: '^[0-9]+\\.[0-9]+$' },
    package: nonEmptyString,
    entry: nonEmptyString,
    component: nonEmptyString,
    formatVersion: nonEmptyString,
    describes: { type: 'object', additionalProperties: nonEmptyString },
    facts: { type: 'array', items: { $ref: FACT_SCHEMA_ID } },
  },
}

const codeSample = {
  type: 'object',
  required: ['caption', 'lang', 'source'],
  additionalProperties: false,
  properties: { caption: nonEmptyString, lang: nonEmptyString, source: { type: 'string' } },
}

/** Meta-schema for one example group (reference-manual style, see `ExampleGroup`). */
export const exampleGroupSchema = {
  $schema: DRAFT,
  $id: EXAMPLE_GROUP_SCHEMA_ID,
  title: 'Example group',
  type: 'object',
  required: ['id', 'name', 'situation', 'claim', 'scenarios'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    name: nonEmptyString,
    situation: nonEmptyString,
    claim: nonEmptyString,
    facts: stringList,
    scenarios: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title', 'situation', 'code', 'outcome', 'points', 'facts'],
        additionalProperties: false,
        properties: {
          title: nonEmptyString,
          situation: nonEmptyString,
          code: { type: 'array', items: codeSample },
          outcome: {
            type: 'array',
            items: {
              oneOf: [
                nonEmptyString,
                {
                  type: 'object',
                  required: ['fact'],
                  additionalProperties: false,
                  properties: { fact: nonEmptyString, field: nonEmptyString, text },
                },
              ],
            },
          },
          points: stringList,
          facts: { type: 'array', minItems: 1, items: nonEmptyString },
        },
      },
    },
  },
}
