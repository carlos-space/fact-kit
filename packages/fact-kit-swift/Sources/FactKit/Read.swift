import Foundation

/// The facts one reader sees, read from an installed fact package.
public struct FactReader: Sendable {
  /// Name of the fact package, from the index.
  public let package: String
  /// Version of the installed fact package, from its `package.json`.
  public let version: String
  /// The sub-path of the entry in the package.
  public let entry: String
  /// The component this entry describes and the version it covers.
  public let describes: [String: String]
  /// The facts this reader sees, each flattened to the row that applies.
  public let facts: [SelectedFact]

  private let byId: [String: SelectedFact]

  init(package: String, version: String, entry: String, describes: [String: String], facts: [SelectedFact]) {
    self.package = package
    self.version = version
    self.entry = entry
    self.describes = describes
    self.facts = facts
    var map: [String: SelectedFact] = [:]
    for fact in facts { map[fact.id] = fact }
    byId = map
  }

  /// Whether a fact with this id exists.
  public func has(_ id: String) -> Bool { byId[id] != nil }

  /// The fact with this id. Throws `FactLookupError.noFact` when there is none, so a typo fails the build
  /// instead of reading nothing.
  public func get(_ id: String) throws -> SelectedFact {
    guard let fact = byId[id] else { throw FactLookupError.noFact(id) }
    return fact
  }

  /// The `content.value` of the fact with this id. Throws `FactLookupError.noValue` when the fact has no value content.
  public func value(_ id: String) throws -> JSONValue {
    let fact = try get(id)
    guard case .object(let content) = fact.content, let value = content["value"] else {
      throw FactLookupError.noValue(id)
    }
    return value
  }
}

/// Reads the built `index.json` of `<package>` or `<package>/<path>` as installed under `root`, so each project
/// gets the version its own lockfile pins. The package is resolved at call time the way Node's `require.resolve`
/// does from `root`. The package must export `./index.json` or `./<path>/index.json`.
///
/// `root` is required. A working directory is not reliable under Xcode and in test hosts.
/// `describes` is not compared with an installed product, and there is no `onRead`.
///
/// - Parameters:
///   - spec: `<package>` or `<package>/<path>`, for example `fact-kit-facts/fact-kit-swift`.
///   - root: the directory the package is resolved from.
///   - version: the version of the described component the reader runs, `"head"`, or nil for the latest published.
///   - include: labels of `pending` rows a `head` reader also gets.
///   - platform: the reader's platform, for rows with a `platforms` condition.
///   - os: the reader's os, for rows with an `os` condition.
/// - Throws: `FactReadError`.
public func readFacts(
  _ spec: String,
  root: URL,
  version: String? = nil,
  include: [String] = [],
  platform: String? = nil,
  os: String? = nil
) throws -> FactReader {
  let (name, entry) = try Resolver.split(spec)
  let (file, packageDir) = try Resolver.resolve(spec: spec, root: root)
  let parsed: JSONValue
  do {
    parsed = try JSONValue.parse(Data(contentsOf: file))
  } catch let error as FactReadError {
    throw FactReadError.notAnIndex("readFacts: \(file.path) is not a fact index (\(error.message))")
  } catch {
    throw FactReadError.notAnIndex("readFacts: \(file.path) can not be read (\(error.localizedDescription))")
  }
  let selected = try selectFacts(parsed: parsed, version: version, include: include, platform: platform, os: os)
  guard case .object(let top) = parsed, case .string(let packageName)? = top["package"] else {
    throw FactReadError.notAnIndex("readFacts: \(file.path) is not a fact index")
  }
  var describes: [String: String] = [:]
  if case .object(let d)? = top["describes"] {
    for (key, value) in d.pairs { if case .string(let s) = value { describes[key] = s } }
  }
  var entryName = entry
  if case .string(let e)? = top["entry"] { entryName = e }
  return FactReader(
    package: packageName,
    version: owningVersion(of: file, named: name, packageDir: packageDir),
    entry: entryName,
    describes: describes,
    facts: selected
  )
}

/// The `package.json` version of the package `name` that contains `file`, found by walking up from it.
private func owningVersion(of file: URL, named name: String, packageDir: URL) -> String {
  var dir = file.deletingLastPathComponent()
  while true {
    let manifest = dir.appendingPathComponent("package.json")
    if let data = try? Data(contentsOf: manifest), case .object(let pkg)? = try? JSONValue.parse(data),
      case .string(let n)? = pkg["name"], n == name
    {
      if case .string(let v)? = pkg["version"] { return v }
      return ""
    }
    let parent = dir.deletingLastPathComponent()
    if parent.path == dir.path { return "" }
    dir = parent
  }
}
