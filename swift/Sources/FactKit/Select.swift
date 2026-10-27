import Foundation
import SemanticVersion

/// What `since` reads as when a row does not have one.
let noSince = "0.0.0"

/// A fact as one reader sees it: the row that applies is flattened into `content`, `since` and `stability`.
public struct SelectedFact: Sendable, Equatable {
  public let id: String
  /// The content of the chosen row.
  public let content: JSONValue
  /// The `since` of the chosen row: a version string, `"next"` or an array. `"0.0.0"` when the row has none.
  public let since: JSONValue
  /// `"experimental"` when the chosen row says so.
  public let stability: String?
  /// Every other field of the fact (`tool`, `topics`, `title`, ...), without `variants`.
  public let fields: JSONObject

  public static func == (lhs: SelectedFact, rhs: SelectedFact) -> Bool {
    lhs.id == rhs.id && lhs.content == rhs.content && lhs.since == rhs.since && lhs.stability == rhs.stability
      && JSONValue.object(lhs.fields) == JSONValue.object(rhs.fields)
  }
}

private enum Reader {
  case head
  case latest
  case version(SemanticVersion)
}

/// The version a row starts at, seen from one reader: minus infinity, a version, or plus infinity (`next`).
private enum Bound {
  case min
  case max
  case version(SemanticVersion)

  var rank: Int {
    switch self {
    case .min: 0
    case .version: 1
    case .max: 2
    }
  }

  static func compare(_ a: Bound, _ b: Bound) -> Int {
    if a.rank != b.rank { return a.rank < b.rank ? -1 : 1 }
    if case .version(let x) = a, case .version(let y) = b { return compareSemver(x, y) }
    return 0
  }
}

private struct Row {
  var since: JSONValue?
  var content: JSONValue?
  var pending: JSONValue?
  var stability: JSONValue?
  var platforms: JSONValue?
  var os: JSONValue?

  /// The row as an object, for the canonical text that breaks ties.
  var asObject: JSONObject {
    var o = JSONObject()
    if let since { o["since"] = since }
    if let content { o["content"] = content }
    if let pending { o["pending"] = pending }
    if let stability { o["stability"] = stability }
    if let platforms { o["platforms"] = platforms }
    if let os { o["os"] = os }
    return o
  }

  var specificity: Int { (Row.truthy(platforms) ? 1 : 0) + (Row.truthy(os) ? 1 : 0) }

  /// JavaScript truthiness of a value that may be absent.
  static func truthy(_ v: JSONValue?) -> Bool {
    switch v {
    case nil, .null?: false
    case .bool(let b)?: b
    case .number(let n)?: n != 0 && !n.isNaN
    case .string(let s)?: !s.isEmpty
    default: true
    }
  }
}

private func rowsOf(_ fact: JSONObject) -> [Row] {
  if case .array(let variants)? = fact["variants"] {
    return variants.compactMap { v in
      switch v {
      case .object(let o):
        return Row(since: o["since"], content: o["content"], pending: o["pending"], stability: o["stability"], platforms: o["platforms"], os: o["os"])
      case .array:
        return Row()  // JavaScript lets an array through as a row without fields
      default:
        return nil
      }
    }
  }
  var when = JSONObject()
  if case .object(let w)? = fact["when"] { when = w }
  return [Row(since: when["since"], content: fact["content"], platforms: when["platforms"], os: when["os"])]
}

private func boundOf(_ since: JSONValue?, _ reader: Reader, _ id: String) throws -> Bound? {
  guard let since else { return .min }
  let what = "fact \(id): since"
  if case .string("next") = since {
    if case .head = reader { return .max }
    return nil
  }
  if case .string = since {
    let s = try mustParse(since, what)
    if case .version(let r) = reader { return compareSemver(r, s) >= 0 ? .version(s) : nil }
    return .version(s)
  }
  guard case .array(let items) = since else {
    throw FactReadError.invalidVersion("\(what) must be a string or an array")
  }
  let hasNext = items.contains { if case .string("next") = $0 { true } else { false } }
  var versions: [SemanticVersion] = []
  for item in items {
    if case .string("next") = item { continue }
    versions.append(try mustParse(item, what))
  }
  if versions.isEmpty {
    if case .head = reader { return .max }
    return nil
  }
  let newest = versions.dropFirst().reduce(versions[0]) { compareSemver($0, $1) >= 0 ? $0 : $1 }
  switch reader {
  case .version(let r):
    if let same = versions.first(where: { compareLines($0, r) == 0 }) {
      return compareSemver(r, same) >= 0 ? .version(same) : nil
    }
    // No version on the reader's line: the row applies once the reader's line is newer than all of them.
    return versions.allSatisfy({ compareLines(r, $0) > 0 }) ? .version(newest) : nil
  case .head:
    return hasNext ? .max : .version(newest)
  case .latest:
    return .version(newest)
  }
}

private struct Context {
  var include: [String]
  var platform: String?
  var os: String?
}

private func listIncludes(_ list: JSONValue?, _ value: String) -> Bool {
  switch list {
  case .array(let items)?: items.contains { if case .string(let s) = $0 { s == value } else { false } }
  case .string(let s)?: s.contains(value)  // JavaScript's `includes` on a string looks for a substring
  default: false
  }
}

private struct Candidate {
  var row: Row
  var bound: Bound
}

private func candidates(_ rows: [Row], _ reader: Reader, _ ctx: Context, _ id: String) throws -> [Candidate] {
  var out: [Candidate] = []
  for row in rows {
    if let pending = row.pending {
      guard case .head = reader, case .string(let label) = pending, ctx.include.contains(label) else { continue }
    }
    if Row.truthy(row.platforms) {
      guard let platform = ctx.platform, listIncludes(row.platforms, platform) else { continue }
    }
    if Row.truthy(row.os) {
      guard let os = ctx.os, listIncludes(row.os, os) else { continue }
    }
    if let bound = try boundOf(row.since, reader, id) { out.append(Candidate(row: row, bound: bound)) }
  }
  return out
}

/// Larger bound first, then more conditions.
private func rank(_ a: Candidate, _ b: Candidate) -> Int {
  let byBound = Bound.compare(a.bound, b.bound)
  if byBound != 0 { return byBound }
  let (x, y) = (a.row.specificity, b.row.specificity)
  return x == y ? 0 : (x < y ? -1 : 1)
}

private func chooseRow(_ rows: [Row], _ reader: Reader, _ ctx: Context, _ id: String) throws -> Row? {
  var best: Candidate?
  for c in try candidates(rows, reader, ctx, id) {
    let order = best.map { rank(c, $0) } ?? 1
    // Equal rows are an author mistake that `fact-kit check` reports. The canonical text keeps the result stable.
    if order > 0 {
      best = c
    } else if order == 0, let current = best,
      compareUTF16(JSONValue.object(c.row.asObject).serialized(sortKeys: true), JSONValue.object(current.row.asObject).serialized(sortKeys: true)) < 0
    {
      best = c
    }
  }
  return best?.row
}

/// Checks the top of an index and returns its facts. Throws `notAnIndex` or `unsupportedIndexFormat`.
private func assertIndex(_ index: JSONValue) throws -> [JSONValue] {
  guard case .object(let top) = index else { throw FactReadError.notAnIndex("the index is not a fact index") }
  // A missing field is format 1.0. Readers take any 1.x and ignore fields they do not know.
  let format = top["indexFormat"] ?? .string("1.0")
  guard case .string(let text) = format, let major = majorOf(text), major == "1" else {
    throw FactReadError.unsupportedIndexFormat("the index has index format \(format), and this reader takes 1.x")
  }
  guard case .array(let facts)? = top["facts"], case .string? = top["package"] else {
    throw FactReadError.notAnIndex("the index is not a fact index")
  }
  return facts
}

/// The major of `<digits>.<digits>` without leading zeros, or nil for any other text.
private func majorOf(_ text: String) -> String? {
  let parts = text.utf8.split(separator: UInt8(ascii: "."), omittingEmptySubsequences: false)
  guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } }) else { return nil }
  let major = String(decoding: parts[0], as: UTF8.self)
  let trimmed = major.drop(while: { $0 == "0" })
  return trimmed.isEmpty ? "0" : String(trimmed)
}

private func readerOf(_ version: String?) throws -> Reader {
  guard let version else { return .latest }
  if version == "head" { return .head }
  return .version(try mustParse(version, "query version"))
}

/// The newest released version any row of the index names, which is how new a reader of `latest` is.
private func newestReleased(_ facts: [JSONValue]) -> SemanticVersion? {
  var newest: SemanticVersion?
  for case .object(let fact) in facts {
    for row in rowsOf(fact) {
      guard row.pending == nil, let since = row.since else { continue }
      let items: [JSONValue]
      if case .array(let a) = since { items = a } else { items = [since] }
      for item in items {
        guard case .string(let s) = item, s != "next", let v = parseVersion(s) else { continue }
        if newest == nil || compareSemver(v, newest!) > 0 { newest = v }
      }
    }
  }
  return newest
}

private func removed(_ fact: JSONObject, _ reader: Reader, _ latest: SemanticVersion?) -> Bool {
  guard case .object(let when)? = fact["when"], case .string(let at)? = when["removeIn"] else { return false }
  if case .head = reader { return true }
  if at == "next" { return false }
  guard let gone = parseVersion(at) else { return false }
  let current: SemanticVersion?
  if case .version(let v) = reader { current = v } else { current = latest }
  guard let current else { return false }
  return compareSemver(current, gone) >= 0
}

func selectFacts(parsed index: JSONValue, version: String?, include: [String], platform: String?, os: String?) throws -> [SelectedFact] {
  let facts = try assertIndex(index)
  let reader = try readerOf(version)
  let ctx = Context(include: include, platform: platform, os: os)
  var latest: SemanticVersion?
  if case .latest = reader { latest = newestReleased(facts) }
  var out: [SelectedFact] = []
  for item in facts {
    guard case .object(let fact) = item, case .string(let id)? = fact["id"] else { continue }
    guard let row = try chooseRow(rowsOf(fact), reader, ctx, id), !removed(fact, reader, latest) else { continue }
    var fields = JSONObject()
    for (key, value) in fact.pairs where key != "variants" { fields[key] = value }
    let content = row.content ?? .null
    let since = row.since ?? .string(noSince)
    var stability: String?
    if case .string(let s)? = row.stability { stability = s }
    fields["content"] = content
    fields["since"] = since
    if let stability { fields["stability"] = .string(stability) }
    out.append(SelectedFact(id: id, content: content, since: since, stability: stability, fields: fields))
  }
  return out
}

/// The facts one reader sees. A pure function over the bytes of an `index.json` of format 1.0 or 1.1.
///
/// Each fact has rows (`variants`, or the whole fact as one row). A row applies to the reader when its `since`
/// has been reached, its `pending` label is included, and its `platforms` and `os` conditions list the reader's
/// platform and os. Of the rows that apply the one with the largest bound wins, and on a tie the one with more
/// conditions. A fact without an applying row, or whose `removeIn` has been reached, is left out.
/// The result keeps the order of the index.
///
/// - Parameters:
///   - version: the version of the described component the reader runs, `"head"` for the unreleased state,
///     or nil for the latest published facts.
///   - include: labels of `pending` rows a reader on `head` also gets.
///   - platform: a row with a `platforms` condition applies only when it lists this platform.
///   - os: a row with an `os` condition applies only when it lists this os.
/// - Throws: `FactReadError`.
public func selectFacts(
  _ index: Data,
  version: String? = nil,
  include: [String] = [],
  platform: String? = nil,
  os: String? = nil
) throws -> [SelectedFact] {
  try selectFacts(parsed: JSONValue.parse(index), version: version, include: include, platform: platform, os: os)
}
