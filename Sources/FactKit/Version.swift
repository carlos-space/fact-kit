import SemanticVersion

/// Parses a semver 2.0.0 version, or returns nil. The package accepts a leading `v`, so it is refused here.
/// Build metadata is accepted and ignored by `compareVersions`.
func parseVersion(_ text: String) -> SemanticVersion? {
  guard let first = text.utf8.first, first >= 0x30, first <= 0x39 else { return nil }
  return SemanticVersion(text)
}

func mustParse(_ value: JSONValue, _ what: String) throws -> SemanticVersion {
  guard case .string(let text) = value, let version = parseVersion(text) else {
    throw FactReadError.invalidVersion("\(what) \(value) is not a semver 2.0.0 version")
  }
  return version
}

func mustParse(_ text: String, _ what: String) throws -> SemanticVersion {
  try mustParse(.string(text), what)
}

/// Semver 2.0.0 precedence. `==` of the package compares build metadata, so `<` and `>` decide.
func compareSemver(_ a: SemanticVersion, _ b: SemanticVersion) -> Int {
  if a < b { return -1 }
  if a > b { return 1 }
  return 0
}

/// Compares the release lines `X.Y` of two versions.
func compareLines(_ a: SemanticVersion, _ b: SemanticVersion) -> Int {
  if a.major != b.major { return a.major < b.major ? -1 : 1 }
  if a.minor != b.minor { return a.minor < b.minor ? -1 : 1 }
  return 0
}

/// Compares two version strings with semver 2.0.0 precedence. Throws `FactReadError.invalidVersion`
/// when one is not a full `X.Y.Z` version.
public func compareVersions(_ a: String, _ b: String) throws -> Int {
  compareSemver(try mustParse(a, "version"), try mustParse(b, "version"))
}

/// The release line `X.Y` of a version, for example `0.49` for `0.49.0-alpha.1`.
public func releaseLine(_ version: String) throws -> String {
  let v = try mustParse(version, "version")
  return "\(v.major).\(v.minor)"
}
