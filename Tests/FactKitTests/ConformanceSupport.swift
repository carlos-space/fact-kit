import FactKit
import Foundation
import Testing

// Support for the conformance tests. It uses the public API only, so the same test body can run against an
// installed copy of the package. `FACT_KIT_CONFORMANCE` names the `conformance/` directory. Without it the
// directory is looked up from this file upwards.

enum Conformance {
  /// The `conformance/` directory, or nil when it can not be found.
  static let directory: URL? = {
    if let path = ProcessInfo.processInfo.environment["FACT_KIT_CONFORMANCE"], !path.isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true)
    }
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while true {
      let candidate = dir.appendingPathComponent("conformance", isDirectory: true)
      if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("semver.json").path) { return candidate }
      let parent = dir.deletingLastPathComponent()
      if parent.path == dir.path { return nil }
      dir = parent
    }
  }()

  /// The root of the repository, the parent of `conformance/`. Its `facts/` holds the fact package.
  static var repositoryRoot: URL? { directory?.deletingLastPathComponent() }

  static func subdirectories(_ name: String) -> [String] {
    guard let directory else { return [] }
    let url = directory.appendingPathComponent(name, isDirectory: true)
    let entries = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
    return entries.filter { entry in
      var isDir: ObjCBool = false
      return FileManager.default.fileExists(atPath: url.appendingPathComponent(entry).path, isDirectory: &isDir)
        && isDir.boolValue
    }.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
  }

  static func readJSON(_ url: URL) throws -> JSONValue {
    try JSONValue.parse(Data(contentsOf: url))
  }

  /// What a reader returns in the shape of `expected.json`, or the code of the error it threw.
  static func outcome(_ run: () throws -> [SelectedFact]) throws -> JSONValue {
    do {
      let facts = try run().sorted { $0.id.utf16.lexicographicallyPrecedes($1.id.utf16) }
      let items: [JSONValue] = facts.map { fact in
        var o = JSONObject()
        o["id"] = .string(fact.id)
        o["content"] = fact.content
        o["since"] = fact.since
        if let stability = fact.stability { o["stability"] = .string(stability) }
        return .object(o)
      }
      return .object(JSONObject([("facts", .array(items))]))
    } catch let error as FactReadError {
      return .object(JSONObject([("error", .string(error.code))]))
    }
  }

  static func option(_ query: JSONValue, _ key: String) -> String? {
    query.objectValue?[key]?.stringValue
  }

  static func include(_ query: JSONValue) -> [String] {
    (query.objectValue?["include"]?.arrayValue ?? []).compactMap(\.stringValue)
  }
}

/// A named directory of `cases/` or `resolve/`. The name is what the test output shows.
struct SampleCase: Sendable, CustomTestStringConvertible {
  let name: String
  var testDescription: String { name }
}

struct SemverCompare: Sendable, CustomTestStringConvertible {
  let a: String
  let b: String
  let expected: Int
  var testDescription: String { "\(a) against \(b) is \(expected)" }
}

struct SemverLine: Sendable, CustomTestStringConvertible {
  let version: String
  let line: String
  var testDescription: String { "\(version) is on line \(line)" }
}

enum SemverSamples {
  static let all: [JSONValue] = {
    guard let directory = Conformance.directory,
      case .array(let items)? = try? Conformance.readJSON(directory.appendingPathComponent("semver.json"))
    else { return [] }
    return items
  }()

  static let compares: [SemverCompare] = all.compactMap { item in
    guard let o = item.objectValue, let a = o["a"]?.stringValue, let b = o["b"]?.stringValue,
      let expected = o["expected"]?.numberValue
    else { return nil }
    return SemverCompare(a: a, b: b, expected: Int(expected))
  }

  static let lines: [SemverLine] = all.compactMap { item in
    guard let o = item.objectValue, let version = o["version"]?.stringValue, let line = o["line"]?.stringValue
    else { return nil }
    return SemverLine(version: version, line: line)
  }
}
