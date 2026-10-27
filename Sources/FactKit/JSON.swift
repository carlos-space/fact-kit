import Foundation

/// A JSON object that keeps the order of its keys. A repeated key keeps the last value at the position
/// of its first appearance, as `JSON.parse` does.
public struct JSONObject: Sendable {
  public private(set) var keys: [String] = []
  private var storage: [[UInt8]: JSONValue] = [:]

  public init() {}

  public init(_ pairs: [(String, JSONValue)]) {
    for (key, value) in pairs { self[key] = value }
  }

  public var count: Int { keys.count }

  /// Sets or reads one key. Keys are told apart by their Unicode scalars, not by canonical equivalence.
  public subscript(key: String) -> JSONValue? {
    get { storage[Array(key.utf8)] }
    set {
      let id = Array(key.utf8)
      if let newValue {
        if storage.updateValue(newValue, forKey: id) == nil { keys.append(key) }
      } else if storage.removeValue(forKey: id) != nil {
        keys.removeAll { Array($0.utf8) == id }
      }
    }
  }

  public var pairs: [(key: String, value: JSONValue)] { keys.map { ($0, self[$0] ?? .null) } }
}

/// A parsed JSON value. Numbers are IEEE doubles, as in JavaScript.
public enum JSONValue: Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object(JSONObject)

  public var stringValue: String? { if case .string(let s) = self { s } else { nil } }
  public var arrayValue: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
  public var objectValue: JSONObject? { if case .object(let o) = self { o } else { nil } }
  public var numberValue: Double? { if case .number(let n) = self { n } else { nil } }
  public var boolValue: Bool? { if case .bool(let b) = self { b } else { nil } }

  /// Parses strict JSON (RFC 8259, no comments, no trailing commas, no BOM).
  /// Throws `FactReadError.notAnIndex` when the text is not JSON.
  public static func parse(_ data: Data) throws -> JSONValue {
    var parser = JSONParser(bytes: [UInt8](data))
    return try parser.parseDocument()
  }

  /// The compact JSON text. With `sortKeys`, object keys are in UTF-16 code unit order, which is the
  /// canonical form that breaks ties between rows.
  public func serialized(sortKeys: Bool = false) -> String {
    var out = ""
    write(to: &out, sortKeys: sortKeys)
    return out
  }

  private func write(to out: inout String, sortKeys: Bool) {
    switch self {
    case .null: out += "null"
    case .bool(let b): out += b ? "true" : "false"
    case .number(let n): out += JSONValue.format(n)
    case .string(let s): JSONValue.writeString(s, to: &out)
    case .array(let items):
      out += "["
      for (i, item) in items.enumerated() {
        if i > 0 { out += "," }
        item.write(to: &out, sortKeys: sortKeys)
      }
      out += "]"
    case .object(let object):
      var pairs = object.pairs
      if sortKeys { pairs.sort { compareUTF16($0.key, $1.key) < 0 } }
      out += "{"
      for (i, pair) in pairs.enumerated() {
        if i > 0 { out += "," }
        JSONValue.writeString(pair.key, to: &out)
        out += ":"
        pair.value.write(to: &out, sortKeys: sortKeys)
      }
      out += "}"
    }
  }

  private static func format(_ n: Double) -> String {
    if !n.isFinite { return "null" }
    if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
    return "\(n)"
  }

  private static func writeString(_ s: String, to out: inout String) {
    out += "\""
    for scalar in s.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      default:
        if scalar.value < 0x20 {
          out += "\\u" + String(repeating: "0", count: 4 - String(scalar.value, radix: 16).count) + String(scalar.value, radix: 16)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }
}

/// Compares two strings by UTF-16 code units, the order JavaScript's `<` uses. Returns -1, 0 or 1.
func compareUTF16(_ a: String, _ b: String) -> Int {
  var x = a.utf16.makeIterator()
  var y = b.utf16.makeIterator()
  while true {
    switch (x.next(), y.next()) {
    case (nil, nil): return 0
    case (nil, _): return -1
    case (_, nil): return 1
    case (let p?, let q?):
      if p != q { return p < q ? -1 : 1 }
    }
  }
}

/// Equality with the meaning it has in JavaScript: numbers are equal when their values are, a boolean never
/// equals a number, and the order of object keys does not matter.
extension JSONValue: Equatable {
  public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
    switch (lhs, rhs) {
    case (.null, .null): true
    case (.bool(let a), .bool(let b)): a == b
    case (.number(let a), .number(let b)): a == b
    case (.string(let a), .string(let b)): Array(a.unicodeScalars) == Array(b.unicodeScalars)
    case (.array(let a), .array(let b)): a == b
    case (.object(let a), .object(let b)):
      a.count == b.count && a.keys.allSatisfy { key in
        if let x = a[key], let y = b[key] { x == y } else { false }
      }
    default: false
    }
  }
}

extension JSONValue: CustomStringConvertible {
  public var description: String { serialized() }
}

// MARK: - Parser

private struct JSONParser {
  let bytes: [UInt8]
  var pos = 0
  var depth = 0
  static let maxDepth = 512

  init(bytes: [UInt8]) { self.bytes = bytes }

  private func fail(_ what: String) -> FactReadError {
    .notAnIndex("not JSON: \(what) at byte \(pos)")
  }

  mutating func parseDocument() throws -> JSONValue {
    skipSpace()
    let value = try parseValue()
    skipSpace()
    if pos != bytes.count { throw fail("unexpected content after the value") }
    return value
  }

  private mutating func skipSpace() {
    while pos < bytes.count, bytes[pos] == 0x20 || bytes[pos] == 0x09 || bytes[pos] == 0x0A || bytes[pos] == 0x0D {
      pos += 1
    }
  }

  private mutating func parseValue() throws -> JSONValue {
    guard pos < bytes.count else { throw fail("unexpected end") }
    switch bytes[pos] {
    case UInt8(ascii: "{"): return try parseObject()
    case UInt8(ascii: "["): return try parseArray()
    case UInt8(ascii: "\""): return .string(try parseString())
    case UInt8(ascii: "t"): try expect("true"); return .bool(true)
    case UInt8(ascii: "f"): try expect("false"); return .bool(false)
    case UInt8(ascii: "n"): try expect("null"); return .null
    case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try parseNumber()
    default: throw fail("unexpected character")
    }
  }

  private mutating func expect(_ word: StaticString) throws {
    let n = word.utf8CodeUnitCount
    guard pos + n <= bytes.count else { throw fail("unexpected end") }
    let matches = word.withUTF8Buffer { buffer in
      (0..<n).allSatisfy { bytes[pos + $0] == buffer[$0] }
    }
    if !matches { throw fail("unexpected character") }
    pos += n
  }

  private mutating func parseNumber() throws -> JSONValue {
    let start = pos
    func digit(_ i: Int) -> Bool { i < bytes.count && bytes[i] >= 0x30 && bytes[i] <= 0x39 }
    if bytes[pos] == UInt8(ascii: "-") { pos += 1 }
    guard digit(pos) else { throw fail("a number needs digits") }
    if bytes[pos] == UInt8(ascii: "0") {
      pos += 1
    } else {
      while digit(pos) { pos += 1 }
    }
    if pos < bytes.count, bytes[pos] == UInt8(ascii: ".") {
      pos += 1
      guard digit(pos) else { throw fail("a fraction needs digits") }
      while digit(pos) { pos += 1 }
    }
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "e") || bytes[pos] == UInt8(ascii: "E") {
      pos += 1
      if pos < bytes.count, bytes[pos] == UInt8(ascii: "+") || bytes[pos] == UInt8(ascii: "-") { pos += 1 }
      guard digit(pos) else { throw fail("an exponent needs digits") }
      while digit(pos) { pos += 1 }
    }
    let text = String(decoding: bytes[start..<pos], as: UTF8.self)
    guard let value = Double(text) else { throw fail("bad number") }
    return .number(value)
  }

  private mutating func hex4() throws -> UInt32 {
    guard pos + 4 <= bytes.count else { throw fail("bad \\u escape") }
    var value: UInt32 = 0
    for _ in 0..<4 {
      let c = bytes[pos]
      let d: UInt32
      switch c {
      case 0x30...0x39: d = UInt32(c - 0x30)
      case 0x41...0x46: d = UInt32(c - 0x41 + 10)
      case 0x61...0x66: d = UInt32(c - 0x61 + 10)
      default: throw fail("bad \\u escape")
      }
      value = value << 4 | d
      pos += 1
    }
    return value
  }

  private mutating func parseString() throws -> String {
    pos += 1  // opening quote
    var raw: [UInt8] = []
    var out = String.UnicodeScalarView()
    func flush() {
      if !raw.isEmpty {
        out.append(contentsOf: String(decoding: raw, as: UTF8.self).unicodeScalars)
        raw.removeAll(keepingCapacity: true)
      }
    }
    while true {
      guard pos < bytes.count else { throw fail("unterminated string") }
      let c = bytes[pos]
      switch c {
      case UInt8(ascii: "\""):
        pos += 1
        flush()
        return String(out)
      case 0x00..<0x20:
        throw fail("control character in a string")
      case UInt8(ascii: "\\"):
        flush()
        pos += 1
        guard pos < bytes.count else { throw fail("unterminated string") }
        let e = bytes[pos]
        pos += 1
        switch e {
        case UInt8(ascii: "\""): out.append("\"")
        case UInt8(ascii: "\\"): out.append("\\")
        case UInt8(ascii: "/"): out.append("/")
        case UInt8(ascii: "b"): out.append("\u{08}")
        case UInt8(ascii: "f"): out.append("\u{0C}")
        case UInt8(ascii: "n"): out.append("\n")
        case UInt8(ascii: "r"): out.append("\r")
        case UInt8(ascii: "t"): out.append("\t")
        case UInt8(ascii: "u"):
          let unit = try hex4()
          if (0xD800...0xDBFF).contains(unit) {
            // A high surrogate needs a low one right after it. Otherwise it is a lone surrogate.
            if pos + 6 <= bytes.count, bytes[pos] == UInt8(ascii: "\\"), bytes[pos + 1] == UInt8(ascii: "u") {
              let save = pos
              pos += 2
              let low = try hex4()
              if (0xDC00...0xDFFF).contains(low) {
                let scalar = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                out.append(Unicode.Scalar(scalar) ?? "\u{FFFD}")
              } else {
                pos = save
                out.append("\u{FFFD}")
              }
            } else {
              out.append("\u{FFFD}")
            }
          } else if (0xDC00...0xDFFF).contains(unit) {
            out.append("\u{FFFD}")
          } else {
            out.append(Unicode.Scalar(unit) ?? "\u{FFFD}")
          }
        default:
          throw fail("bad escape")
        }
      default:
        raw.append(c)
        pos += 1
      }
    }
  }

  private mutating func parseArray() throws -> JSONValue {
    depth += 1
    defer { depth -= 1 }
    if depth > Self.maxDepth { throw fail("nested too deep") }
    pos += 1
    var items: [JSONValue] = []
    skipSpace()
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "]") {
      pos += 1
      return .array(items)
    }
    while true {
      skipSpace()
      items.append(try parseValue())
      skipSpace()
      guard pos < bytes.count else { throw fail("unterminated array") }
      if bytes[pos] == UInt8(ascii: ",") {
        pos += 1
      } else if bytes[pos] == UInt8(ascii: "]") {
        pos += 1
        return .array(items)
      } else {
        throw fail("expected , or ]")
      }
    }
  }

  private mutating func parseObject() throws -> JSONValue {
    depth += 1
    defer { depth -= 1 }
    if depth > Self.maxDepth { throw fail("nested too deep") }
    pos += 1
    var object = JSONObject()
    skipSpace()
    if pos < bytes.count, bytes[pos] == UInt8(ascii: "}") {
      pos += 1
      return .object(object)
    }
    while true {
      skipSpace()
      guard pos < bytes.count, bytes[pos] == UInt8(ascii: "\"") else { throw fail("expected a key") }
      let key = try parseString()
      skipSpace()
      guard pos < bytes.count, bytes[pos] == UInt8(ascii: ":") else { throw fail("expected :") }
      pos += 1
      skipSpace()
      object[key] = try parseValue()
      skipSpace()
      guard pos < bytes.count else { throw fail("unterminated object") }
      if bytes[pos] == UInt8(ascii: ",") {
        pos += 1
      } else if bytes[pos] == UInt8(ascii: "}") {
        pos += 1
        return .object(object)
      } else {
        throw fail("expected , or }")
      }
    }
  }
}
