import FactKit
import Foundation

// Consumer harness for the Swift reader: runs the shared samples of conformance/ against the FactKit package that
// SwiftPM resolved, through its public API only. run.sh writes the Package.swift that names the package (a
// registry-less git version, or a local copy by path) and prints where SwiftPM got it from.
// FACT_KIT_CONFORMANCE names the conformance/ directory.

guard let path = ProcessInfo.processInfo.environment["FACT_KIT_CONFORMANCE"], !path.isEmpty else {
  FileHandle.standardError.write(Data("FACT_KIT_CONFORMANCE is not set\n".utf8))
  exit(1)
}
let root = URL(fileURLWithPath: path, isDirectory: true)
nonisolated(unsafe) var failures: [String] = []

func readJSON(_ url: URL) throws -> JSONValue { try JSONValue.parse(Data(contentsOf: url)) }

func subdirectories(_ name: String) -> [String] {
  let url = root.appendingPathComponent(name, isDirectory: true)
  let entries = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
  return entries.filter { entry in
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.appendingPathComponent(entry).path, isDirectory: &isDir)
      && isDir.boolValue
  }.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
}

/// What a reader returns in the shape of `expected.json`, or the code of the error it threw.
func outcome(_ run: () throws -> [SelectedFact]) throws -> JSONValue {
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

func option(_ query: JSONValue, _ key: String) -> String? { query.objectValue?[key]?.stringValue }
func include(_ query: JSONValue) -> [String] {
  (query.objectValue?["include"]?.arrayValue ?? []).compactMap(\.stringValue)
}

func check(_ name: String, _ got: JSONValue, _ expected: JSONValue) {
  if got != expected { failures.append("\(name)\n  got      \(got)\n  expected \(expected)") }
}

let cases = subdirectories("cases")
for name in cases {
  let directory = root.appendingPathComponent("cases/\(name)")
  let query = try readJSON(directory.appendingPathComponent("query.json"))
  let index = try Data(contentsOf: directory.appendingPathComponent("index.json"))
  let got = try outcome {
    try selectFacts(
      index, version: option(query, "version"), include: include(query), platform: option(query, "platform"),
      os: option(query, "os"))
  }
  check("cases/\(name)", got, try readJSON(directory.appendingPathComponent("expected.json")))
}

let resolves = subdirectories("resolve")
for name in resolves {
  let directory = root.appendingPathComponent("resolve/\(name)")
  let query = try readJSON(directory.appendingPathComponent("query.json"))
  let spec = option(query, "spec") ?? ""
  let got = try outcome {
    try readFacts(
      spec, root: directory.appendingPathComponent("root", isDirectory: true), version: option(query, "version"),
      include: include(query), platform: option(query, "platform"), os: option(query, "os")
    ).facts
  }
  check("resolve/\(name)", got, try readJSON(directory.appendingPathComponent("expected.json")))
}

var compares = 0
var lines = 0
if case .array(let entries) = try readJSON(root.appendingPathComponent("semver.json")) {
  for entry in entries {
    guard let o = entry.objectValue else { continue }
    if let a = o["a"]?.stringValue, let b = o["b"]?.stringValue, let expected = o["expected"]?.numberValue {
      compares += 1
      let got = (try? compareVersions(a, b)).map { JSONValue.number(Double($0)) } ?? .string("error")
      check("semver/\(a) vs \(b)", got, .number(expected))
    } else if let version = o["version"]?.stringValue, let line = o["line"]?.stringValue {
      lines += 1
      check("semver/line \(version)", .string((try? releaseLine(version)) ?? "error"), .string(line))
    }
  }
}

// a harness that read nothing proves nothing
if cases.count < 80 || resolves.count < 15 || compares <= 50 || lines <= 5 {
  failures.append(
    "too few samples in \(root.path): \(cases.count) cases, \(resolves.count) resolve, \(compares) compares, \(lines) lines")
}

print("conformance: \(root.path)")
print("samples: \(cases.count) cases, \(resolves.count) resolve, \(compares) version comparisons, \(lines) release lines")
if failures.isEmpty {
  print("ok: every sample matches expected.json")
} else {
  FileHandle.standardError.write(Data("FAILED: \(failures.count)\n\(failures.joined(separator: "\n"))\n".utf8))
  exit(1)
}
