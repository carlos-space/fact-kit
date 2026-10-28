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

  @Test("publish is returned as the index says, and no version is checked")
  func publishIsReturned() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("fact-kit-swift-publish-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let package = root.appendingPathComponent("node_modules/demo-facts")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try Data(#"{"name":"demo-facts","version":"1.0.0","exports":{"./index.json":"./index.json"}}"#.utf8)
      .write(to: package.appendingPathComponent("package.json"))
    func write(_ publish: String) throws {
      let index =
        #"{"indexFormat":"1.2","package":"demo-facts","entry":"","describes":{"demo-component":"0.50.0"}"# + publish
        + #","facts":[]}"#
      try Data(index.utf8).write(to: package.appendingPathComponent("index.json"))
    }
    try write(#","publish":{"target":"npm","name":"demo"}"#)
    #expect(try readFacts("demo-facts", root: root).publish == Publish(target: "npm", name: "demo"))
    try write("")
    #expect(try readFacts("demo-facts", root: root).publish == nil)
  }

  @Test("a root under the temporary directory with no such package throws not-found instead of hanging")
  func walkingUpStopsAtTheRoot() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("fact-kit-swift-top-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(throws: FactReadError.self) { try readFacts("no-such-package-facts-xyz", root: root) }
  }
}
