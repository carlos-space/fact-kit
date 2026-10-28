import Foundation

/// Finds `<package>/<path>/index.json` the way Node's `require.resolve` does, starting at `root`.
/// Every failure is `FactReadError.notFound`.
enum Resolver {
  static let conditions: Set<String> = ["node-addons", "node", "require", "module-sync", "default"]

  /// Splits `@scope/name/path/to/entry` or `name/path` into the package name and the sub-path.
  static func split(_ spec: String) throws -> (name: String, entry: String) {
    let parts = spec.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    let nameLength = spec.hasPrefix("@") ? 2 : 1
    if parts.count < nameLength || parts.contains(where: \.isEmpty) {
      throw FactReadError.notFound("readFacts: \"\(spec)\" is not of the form \"<package>\" or \"<package>/<path>\"")
    }
    let name = parts.prefix(nameLength).joined(separator: "/")
    let entry = parts.dropFirst(nameLength).joined(separator: "/")
    // Node does not read these as a package name, and a `.` or `..` segment would leave the package.
    let bad = name.hasPrefix(".") || parts.contains { $0 == "." || $0 == ".." }
      || name.contains("\\") || name.contains("%")
    if bad { throw FactReadError.notFound("readFacts: \"\(spec)\" is not a valid package spec") }
    return (name, entry)
  }

  /// The `index.json` of the spec as installed under `root`. Returns the file and the package directory.
  static func resolve(spec: String, root: URL) throws -> (file: URL, packageDir: URL) {
    let (name, entry) = try split(spec)
    let subpath = "./" + (entry.isEmpty ? "" : entry + "/") + "index.json"
    let fm = FileManager.default
    let start = root.standardizedFileURL

    // 1. Self-reference: the nearest package.json, when it has this name and an `exports`.
    var dir = start
    while true {
      if dir.lastPathComponent == "node_modules" { break }
      let manifest = dir.appendingPathComponent("package.json")
      if fm.fileExists(atPath: manifest.path) {
        let json = try readManifest(manifest)
        if case .string(let own)? = json["name"], own == name, let exports = json["exports"], exports != .null {
          return (try finish(exports, subpath, dir), dir)
        }
        break
      }
      let parent = dir.deletingLastPathComponent()
      if dir.path == "/" || parent.path == dir.path { break }
      dir = parent
    }

    // 2. The nearest directory that has node_modules/<package>.
    dir = start
    while true {
      if dir.lastPathComponent != "node_modules" {
        let candidate = name.split(separator: "/").reduce(dir.appendingPathComponent("node_modules")) {
          $0.appendingPathComponent(String($1))
        }
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: candidate.path, isDirectory: &isDir), isDir.boolValue {
          // 3. A symbolic link stands for the directory it points to.
          let real = candidate.resolvingSymlinksInPath()
          let manifest = real.appendingPathComponent("package.json")
          if fm.fileExists(atPath: manifest.path) {
            let json = try readManifest(manifest)
            if let exports = json["exports"], exports != .null {
              return (try finish(exports, subpath, real), real)
            }
          }
          // 4. Without `exports` the path is a file path. When the file is not there, Node goes on to the
          // next node_modules up.
          let file = entry.split(separator: "/").reduce(real) { $0.appendingPathComponent(String($1)) }
            .appendingPathComponent("index.json")
          if let found = try? existing(file) { return (found, real) }
        }
      }
      let parent = dir.deletingLastPathComponent()
      if dir.path == "/" || parent.path == dir.path { break }
      dir = parent
    }
    throw FactReadError.notFound("readFacts: cannot find \(name) from \(root.path). Install it there.")
  }

  private static func readManifest(_ url: URL) throws -> JSONObject {
    guard let data = try? Data(contentsOf: url), case .object(let o)? = try? JSONValue.parse(data) else {
      throw FactReadError.notFound("readFacts: \(url.path) is not a readable package.json")
    }
    return o
  }

  private static func existing(_ file: URL) throws -> URL {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else {
      throw FactReadError.notFound("readFacts: \(file.path) does not exist")
    }
    return file
  }

  private static func finish(_ exports: JSONValue, _ subpath: String, _ packageDir: URL) throws -> URL {
    guard let target = try resolveExports(exports, subpath) else {
      throw FactReadError.notFound("readFacts: the package does not export \"\(subpath)\"")
    }
    let file = target.dropFirst(2).split(separator: "/").reduce(packageDir) { $0.appendingPathComponent(String($1)) }
    return try existing(file.resolvingSymlinksInPath())
  }

  // MARK: exports

  private struct InvalidTarget: Error {}

  /// The result of a target: a path, undefined (nothing matched), or null.
  private enum Resolved {
    case path(String)
    case undefined
    case null
  }

  /// Node's `packageExportsResolve`. Returns the target path (starting `./`), or nil when nothing is exported.
  static func resolveExports(_ exports: JSONValue, _ subpath: String) throws -> String? {
    var map: JSONObject
    switch exports {
    case .string, .array:
      map = JSONObject([(".", exports)])
    case .object(let o):
      let kinds = Set(o.keys.map { $0.isEmpty || !$0.hasPrefix(".") })
      if kinds.count > 1 { throw FactReadError.notFound("readFacts: exports mixes conditions and paths") }
      map = kinds == [true] ? JSONObject([(".", exports)]) : o
    default:
      return nil
    }
    do {
      if let target = map[subpath], !subpath.contains("*"), !subpath.hasSuffix("/") {
        return path(try resolveTarget(target, match: nil))
      }
      var best = ""
      var bestMatch = ""
      for key in map.keys {
        guard let star = key.firstIndex(of: "*"), key.lastIndex(of: "*") == star else { continue }
        let base = String(key[..<star])
        let trailer = String(key[key.index(after: star)...])
        guard subpath.hasPrefix(base), subpath.utf16.count >= key.utf16.count, subpath.hasSuffix(trailer) else { continue }
        if patternKeyCompare(best, key) == 1 {
          best = key
          bestMatch = String(subpath.dropFirst(base.count).dropLast(trailer.count))
        }
      }
      guard !best.isEmpty, let target = map[best] else { return nil }
      return path(try resolveTarget(target, match: bestMatch))
    } catch is InvalidTarget {
      throw FactReadError.notFound("readFacts: the exports target is not valid")
    }
  }

  private static func path(_ r: Resolved) -> String? {
    if case .path(let p) = r { p } else { nil }
  }

  private static func patternKeyCompare(_ a: String, _ b: String) -> Int {
    let ai = a.firstIndex(of: "*").map { a.distance(from: a.startIndex, to: $0) }
    let bi = b.firstIndex(of: "*").map { b.distance(from: b.startIndex, to: $0) }
    let baseA = ai.map { $0 + 1 } ?? a.count
    let baseB = bi.map { $0 + 1 } ?? b.count
    if baseA > baseB { return -1 }
    if baseB > baseA { return 1 }
    if ai == nil { return 1 }
    if bi == nil { return -1 }
    if a.count > b.count { return -1 }
    if b.count > a.count { return 1 }
    return 0
  }

  /// Segments that make a target invalid: `.`, `..` and `node_modules`, also written with `%` escapes.
  private static func hasInvalidSegment(_ text: String) -> Bool {
    for segment in text.split(whereSeparator: { $0 == "/" || $0 == "\\" }) {
      let lower = segment.lowercased()
      let decoded = lower.replacingOccurrences(of: "%2e", with: ".")
      if decoded == "." || decoded == ".." { return true }
      let word = lower.replacingOccurrences(of: "%6e", with: "n").replacingOccurrences(of: "%6f", with: "o")
        .replacingOccurrences(of: "%64", with: "d").replacingOccurrences(of: "%65", with: "e")
        .replacingOccurrences(of: "%5f", with: "_").replacingOccurrences(of: "%6d", with: "m")
        .replacingOccurrences(of: "%75", with: "u").replacingOccurrences(of: "%6c", with: "l")
        .replacingOccurrences(of: "%73", with: "s")
      if word == "node_modules" { return true }
    }
    return false
  }

  private static func resolveTarget(_ target: JSONValue, match: String?) throws -> Resolved {
    switch target {
    case .string(let s):
      guard s.hasPrefix("./"), !hasInvalidSegment(String(s.dropFirst(2))) else { throw InvalidTarget() }
      if let match {
        if hasInvalidSegment(match) { throw InvalidTarget() }
        return .path(s.replacingOccurrences(of: "*", with: match))
      }
      return .path(s)
    case .array(let items):
      var last: Resolved = .undefined
      for item in items {
        let r: Resolved
        do { r = try resolveTarget(item, match: match) } catch is InvalidTarget { continue }
        switch r {
        case .undefined: continue
        case .null: last = .null
        case .path: return r
        }
      }
      return last
    case .object(let o):
      for (key, value) in o.pairs where key == "default" || conditions.contains(key) {
        let r = try resolveTarget(value, match: match)
        if case .undefined = r { continue }
        return r
      }
      return .undefined
    case .null:
      return .null
    default:
      throw InvalidTarget()
    }
  }
}
