import FactKit
import Foundation
import Testing

// c009: the Swift reader reads the facts about itself, and the error codes in them match the enum.

@Suite("facts about the reader")
struct ReaderFactsTests {
  @Test("fact-kit-swift.read-errors lists the codes of FactReadError")
  func readErrorsMatchEnum() throws {
    let repository = try #require(Conformance.repositoryRoot, "conformance/ not found")
    let reader = try readFacts(
      "fact-kit-facts/fact-kit-swift",
      root: repository.appendingPathComponent("facts", isDirectory: true)
    )
    let value = try reader.value("fact-kit-swift.read-errors")
    let codes = try #require(value.objectValue?["codes"]?.arrayValue)
    let listed = codes.compactMap { $0.objectValue?["code"]?.stringValue }
    let cases: [FactReadError] = [.notAnIndex(""), .unsupportedIndexFormat(""), .notFound(""), .invalidVersion("")]
    #expect(listed.sorted() == cases.map(\.code).sorted())
    #expect(listed.count == codes.count)
  }
}
