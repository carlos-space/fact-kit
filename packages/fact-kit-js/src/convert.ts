import { readFile } from 'node:fs/promises'
import { loadPeer } from './peer.ts'
import type { JsonSchema } from './types.ts'

/** The `$schema` URL of JSON Schema 2020-12. */
export const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

type SyncApi = typeof import('typescript/sync')
type AstApi = typeof import('typescript/ast')
type TsType = import('typescript/sync').Type
type TupleTypeReference = import('typescript/sync').TupleTypeReference
type TsSymbol = import('typescript/sync').Symbol
// Syntax nodes of the TypeScript 7 API are many classes that share a shape, and the converter reads them by `kind`.
type AstNode = any // eslint-disable-line @typescript-eslint/no-explicit-any

async function loadTypeScript(usedBy: string): Promise<{ sync: SyncApi; ast: AstApi }> {
  const [sync, ast] = await Promise.all([
    loadPeer<SyncApi>('typescript/sync', 'typescript', usedBy),
    loadPeer<AstApi>('typescript/ast', 'typescript', usedBy),
  ])
  return { sync, ast }
}

/**
 * String literal tuples declared in TypeScript source, by name. Reads
 * `export declare const X: readonly ['a', 'b']` (a `.d.ts`) and `export const X = ['a', 'b'] as const`.
 * Only the syntax is parsed, so imports do not have to resolve. Constants of any other shape are skipped.
 * Needs the optional peer dependency `typescript` 7.1.0-beta or later.
 */
export async function readStringTuples(source: string): Promise<Record<string, string[]>> {
  const {
    sync: { API },
    ast: { SyntaxKind },
  } = await loadTypeScript('readStringTuples')
  const api = new API({ cwd: process.cwd() })
  try {
    const lease = api.createSourceFile('input.d.ts', source)
    try {
      const out: Record<string, string[]> = {}

      const literals = (node: AstNode): string[] | undefined => {
        let elements: readonly AstNode[] | undefined
        if (node.kind === SyntaxKind.TypeOperator && node.operator === SyntaxKind.ReadonlyKeyword)
          return literals(node.type)
        if (node.kind === SyntaxKind.TupleType) elements = node.elements
        else if (node.kind === SyntaxKind.AsExpression) return literals(node.expression)
        else if (node.kind === SyntaxKind.ArrayLiteralExpression) elements = node.elements
        if (!elements) return undefined
        const values: string[] = []
        for (const el of elements) {
          if (el.kind === SyntaxKind.LiteralType && el.literal.kind === SyntaxKind.StringLiteral)
            values.push(el.literal.text)
          else if (el.kind === SyntaxKind.StringLiteral) values.push(el.text)
          else return undefined
        }
        return values
      }

      for (const statement of lease.sourceFile.statements as readonly AstNode[]) {
        if (statement.kind !== SyntaxKind.VariableStatement) continue
        if (!statement.modifiers?.some((m: AstNode) => m.kind === SyntaxKind.ExportKeyword)) continue
        for (const decl of statement.declarationList.declarations as readonly AstNode[]) {
          if (decl.name.kind !== SyntaxKind.Identifier) continue
          const node = decl.type ?? decl.initializer
          const values = node ? literals(node) : undefined
          if (values) out[decl.name.text as string] = values
        }
      }
      return out
    } finally {
      lease.dispose()
    }
  } finally {
    api.close()
  }
}

/** Reads a `.d.ts` (or `.ts`) file and returns {@link readStringTuples} of it. */
export async function readStringTuplesFromFile(path: string): Promise<Record<string, string[]>> {
  return readStringTuples(await readFile(path, 'utf8'))
}

export interface InterfaceToSchemaOptions {
  /** Path of the `.d.ts` or `.ts` file declaring the type. */
  path: string
  /** Name of the interface or type alias to convert. */
  type: string
  /** tsconfig for resolving imports. Without it the file is read with default options. */
  tsconfig?: string
  /** Whether objects accept unlisted properties. Defaults to false. */
  additionalProperties?: boolean
  /** Whether JSDoc comments are kept as `description`. Defaults to true. False leaves names, types and enum values only. */
  descriptions?: boolean
}

// Keywords whose value is a map of name -> subschema. The names in it are not keywords, so a property named `description` stays.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas'])
// Keywords whose value is data, not a schema.
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples'])

/** Removes every `description` keyword at any depth, including inside `$defs`, and turns a `deprecated` message into `true`. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description' && typeof v === 'string') continue
    if (key === 'deprecated' && typeof v === 'string')
      out[key] = true // the JSDoc message is prose too
    else if (DATA_KEYWORDS.has(key)) out[key] = v
    else if (SCHEMA_MAPS.has(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, stripDescriptions(sub)]),
      )
    } else out[key] = stripDescriptions(v)
  }
  return out
}

type Schema = Record<string, unknown>
interface Member {
  type: TsType
  node: AstNode | undefined
}

const literalValue = (t: TsType): unknown => (t as unknown as { value: unknown }).value

const NUMERIC_TAGS = new Set(['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength'])
const TEXT_TAGS = new Set(['pattern', 'format'])

/**
 * Converts an interface or type alias to a JSON Schema 2020-12 document with the TypeScript 7.1 type checker
 * (`typescript/sync`, which starts the native compiler process and closes it before returning).
 *
 * - JSDoc comments become `description`, unless `descriptions` is false, which removes every `description` and
 *   leaves names, types and enum values.
 * - The members of a union and the values of an enum come out in the order of the source text, and `0 | number`
 *   keeps both members.
 * - A tuple becomes `prefixItems`, with `items` for a rest element.
 * - Type errors in the input are not reported, because a `.d.ts` of a package often imports files that are not
 *   installed.
 *
 * Needs the optional peer dependency `typescript` 7.1.0-beta or later.
 */
export async function interfaceToJsonSchema(options: InterfaceToSchemaOptions): Promise<JsonSchema> {
  const { sync, ast } = await loadTypeScript('interfaceToJsonSchema')
  const { API, ElementFlags, ModuleKind, ModuleResolutionKind, TypeFlags, SymbolFlags, ObjectFlags } = sync
  const { SyntaxKind } = ast
  const withDescriptions = options.descriptions !== false
  const closedObjects = options.additionalProperties !== true

  const api = new API({ cwd: process.cwd() })
  try {
    // Options are numeric enum values only: the native process panics on a string such as "esnext".
    const fromTsconfig: Schema = options.tsconfig
      ? { ...(api.parseConfigFile(options.tsconfig).options as Schema) }
      : {}
    const program = api.createProgram([options.path], {
      ...fromTsconfig,
      skipLibCheck: true,
      strict: true,
      types: [],
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
    })
    const checker = program.getProject().checker
    const moduleSymbol = checker.getSymbolOfSourceFile(options.path)
    const rootSymbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === options.type)
    if (!rootSymbol) throw new Error(`${options.type} is not exported by ${options.path}`)
    const rootType = checker.getDeclaredTypeOfSymbol(rootSymbol)

    const $defs: Record<string, Schema> = {}
    const inProgress = new Set<number>()
    const defNameOfType = new Map<number, string>()
    const usedNames = new Set<string>()

    // A node that still mentions a type parameter cannot be used in place of the instantiated type.
    const GENERIC = TypeFlags.TypeParameter | TypeFlags.IndexedAccess | TypeFlags.Conditional

    const doc = (symbol: TsSymbol): Schema => {
      // A single line break inside a paragraph is a space; blank lines and the start of a list item stay.
      const text = withDescriptions
        ? symbol
            .getDocumentationComment(checker)
            .replace(/\r/g, '')
            .trim()
            .replace(/(?<=[^\n])\n(?=[^\n*-])/g, ' ')
            .trim()
        : ''
      const out: Schema = text ? { description: text } : {}
      for (const tag of symbol.getJsDocTags(checker)) {
        const value = tag.text
        if (NUMERIC_TAGS.has(tag.name) && value !== undefined) out[tag.name] = Number(value)
        else if (TEXT_TAGS.has(tag.name) && value !== undefined) out[tag.name] = value
        else if (tag.name === 'deprecated') out.deprecated = true
        else if (tag.name === 'default' && value !== undefined) {
          try {
            out.default = JSON.parse(value)
          } catch {
            out.default = value
          }
        }
      }
      return out
    }

    /** The alias or the interface a type is declared with. Only these become `$defs`. */
    const namedSymbol = (t: TsType): TsSymbol | undefined => {
      const alias = t.getAliasSymbol()
      if (alias) return alias
      if (t.isClassOrInterface() || (t.isObjectType() && (t.objectFlags & ObjectFlags.Interface) !== 0))
        return t.getSymbol()
      return undefined
    }

    const declarationOf = (symbol: TsSymbol): AstNode =>
      symbol.valueDeclaration?.resolve() ?? symbol.declarations[0]?.resolve()

    /** The type node an alias is declared with, when the alias has no type parameters. */
    const aliasBody = (t: TsType): AstNode | undefined => {
      const alias = t.getAliasSymbol()
      if (!alias || t.getAliasTypeArguments().length) return undefined
      return (alias.declarations[0]?.resolve() as AstNode)?.type
    }

    /** Strips parentheses and `readonly`. */
    const plain = (node: AstNode | undefined): AstNode | undefined => {
      let n = node
      while (
        n &&
        (n.kind === SyntaxKind.ParenthesizedType ||
          (n.kind === SyntaxKind.TypeOperator && n.operator === SyntaxKind.ReadonlyKeyword))
      )
        n = n.type
      return n
    }

    const typeReferenceName = (node: AstNode): string | undefined =>
      node.kind === SyntaxKind.TypeReference && node.typeName?.kind === SyntaxKind.Identifier
        ? (node.typeName.text as string)
        : undefined

    /** The type node of the elements of an array type node. */
    const elementNode = (node: AstNode | undefined): AstNode | undefined => {
      const n = plain(node)
      if (!n) return undefined
      if (n.kind === SyntaxKind.ArrayType) return n.elementType
      const name = typeReferenceName(n)
      if ((name === 'Array' || name === 'ReadonlyArray') && n.typeArguments?.length === 1) return n.typeArguments[0]
      return undefined
    }

    /** The type nodes of the elements of a tuple type node, one per element. A rest element's node is the array. */
    const tupleNodes = (node: AstNode | undefined): readonly AstNode[] | undefined => {
      const n = plain(node)
      if (n?.kind !== SyntaxKind.TupleType) return undefined
      return (n.elements as readonly AstNode[]).map((element) => {
        let e = element
        if (e.kind === SyntaxKind.NamedTupleMember) e = e.type
        if (e.kind === SyntaxKind.OptionalType || e.kind === SyntaxKind.RestType) e = e.type
        return e
      })
    }

    /** The type node of the value of an index signature or a `Record<K, V>`. */
    const indexValueNode = (node: AstNode | undefined, declaration: AstNode | undefined): AstNode | undefined => {
      const n = plain(node)
      if (n && typeReferenceName(n) === 'Record' && n.typeArguments?.length === 2) return n.typeArguments[1]
      return declaration?.type
    }

    /**
     * The members of a union as written in the source, each with its type node, or undefined when `node` is not a
     * union. A member that is an alias of a union is flattened in place, so the order stays the written one.
     */
    const writtenMembers = (node: AstNode | undefined): Member[] | undefined => {
      const n = plain(node)
      if (n?.kind !== SyntaxKind.UnionType) return undefined
      const out: Member[] = []
      const add = (type: TsType, memberNode: AstNode | undefined) => {
        if (!out.some((m) => m.type.id === type.id)) out.push({ type, node: memberNode })
      }
      const visit = (union: AstNode) => {
        for (const member of union.types as readonly AstNode[]) {
          const m = plain(member)
          if (m.kind === SyntaxKind.UnionType) {
            visit(m)
            continue
          }
          const type = checker.getTypeFromTypeNode(m)
          const inner = plain(aliasBody(type))
          if (inner?.kind === SyntaxKind.UnionType) visit(inner)
          else if (type.isUnionType())
            for (const part of type.getTypes()) add(part, undefined) // boolean, and unions the checker built
          else add(type, m)
        }
      }
      visit(n)
      return out.some((m) => m.type.flags & GENERIC) ? undefined : out
    }

    function viaRef(t: TsType, build: () => Schema): Schema {
      const symbol = namedSymbol(t)
      // generic instantiations such as Record<string, unknown> are written out in place
      if (!symbol || t.id === rootType.id || t.getAliasTypeArguments().length) return build()
      let name = defNameOfType.get(t.id)
      if (!name) {
        name = symbol.name
        for (let i = 2; usedNames.has(name); i++) name = `${symbol.name}${i}`
        usedNames.add(name)
        defNameOfType.set(t.id, name)
        if (!inProgress.has(t.id)) {
          inProgress.add(t.id)
          $defs[name] = build()
          inProgress.delete(t.id)
        }
      }
      return { $ref: `#/$defs/${name}` }
    }

    /**
     * `node` is the type node the type was written with, when there is one: a property type, an element of an
     * array or tuple, an index signature value or an alias body. It keeps the order of union members and the
     * alias name that the checker drops when it adds `| undefined` to an optional property.
     */
    function convert(t: TsType, node?: AstNode): Schema {
      return viaRef(t, () => {
        const symbol = namedSymbol(t)
        const named = symbol && !t.getAliasTypeArguments().length ? doc(symbol) : {}
        return { ...body(t, aliasBody(t) ?? node), ...named }
      })
    }

    function body(t: TsType, node: AstNode | undefined): Schema {
      const f = t.flags
      const members = writtenMembers(node)
      if (members) return union(members)
      if (f & TypeFlags.StringLiteral) return { type: 'string', const: literalValue(t) }
      if (f & TypeFlags.NumberLiteral) return { type: 'number', const: literalValue(t) }
      if (f & TypeFlags.BooleanLiteral) return { type: 'boolean', const: literalValue(t) }
      if (f & TypeFlags.String) return { type: 'string' }
      if (f & TypeFlags.Number) return { type: 'number' }
      if (f & TypeFlags.Boolean) return { type: 'boolean' }
      if (f & TypeFlags.Null) return { type: 'null' }
      if (f & (TypeFlags.Any | TypeFlags.Unknown)) return {}
      if (f & TypeFlags.Never) return { not: {} }
      if (t.isUnionType()) return union(t.getTypes().map((type) => ({ type, node: undefined })))
      if (f & TypeFlags.Intersection) return object(t, node)
      if (f & TypeFlags.Object) {
        if (t.isTypeReference() && checker.isArrayType(t)) {
          return { type: 'array', items: convert(checker.getTypeArguments(t)[0]!, elementNode(node)) }
        }
        if (t.isTupleType()) return tuple(t, node)
        return object(t, node)
      }
      throw new Error(`unsupported type (flags ${f}): ${checker.typeToString(t)}`)
    }

    function tuple(t: TupleTypeReference, node: AstNode | undefined): Schema {
      const args = checker.getTypeArguments(t)
      const flags = t.getTarget().elementFlags
      const nodes = tupleNodes(node)
      const nodeAt = (i: number): AstNode | undefined => (nodes?.length === args.length ? nodes[i] : undefined)
      const rest = flags.findIndex((x) => x & (ElementFlags.Rest | ElementFlags.Variadic))
      const fixed = rest === -1 ? args.length : rest
      const required = flags.filter((x) => x & ElementFlags.Required).length
      const out: Schema = { type: 'array' }
      if (fixed > 0) out.prefixItems = args.slice(0, fixed).map((a, i) => convert(a, nodeAt(i)))
      if (required) out.minItems = required
      if (rest === -1) out.maxItems = args.length
      else {
        // checker gives the element type of `...T[]`; the node is the array `T[]`
        const restNode = nodeAt(rest)
        out.items = convert(args[rest]!, restNode ? elementNode(restNode) : undefined)
      }
      return out
    }

    function union(all: Member[]): Schema {
      let members = all.filter((m) => !(m.type.flags & (TypeFlags.Undefined | TypeFlags.Void)))
      // true | false, the two members of boolean, collapse back to boolean
      // (boolean takes the place of the first of the two)
      if (members.filter((m) => m.type.flags & TypeFlags.BooleanLiteral).length === 2) {
        let placed = false
        members = members.flatMap((m) => {
          if (!(m.type.flags & TypeFlags.BooleanLiteral)) return [m]
          if (placed) return []
          placed = true
          return [{ type: checker.getBooleanType(), node: undefined }]
        })
      }
      if (members.length === 1) return convert(members[0]!.type, members[0]!.node)
      // 'latest' | string is no more than string: a string literal next to string (and null) adds nothing
      const stringLike = TypeFlags.String | TypeFlags.StringLiteral | TypeFlags.Null
      if (members.every((m) => m.type.flags & stringLike) && members.some((m) => m.type.flags & TypeFlags.String)) {
        return { type: members.some((m) => m.type.flags & TypeFlags.Null) ? ['string', 'null'] : 'string' }
      }
      if (members.every((m) => m.type.flags & TypeFlags.StringLiteral)) {
        return { type: 'string', enum: members.map((m) => literalValue(m.type)) }
      }
      if (members.every((m) => m.type.flags & TypeFlags.NumberLiteral)) {
        return { type: 'number', enum: members.map((m) => literalValue(m.type)) }
      }
      // string | null becomes type: ['string', 'null']
      const primitive = TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.Null
      if (members.length === 2 && members.every((m) => m.type.flags & primitive)) {
        return { type: members.map((m) => body(m.type, undefined).type) }
      }
      return { anyOf: members.map((m) => convert(m.type, m.node)) }
    }

    function object(t: TsType, node: AstNode | undefined): Schema {
      const properties: Record<string, Schema> = {}
      const required: string[] = []
      for (const symbol of checker.getPropertiesOfType(t)) {
        const declaration = declarationOf(symbol)
        let typeNode: AstNode | undefined = declaration?.type
        // A property type written as a type node keeps its alias and the order of its union members. The checker
        // adds `undefined` for `?` on its own.
        let propertyType = typeNode ? checker.getTypeFromTypeNode(typeNode) : checker.getTypeOfSymbol(symbol)
        if (propertyType.flags & GENERIC) {
          propertyType = checker.getTypeOfSymbol(symbol)
          typeNode = undefined
        }
        properties[symbol.name] = { ...convert(propertyType, typeNode), ...doc(symbol) }
        if (!(symbol.flags & SymbolFlags.Optional)) required.push(symbol.name)
      }
      const out: Schema = { type: 'object' }
      if (Object.keys(properties).length) out.properties = properties
      if (required.length) out.required = t.flags & TypeFlags.Intersection ? [...required].sort() : required
      const index = checker.getIndexInfosOfType(t)[0]
      if (index) out.additionalProperties = convert(index.valueType, indexValueNode(node, index.declaration?.resolve()))
      else if (closedObjects) out.additionalProperties = false
      return out
    }

    const rootSchema: Schema = { ...body(rootType, aliasBody(rootType)), ...doc(namedSymbol(rootType) ?? rootSymbol) }
    const schema: Schema = {
      $schema: DRAFT_2020_12,
      ...rootSchema,
      ...(Object.keys($defs).length ? { $defs } : {}),
    }
    return (withDescriptions ? schema : stripDescriptions(schema)) as JsonSchema
  } finally {
    api.close()
  }
}

/** Reads a JSON Schema file. */
export async function readJsonSchemaFile(path: string): Promise<JsonSchema> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'boolean' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(`${path} is not a JSON Schema document`)
  }
  return parsed as JsonSchema
}
