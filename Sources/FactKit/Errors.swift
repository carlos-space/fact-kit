/// The error a reader throws. `code` is the stable string shared by every language of fact-kit.
/// The message is for people and can change.
public enum FactReadError: Error, Sendable, Equatable {
  case notAnIndex(String)
  case unsupportedIndexFormat(String)
  case notFound(String)
  case invalidVersion(String)

  /// `not-an-index`, `unsupported-index-format`, `not-found` or `invalid-version`.
  public var code: String {
    switch self {
    case .notAnIndex: "not-an-index"
    case .unsupportedIndexFormat: "unsupported-index-format"
    case .notFound: "not-found"
    case .invalidVersion: "invalid-version"
    }
  }

  /// The human-readable message.
  public var message: String {
    switch self {
    case .notAnIndex(let m), .unsupportedIndexFormat(let m), .notFound(let m), .invalidVersion(let m): m
    }
  }
}

extension FactReadError: CustomStringConvertible {
  public var description: String { "\(message) (\(code))" }
}

/// Thrown by `FactReader.get` and `FactReader.value` when the id is unknown or the fact has no `value` content.
/// It is not a `FactReadError`, because the four codes describe reading an index.
public enum FactLookupError: Error, Sendable, Equatable {
  case noFact(String)
  case noValue(String)
}
