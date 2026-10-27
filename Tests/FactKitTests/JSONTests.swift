import FactKit
import Foundation
import Testing

@Suite("JSON parser")
struct JSONTests {
  private func parse(_ text: String) throws -> JSONValue { try JSONValue.parse(Data(text.utf8)) }

  @Test func keepsKeyOrderAndLastDuplicate() throws {
    let value = try parse(#"{"b":1,"a":2,"b":3}"#)
    let object = try #require(value.objectValue)
    #expect(object.keys == ["b", "a"])
    #expect(object["b"] == .number(3))
  }

  @Test func readsSurrogatePairs() throws {
    #expect(try parse(#""\ud83d\ude00""#) == .string("😀"))
    #expect(try parse(#""\ud83d""#) == .string("\u{FFFD}"))
    #expect(try parse(#""\ude00x""#) == .string("\u{FFFD}x"))
  }

  @Test func equalityFollowsJavaScript() throws {
    #expect(try parse("1") == parse("1.0"))
    #expect(try parse("true") != parse("1"))
    #expect(try parse(#"{"a":1,"b":2}"#) == parse(#"{"b":2,"a":1}"#))
    #expect(try parse("[1,2]") != parse("[2,1]"))
  }

  @Test(arguments: ["", "{", "[1,]", "{\"a\":1,}", "01", "1.", "-", "\"a\nb\"", "'a'", "nul", "[1] x", "\u{FEFF}{}", "\"\\x\"", "\"\\u12\"", "NaN"])
  func rejects(_ text: String) {
    #expect(throws: FactReadError.self) { try parse(text) }
  }

  @Test func errorCodes() {
    #expect(FactReadError.notAnIndex("").code == "not-an-index")
    #expect(FactReadError.unsupportedIndexFormat("").code == "unsupported-index-format")
    #expect(FactReadError.notFound("").code == "not-found")
    #expect(FactReadError.invalidVersion("").code == "invalid-version")
  }
}
